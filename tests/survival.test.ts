import { describe, expect, it } from 'vitest';
import { B, DOOR_OPEN, DOOR_UPPER, withState } from '../src/shared/blocks/registry';
import { GameMode, PROTOCOL_VERSION } from '../src/shared/constants';
import { craftingResult } from '../src/shared/items/crafting';
import { InvAction, Inventory } from '../src/shared/items/Inventory';
import { blockDrops } from '../src/shared/items/mining';
import { headId, I, itemDef, toolId } from '../src/shared/items/registry';
import { ContainerWindow, emptySlots } from '../src/shared/items/Window';
import { Chunk } from '../src/shared/world/Chunk';
import { decodeChunk, encodeChunk } from '../src/shared/world/chunkCodec';
import { computeChunkLight } from '../src/shared/world/lighting';
import { createLocalPair } from '../src/net/LocalTransport';
import { GameServer } from '../src/server/GameServer';
import type { ChunkGenerator } from '../src/server/ServerWorld';
import { newWorldMeta } from '../src/server/storage/WorldStorage';
import type { ClientMsg, ServerMsg } from '../src/shared/protocol/messages';
import { MoveFlag } from '../src/shared/protocol/messages';

const P = B.ASHWOOD_PLANKS;

describe('crafting recipes', () => {
  it('turns logs into planks and planks into a workbench (2×2)', () => {
    expect(craftingResult([0, B.FROSTPINE_LOG, 0, 0], 2)).toEqual({ id: B.FROSTPINE_PLANKS, count: 4 });
    expect(craftingResult([P, P, P, B.FROSTPINE_PLANKS], 2)).toEqual({ id: B.WORKBENCH, count: 1 });
  });

  it('needs a 3×3 grid for wide recipes and allows mirrored shapes', () => {
    expect(craftingResult([P, P, P, 0, 0, 0, 0, 0, 0], 3)).toEqual({ id: headId(0, 0), count: 1 });
    // Axe head and its mirror image.
    expect(craftingResult([P, P, P, 0], 2)).toEqual({ id: headId(0, 1), count: 1 });
    expect(craftingResult([P, P, 0, P], 2)).toEqual({ id: headId(0, 1), count: 1 });
    expect(craftingResult([I.STICK, headId(2, 0), I.STICK, 0], 2)).toEqual({ id: toolId(2, 0), count: 1 });
    const R = B.RUBBLESTONE;
    expect(craftingResult([R, R, R, R, 0, R, R, R, R], 3)).toEqual({ id: B.FURNACE, count: 1 });
    expect(craftingResult([I.COAL, 0, 0, I.STICK, 0, 0, 0, 0, 0], 3)).toEqual({ id: B.TORCH, count: 4 });
    expect(craftingResult([B.DIRT, 0, 0, 0], 2)).toBeNull();
  });

  it('crafts through a window: output click consumes the grid, shift-click crafts all', () => {
    const inv = new Inventory();
    const w = new ContainerWindow('inventory', inv, emptySlots('inventory'));
    inv.add(B.ASHWOOD_LOG, 3);
    w.apply(InvAction.CLICK, 5, 0); // pick up the logs (inventory slot 0)
    w.apply(InvAction.CLICK, 0, 0); // put them into grid slot 0
    expect(w.get(4)).toEqual({ id: P, count: 4 });
    w.apply(InvAction.CLICK, 4, 0); // take one craft
    expect(inv.cursor).toEqual({ id: P, count: 4 });
    expect(w.get(0)).toEqual({ id: B.ASHWOOD_LOG, count: 2 });
    w.apply(InvAction.SHIFT_CLICK, 4, 0);
    expect(w.get(0)).toBeNull();
    expect(inv.slots.find((s) => s?.id === P)).toEqual({ id: P, count: 8 });
  });
});

describe('drops', () => {
  it('depend on the tool tier', () => {
    const none = () => 0;
    expect(blockDrops(B.STONE, undefined, none)).toEqual([]);
    expect(blockDrops(B.STONE, itemDef(toolId(0, 0)), none)).toEqual([{ id: B.RUBBLESTONE, count: 1 }]);
    expect(blockDrops(B.IRON_ORE, itemDef(toolId(0, 0)), none)).toEqual([]);
    expect(blockDrops(B.IRON_ORE, itemDef(toolId(1, 0)), none)).toEqual([{ id: I.RAW_IRON, count: 1 }]);
    expect(blockDrops(B.DIAMOND_ORE, itemDef(toolId(2, 0)), none)).toEqual([{ id: I.DIAMOND, count: 1 }]);
    expect(blockDrops(B.GRASS, undefined, none)).toEqual([{ id: B.DIRT, count: 1 }]);
    expect(blockDrops(withState(B.ASHWOOD_DOOR, DOOR_UPPER), undefined, none)).toEqual([]);
  });
});

