import { describe, expect, it } from 'vitest';
import { B } from '../src/shared/blocks/registry';
import { GameMode, PROTOCOL_VERSION } from '../src/shared/constants';
import { InvAction, Inventory } from '../src/shared/items/Inventory';
import { breakTime } from '../src/shared/items/mining';
import { PlayerBody, type MoveInput, type WorldQuery } from '../src/shared/physics/PlayerBody';
import { raycast } from '../src/shared/physics/raycast';
import { packWorldFile, unpackWorldFile } from '../src/shared/world/worldFile';
import { Chunk } from '../src/shared/world/Chunk';
import { encodeChunk } from '../src/shared/world/chunkCodec';
import { computeChunkLight } from '../src/shared/world/lighting';
import { createLocalPair } from '../src/net/LocalTransport';
import { GameServer } from '../src/server/GameServer';
import type { ChunkGenerator } from '../src/server/ServerWorld';
import { newWorldMeta, type ChunkStore, type WorldMeta } from '../src/server/storage/WorldStorage';
import type { ClientMsg, ServerMsg } from '../src/shared/protocol/messages';

describe('inventory', () => {
  it('stacks additions, hotbar first', () => {
    const inv = new Inventory();
    expect(inv.add(B.DIRT, 70)).toBe(0);
    expect(inv.slots[0]).toEqual({ id: B.DIRT, count: 64 });
    expect(inv.slots[1]).toEqual({ id: B.DIRT, count: 6 });
    inv.add(B.STONE, 1);
    expect(inv.slots[2]).toEqual({ id: B.STONE, count: 1 });
  });

  it('picks up, splits, places one and swaps', () => {
    const inv = new Inventory();
    inv.add(B.DIRT, 10);
    inv.apply(InvAction.CLICK, 0, 2, undefined, false); // right click: take half
    expect(inv.cursor).toEqual({ id: B.DIRT, count: 5 });
    expect(inv.slots[0]!.count).toBe(5);
    inv.apply(InvAction.CLICK, 20, 2, undefined, false); // drop one
    expect(inv.slots[20]).toEqual({ id: B.DIRT, count: 1 });
    expect(inv.cursor!.count).toBe(4);
    inv.apply(InvAction.CLICK, 0, 0, undefined, false); // merge back
    expect(inv.slots[0]!.count).toBe(9);
    expect(inv.cursor).toBeNull();
    inv.apply(InvAction.SHIFT_CLICK, 0, 0, undefined, false);
    expect(inv.slots[0]).toBeNull();
    expect(inv.slots[20]!.count).toBe(10);
  });

  it('refuses creative actions in survival and returns the cursor on close', () => {
    const inv = new Inventory();
    expect(inv.apply(InvAction.CREATIVE_SLOT, 0, 0, B.GLASS, false)).toBe(false);
    expect(inv.slots[0]).toBeNull();
    expect(inv.apply(InvAction.CREATIVE_CURSOR, 0, 0, B.GLASS, true)).toBe(true);
    inv.apply(InvAction.CLOSE, 0, 0, undefined, true);
    expect(inv.cursor).toBeNull();
    expect(inv.slots[0]).toEqual({ id: B.GLASS, count: 64 });
  });
});

describe('mining time', () => {
  it('depends on block, tool need and mode', () => {
    expect(breakTime(B.DIRT, undefined, false)).toBeCloseTo(0.75);
    expect(breakTime(B.STONE, undefined, false)).toBeGreaterThan(breakTime(B.DIRT, undefined, false) * 5);
    expect(breakTime(B.STONE, { id: 9000, key: 'p', name: 'p', maxStack: 1, tool: { kind: 'pickaxe', speed: 4 } }, false)).toBeCloseTo(0.5625);
    expect(breakTime(B.COREROCK, undefined, false)).toBe(Infinity);
    expect(breakTime(B.COREROCK, undefined, true)).toBe(0);
  });
});

/** Flat test world: solid for y < 10, optional extra blocks. */
function flatWorld(extra: Array<[number, number, number, number]> = []): WorldQuery & { get(x: number, y: number, z: number): number } {
  const blocks = new Map(extra.map(([x, y, z, id]) => [`${x},${y},${z}`, id]));
  const get = (x: number, y: number, z: number) => blocks.get(`${x},${y},${z}`) ?? (y < 10 ? B.STONE : B.AIR);
  return {
    get,
    isSolid: (x, y, z) => get(x, y, z) === B.STONE,
    isWater: (x, y, z) => get(x, y, z) === B.WATER,
  };
}

const idle: MoveInput = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw: 0 };

function simulate(body: PlayerBody, w: WorldQuery, input: MoveInput, seconds: number): void {
  for (let t = 0; t < seconds; t += 1 / 60) body.step(w, input, 1 / 60);
}