describe('chunk codec v2', () => {
  it('keeps block entities', () => {
    const c = new Chunk(2, -3);
    c.setBlock(1, 1, 1, B.CHEST);
    c.blockEntities.set(1 | (1 << 4) | (1 << 8), { kind: 'chest', slots: [{ id: B.DIRT, count: 5 }, null] });
    const d = decodeChunk(encodeChunk(c));
    expect(d.blockEntities.get(1 | (1 << 4) | (1 << 8))).toEqual({ kind: 'chest', slots: [{ id: B.DIRT, count: 5 }, null] });
  });
});

// --- Host simulation -------------------------------------------------------

function flatChunk(cx: number, cz: number): Chunk {
  const c = new Chunk(cx, cz);
  for (let i = 0; i < 10 * 256; i++) c.blocks[i] = B.STONE;
  c.recomputeHeights();
  computeChunkLight(c);
  return c;
}
const flatGen: ChunkGenerator = { concurrency: 64, generate: async (cx, cz) => flatChunk(cx, cz) };
const flush = () => new Promise((r) => setTimeout(r, 0));

interface Session {
  inventory: Inventory;
  health: number;
  food: number;
  dead: boolean;
  dig: { start: number } | null;
  eating: { start: number } | null;
  window: { id: number } | null;
}

async function setup(mode: number) {
  const server = new GameServer({ viewDistance: 2, meta: newWorldMeta('t', 1, mode) }, flatGen);
  const [s, c] = createLocalPair<ServerMsg, ClientMsg>();
  const received: ServerMsg[] = [];
  c.onMessage = (m) => received.push(m);
  server.addConnection(s, { host: true });
  c.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'T' });
  await flush();
  const tick = async (n = 1) => {
    for (let i = 0; i < n; i++) (server as unknown as { tick(): void }).tick();
    await flush();
  };
  await tick(5);
  const session = [...(server as unknown as { players: Map<number, Session> }).players.values()][0];
  const send = async (m: ClientMsg) => {
    c.send(m);
    await flush();
  };
  const tp = (pos: number[]) => (server as unknown as { teleport(p: Session, pos: number[]): void }).teleport(session, pos);
  tp([0.5, 10, 0.5]);
  await send({ t: 'move', seq: 0, x: 0.5, y: 10, z: 0.5, yaw: 0, pitch: 0, flags: MoveFlag.ON_GROUND });
  return { server, session, received, send, tick, tp };
}