describe('player physics', () => {
  it('falls onto the ground and stays there', () => {
    const w = flatWorld();
    const b = new PlayerBody();
    b.x = 0.5; b.y = 20; b.z = 0.5;
    simulate(b, w, idle, 2);
    expect(b.y).toBeCloseTo(10, 5);
    expect(b.onGround).toBe(true);
  });

  it('jumps over one block but not two', () => {
    const one = flatWorld([[0, 10, -2, B.STONE], [1, 10, -2, B.STONE], [-1, 10, -2, B.STONE]]);
    const b = new PlayerBody();
    b.x = 0.5; b.y = 10; b.z = 0.5;
    simulate(b, one, { ...idle, forward: 1, jump: true }, 1.5);
    expect(b.z).toBeLessThan(-2); // walked north (-z) over the step

    const two = flatWorld([[0, 10, -2, B.STONE], [0, 11, -2, B.STONE]]);
    const c = new PlayerBody();
    c.x = 0.5; c.y = 10; c.z = 0.5;
    simulate(c, two, { ...idle, forward: 1, jump: true }, 1.5);
    expect(c.z).toBeGreaterThan(-1.71); // blocked by the wall
  });

  it('does not walk off an edge while sneaking', () => {
    // Floor only at z >= 0 for y = 9; everything below is air.
    const w: WorldQuery = { isSolid: (_x, y, z) => y === 9 && z >= 0, isWater: () => false };
    const b = new PlayerBody();
    b.x = 0.5; b.y = 10; b.z = 0.5;
    simulate(b, w, { ...idle, forward: 1, sneak: true }, 3);
    expect(b.y).toBe(10);
    expect(b.z).toBeGreaterThan(-0.31);
  });

  it('floats and swims up in water', () => {
    const w: WorldQuery = { isSolid: (_x, y) => y < 0, isWater: (_x, y) => y < 20 };
    const b = new PlayerBody();
    b.x = 0.5; b.y = 10; b.z = 0.5;
    simulate(b, w, { ...idle, jump: true }, 2);
    expect(b.y).toBeGreaterThan(14);
    const sinkStart = b.y;
    simulate(b, w, idle, 1);
    expect(b.y).toBeLessThan(sinkStart);
    expect(sinkStart - b.y).toBeLessThan(3);
  });
});

describe('raycast', () => {
  it('finds the first block and the face it entered through', () => {
    const w = flatWorld();
    const hit = raycast(w.get, (id) => id !== 0, 0.5, 12, 0.5, 0, -1, 0, 5)!;
    expect([hit.x, hit.y, hit.z]).toEqual([0, 9, 0]);
    expect([hit.nx, hit.ny, hit.nz]).toEqual([0, 1, 0]);
    expect(raycast(w.get, (id) => id !== 0, 0.5, 20, 0.5, 0, -1, 0, 5)).toBeNull();
  });
});

describe('world file', () => {
  it('round-trips header and chunks, and rejects garbage', () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([9])];
    const out = unpackWorldFile(packWorldFile({ name: 'עולם', seed: 5 }, chunks));
    expect(out.header).toEqual({ name: 'עולם', seed: 5 });
    expect(out.chunks).toEqual(chunks);
    expect(() => unpackWorldFile(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toThrow();
  });
});

// --- Host validation --------------------------------------------------------

function flatChunk(cx: number, cz: number): Chunk {
  const c = new Chunk(cx, cz);
  for (let i = 0; i < 10 * 256; i++) c.blocks[i] = B.STONE;
  c.recomputeHeights();
  computeChunkLight(c);
  return c;
}

const flatGen: ChunkGenerator = { concurrency: 64, generate: async (cx, cz) => flatChunk(cx, cz) };

function memoryStore(): ChunkStore & { chunks: Map<string, Uint8Array>; meta?: WorldMeta } {
  const chunks = new Map<string, Uint8Array>();
  const store = {
    chunks,
    meta: undefined as WorldMeta | undefined,
    loadChunk: async (cx: number, cz: number) => chunks.get(`${cx},${cz}`),
    saveChunks: async (list: Array<{ cx: number; cz: number; data: Uint8Array }>) => {
      for (const c of list) chunks.set(`${c.cx},${c.cz}`, c.data);
    },
    saveMeta: async (m: WorldMeta) => {
      store.meta = m;
    },
  };
  return store;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function connect(server: GameServer) {
  const [s, c] = createLocalPair<ServerMsg, ClientMsg>();
  const received: ServerMsg[] = [];
  c.onMessage = (m) => received.push(m);
  server.addConnection(s, { host: true });
  c.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'Tester' });
  await flush();
  // Let the server stream (and "generate") nearby chunks.
  for (let i = 0; i < 5; i++) {
    (server as unknown as { tick(): void }).tick();
    await flush();
  }
  return { send: (m: ClientMsg) => c.send(m), received };
}

describe('host validation', () => {
  it('accepts a placement next to the player and rejects one out of reach', async () => {
    const meta = newWorldMeta('t', 1, GameMode.CREATIVE);
    const server = new GameServer({ viewDistance: 2, meta }, flatGen);
    const p = await connect(server);
    const welcome = p.received.find((m) => m.t === 'welcome')!;
    expect(welcome.t === 'welcome' && welcome.gameMode).toBe(GameMode.CREATIVE);
    p.send({ t: 'move', seq: 0, x: 0.5, y: 10, z: 0.5, yaw: 0, pitch: 0, flags: 0 });
    // Creative kit has grass in slot 0.
    p.send({ t: 'place', x: 2, y: 10, z: 0, face: 0, slot: 0 });
    p.send({ t: 'place', x: 30, y: 10, z: 0, face: 0, slot: 0 });
    await flush();
    expect(server.world.getBlock(2, 10, 0)).toBe(B.GRASS);
    expect(server.world.getBlock(30, 10, 0)).toBe(B.AIR);
    // The rejected client gets the true block back.
    expect(p.received.some((m) => m.t === 'blockChange' && m.x === 30 && m.id === B.AIR)).toBe(true);
  });

  it('refuses placing a block inside the player and floating in the air', async () => {
    const server = new GameServer({ viewDistance: 2, meta: newWorldMeta('t', 1, GameMode.CREATIVE) }, flatGen);
    const p = await connect(server);
    p.send({ t: 'move', seq: 0, x: 0.5, y: 10, z: 0.5, yaw: 0, pitch: 0, flags: 0 });
    p.send({ t: 'place', x: 0, y: 10, z: 0, face: 0, slot: 0 });
    p.send({ t: 'place', x: 2, y: 13, z: 2, face: 0, slot: 0 });
    await flush();
    expect(server.world.getBlock(0, 10, 0)).toBe(B.AIR);
    expect(server.world.getBlock(2, 13, 2)).toBe(B.AIR);
  });

  it('enforces dig time in survival and gives the drop', async () => {
    const server = new GameServer({ viewDistance: 2, meta: newWorldMeta('t', 1, GameMode.SURVIVAL) }, flatGen);
    const p = await connect(server);
    p.send({ t: 'move', seq: 0, x: 0.5, y: 10, z: 0.5, yaw: 0, pitch: 0, flags: 0 });
    // Instant "finish" without digging long enough: rejected (stone needs ~7.5 s by hand).
    p.send({ t: 'dig', phase: 0, x: 1, y: 9, z: 0, face: 1 });
    p.send({ t: 'dig', phase: 2, x: 1, y: 9, z: 0, face: 1 });
    await flush();
    expect(server.world.getBlock(1, 9, 0)).toBe(B.STONE);

    // Pretend the dig started long ago.
    p.send({ t: 'dig', phase: 0, x: 1, y: 9, z: 0, face: 1 });
    await flush();
    const session = [...(server as unknown as { players: Map<number, { dig: { start: number } }> }).players.values()][0];
    session.dig.start -= 10_000;
    p.send({ t: 'dig', phase: 2, x: 1, y: 9, z: 0, face: 1 });
    await flush();
    expect(server.world.getBlock(1, 9, 0)).toBe(B.AIR);
    const inv = [...p.received].reverse().find((m) => m.t === 'inventory');
    expect(inv && inv.t === 'inventory' && inv.state.slots[0]).toEqual({ id: B.RUBBLESTONE, count: 1 });
  });

  it('saves changed chunks and players, and loads them back', async () => {
    const store = memoryStore();
    const meta = newWorldMeta('t', 1, GameMode.CREATIVE);
    const server = new GameServer({ viewDistance: 2, meta, store }, flatGen);
    const p = await connect(server);
    p.send({ t: 'move', seq: 0, x: 3.5, y: 10, z: 3.5, yaw: 1, pitch: 0, flags: 0 });
    p.send({ t: 'place', x: 5, y: 10, z: 5, face: 0, slot: 0 });
    await flush();
    await server.stop();
    expect(store.chunks.has('0,0')).toBe(true);
    expect(store.meta!.players.Tester.pos).toEqual([3.5, 10, 3.5]);

    const again = new GameServer({ viewDistance: 2, meta: store.meta!, store }, flatGen);
    const q = await connect(again);
    expect(again.world.getBlock(5, 10, 5)).toBe(B.GRASS);
    const w = q.received.find((m) => m.t === 'welcome');
    expect(w && w.t === 'welcome' && w.spawn).toEqual([3.5, 10, 3.5]);
    expect(encodeChunk(again.world.getChunk(0, 0)!).length).toBeGreaterThan(0);
  });
});