describe('survival on the host', () => {
  it('applies fall damage, kills, drops the inventory and respawns', async () => {
    const { session, received, send, server, tp } = await setup(GameMode.SURVIVAL);
    session.inventory.add(B.DIRT, 10);
    tp([0.5, 30, 0.5]);
    await send({ t: 'move', seq: 1, x: 0.5, y: 30, z: 0.5, yaw: 0, pitch: 0, flags: 0 });
    await send({ t: 'move', seq: 2, x: 0.5, y: 10, z: 0.5, yaw: 0, pitch: 0, flags: MoveFlag.ON_GROUND });
    expect(session.health).toBe(20 - 17);
    expect(received.some((m) => m.t === 'hurt')).toBe(true);
    tp([0.5, 20, 0.5]);
    await send({ t: 'move', seq: 3, x: 0.5, y: 20, z: 0.5, yaw: 0, pitch: 0, flags: 0 });
    await send({ t: 'move', seq: 4, x: 0.5, y: 10, z: 0.5, yaw: 0, pitch: 0, flags: MoveFlag.ON_GROUND });
    expect(session.dead).toBe(true);
    expect(received.some((m) => m.t === 'death')).toBe(true);
    expect(session.inventory.slots.every((s) => s === null)).toBe(true);
    expect([...server.items.all.values()].some((e) => e.item.id === B.DIRT && e.item.count === 10)).toBe(true);
    await send({ t: 'respawn' });
    expect(session.dead).toBe(false);
    expect(session.health).toBe(20);
    expect(received.some((m) => m.t === 'teleport')).toBe(true);
  });

  it('eats food after holding long enough', async () => {
    const { session, send } = await setup(GameMode.SURVIVAL);
    session.food = 10;
    session.inventory.slots[0] = { id: I.ASHFRUIT, count: 2 };
    await send({ t: 'useItem', phase: 0, slot: 0 });
    await send({ t: 'useItem', phase: 2, slot: 0 });
    expect(session.food).toBe(10); // too fast
    await send({ t: 'useItem', phase: 0, slot: 0 });
    session.eating!.start -= 5000;
    await send({ t: 'useItem', phase: 2, slot: 0 });
    expect(session.food).toBe(14);
    expect(session.inventory.slots[0]).toEqual({ id: I.ASHFRUIT, count: 1 });
  });

  it('smelts in a furnace with fuel and lights it up while burning', async () => {
    const { server, session, send, tick } = await setup(GameMode.SURVIVAL);
    server.world.setBlock(2, 10, 0, B.FURNACE);
    await send({ t: 'useBlock', x: 2, y: 10, z: 0 });
    const be = server.blockEntityAt(2, 10, 0);
    expect(be?.kind).toBe('furnace');
    be!.slots[0] = { id: I.RAW_IRON, count: 2 };
    session.inventory.slots[0] = { id: I.COAL, count: 1 };
    // Shift-click the coal from the inventory (window slot 3 + 0) into the fuel slot.
    await send({ t: 'inv', window: session.window!.id, action: InvAction.SHIFT_CLICK, slot: 3, button: 0 });
    expect(be!.slots[1]).toEqual({ id: I.COAL, count: 1 });
    await tick(5);
    expect(server.world.getBlock(2, 10, 0)).toBe(B.FURNACE_LIT);
    await tick(400);
    expect(be!.slots[2]).toEqual({ id: I.IRON_INGOT, count: 2 });
    expect(be!.slots[0]).toBeNull();
  });

  it('places doors in two halves, toggles them, and breaks both', async () => {
    const { server, session, send } = await setup(GameMode.CREATIVE);
    session.inventory.slots[0] = { id: B.ASHWOOD_DOOR, count: 16 };
    await send({ t: 'place', x: 3, y: 10, z: 0, raw: withState(B.ASHWOOD_DOOR, 2), slot: 0 });
    expect(server.world.getRaw(3, 10, 0)).toBe(withState(B.ASHWOOD_DOOR, 2));
    expect(server.world.getRaw(3, 11, 0)).toBe(withState(B.ASHWOOD_DOOR, 2 | DOOR_UPPER));
    await send({ t: 'useBlock', x: 3, y: 11, z: 0 });
    expect(server.world.getRaw(3, 10, 0) >>> 12).toBe(2 | DOOR_OPEN);
    expect(server.world.getRaw(3, 11, 0) >>> 12).toBe(2 | DOOR_OPEN | DOOR_UPPER);
    await send({ t: 'dig', phase: 2, x: 3, y: 10, z: 0, face: 0 });
    expect(server.world.getBlock(3, 10, 0)).toBe(B.AIR);
    expect(server.world.getBlock(3, 11, 0)).toBe(B.AIR);
  });

  it('pops a wall torch when its wall is removed', async () => {
    const { server, session, send } = await setup(GameMode.CREATIVE);
    server.world.setBlock(2, 10, 0, B.STONE);
    session.inventory.slots[0] = { id: B.TORCH, count: 64 };
    // Torch on the -x side of the stone, attached towards +x (state 2).
    await send({ t: 'place', x: 1, y: 10, z: 0, raw: withState(B.TORCH, 2), slot: 0 });
    expect(server.world.getBlock(1, 10, 0)).toBe(B.TORCH);
    await send({ t: 'dig', phase: 2, x: 2, y: 10, z: 0, face: 0 });
    expect(server.world.getBlock(1, 10, 0)).toBe(B.AIR);
  });

  it('spills chest contents when the chest is broken', async () => {
    const { server, send } = await setup(GameMode.CREATIVE);
    server.world.setBlock(2, 10, 0, B.CHEST);
    await send({ t: 'useBlock', x: 2, y: 10, z: 0 });
    server.blockEntityAt(2, 10, 0)!.slots[5] = { id: I.DIAMOND, count: 3 };
    await send({ t: 'dig', phase: 2, x: 2, y: 10, z: 0, face: 0 });
    expect([...server.items.all.values()].some((e) => e.item.id === I.DIAMOND && e.item.count === 3)).toBe(true);
    expect(server.blockEntityAt(2, 10, 0)).toBeUndefined();
  });
});
