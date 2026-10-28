import { describe, expect, it } from 'vitest';
import { B, POWER_ON, PUSHER_EXTENDED, TEXTURE_NAMES, withState } from '../src/shared/blocks/registry';
import { GameMode, PROTOCOL_VERSION } from '../src/shared/constants';
import { craftingResult } from '../src/shared/items/crafting';
import { InvAction, Inventory } from '../src/shared/items/Inventory';
import { breakTime } from '../src/shared/items/mining';
import { I, itemDef, RUNE_ITEMS, toolId } from '../src/shared/items/registry';
import { runeUpgrade } from '../src/shared/items/runes';
import { ContainerWindow, emptySlots } from '../src/shared/items/Window';
import type { ClientMsg, ServerMsg } from '../src/shared/protocol/messages';
import { Chunk } from '../src/shared/world/Chunk';
import { DEEP_CEILING, DEEP_ORIGIN, isDeep } from '../src/shared/world/dimensions';
import { computeChunkLight } from '../src/shared/world/lighting';
import { hasPainter } from '../src/client/textures/procedural';
import { createLocalPair } from '../src/net/LocalTransport';
import { GameServer } from '../src/server/GameServer';
import type { ChunkGenerator } from '../src/server/ServerWorld';
import { newWorldMeta } from '../src/server/storage/WorldStorage';
import { settlementInCell } from '../src/server/worldgen/settlements';
import { WorldGenerator } from '../src/server/worldgen/WorldGenerator';
import { Mob } from '../src/shared/entities/mobs';

function flatChunk(cx: number, cz: number): Chunk {
  const c = new Chunk(cx, cz);
  for (let i = 0; i < 10 * 256; i++) c.blocks[i] = i >= 9 * 256 ? B.GRASS : B.STONE;
  c.recomputeHeights();
  computeChunkLight(c);
  return c;
}
const flatGen: ChunkGenerator = { concurrency: 64, generate: async (cx, cz) => flatChunk(cx, cz) };
const flush = () => new Promise((r) => setTimeout(r, 0));

interface Session {
  pos: number[];
  inventory: Inventory;
  food: number;
}

async function setup(mode: number = GameMode.CREATIVE, seed = 1) {
  const meta = newWorldMeta('s6', seed, mode);
  const server = new GameServer({ viewDistance: 2, meta }, flatGen);
  server.mobSpawning = false;
  const [s, c] = createLocalPair<ServerMsg, ClientMsg>();
  const got: ServerMsg[] = [];
  c.onMessage = (m) => got.push(m);
  server.addConnection(s, { host: true });
  c.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'T' });
  await flush();
  const priv = server as unknown as { tick(): void; players: Map<number, Session>; teleport(p: Session, pos: number[]): void };
  const session = [...priv.players.values()][0];
  priv.teleport(session, [0.5, 10, 0.5]);
  const tick = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      priv.tick();
      await flush();
    }
  };
  await tick(6);
  const send = async (m: ClientMsg) => {
    c.send(m);
    await flush();
  };
  const set = (x: number, y: number, z: number, raw: number) =>
    (server as unknown as { setBlockAndBroadcast(x: number, y: number, z: number, r: number): void }).setBlockAndBroadcast(x, y, z, raw);
  const tp = (pos: number[]) => priv.teleport(session, pos);
  return { server, session, got, tick, send, set, tp };
}

describe('textures', () => {
  it('has a painter for every block texture', () => {
    expect(TEXTURE_NAMES.filter((n) => !hasPainter(n))).toEqual([]);
  });
});

describe('glow power', () => {
  it('a lever powers a lamp through glowwire, and switches it off again', async () => {
    const { server, send, set } = await setup();
    set(1, 10, 0, B.LEVER);
    for (let x = 2; x <= 4; x++) set(x, 10, 0, B.GLOWWIRE);
    set(5, 10, 0, B.LAMP);
    await send({ t: 'useBlock', x: 1, y: 10, z: 0 });
    expect(server.world.getRaw(1, 10, 0) >>> 12 & POWER_ON).toBe(POWER_ON);
    expect([2, 3, 4].map((x) => server.world.getRaw(x, 10, 0) >>> 12)).toEqual([15, 14, 13]);
    expect(server.world.getBlock(5, 10, 0)).toBe(B.LAMP_ON);
    await send({ t: 'useBlock', x: 1, y: 10, z: 0 });
    expect(server.world.getBlock(5, 10, 0)).toBe(B.LAMP);
    expect(server.world.getRaw(3, 10, 0) >>> 12).toBe(0);
  });

  it('an inverter turns on when its input goes away (after a short delay)', async () => {
    const { server, set, tick } = await setup();
    // Crystal → inverter (facing +x, state 3) → lamp.
    set(1, 10, 0, B.POWER_CRYSTAL);
    set(2, 10, 0, withState(B.INVERTER, 3));
    set(3, 10, 0, B.LAMP);
    await tick(3);
    expect(server.world.getBlock(3, 10, 0)).toBe(B.LAMP);
    set(1, 10, 0, B.AIR);
    await tick(3);
    expect(server.world.getRaw(2, 10, 0) >>> 12 & POWER_ON).toBe(POWER_ON);
    expect(server.world.getBlock(3, 10, 0)).toBe(B.LAMP_ON);
  });

  it('a pusher shoves a row of blocks and retracts', async () => {
    const { server, set } = await setup();
    // Pusher facing +x (dir 0) at x=2; stones at 3,4; lever behind it at x=1.
    set(2, 10, 0, withState(B.PUSHER, 0));
    set(3, 10, 0, B.STONE);
    set(4, 10, 0, B.GLASS);
    set(1, 10, 0, withState(B.LEVER, POWER_ON));
    expect(server.world.getRaw(2, 10, 0) >>> 12 & PUSHER_EXTENDED).toBe(PUSHER_EXTENDED);
    expect([3, 4, 5].map((x) => server.world.getBlock(x, 10, 0))).toEqual([B.PUSHER_HEAD, B.STONE, B.GLASS]);
    set(1, 10, 0, B.LEVER);
    expect(server.world.getBlock(3, 10, 0)).toBe(B.AIR);
    expect(server.world.getRaw(2, 10, 0) >>> 12 & PUSHER_EXTENDED).toBe(0);
  });

  it('a powered door opens and closes with the signal', async () => {
    const { server, set } = await setup();
    set(3, 10, 0, withState(B.ASHWOOD_DOOR, 0));
    set(3, 11, 0, withState(B.ASHWOOD_DOOR, 8));
    set(2, 10, 0, withState(B.LEVER, POWER_ON));
    expect(server.world.getRaw(3, 10, 0) >>> 12 & 4).toBe(4);
    set(2, 10, 0, B.LEVER);
    expect(server.world.getRaw(3, 10, 0) >>> 12 & 4).toBe(0);
  });
});

describe('farming', () => {
  it('tills, plants, fertilises and harvests sunwheat', async () => {
    const { server, session, send, tick, tp } = await setup(GameMode.SURVIVAL);
    session.inventory.slots[0] = { id: toolId(0, 2), count: 1 }; // wooden shovel
    await send({ t: 'useBlock', x: 2, y: 9, z: 0 });
    expect(server.world.getBlock(2, 9, 0)).toBe(B.FARMLAND);
    session.inventory.slots[0] = { id: I.SEEDS, count: 3 };
    await send({ t: 'place', x: 2, y: 10, z: 0, raw: B.SUNWHEAT, slot: 0 });
    expect(server.world.getBlock(2, 10, 0)).toBe(B.SUNWHEAT);
    session.inventory.slots[0] = { id: I.SPORE_POWDER, count: 10 };
    for (let i = 0; i < 6 && (server.world.getRaw(2, 10, 0) >>> 12) < 7; i++) await send({ t: 'useBlock', x: 2, y: 10, z: 0 });
    expect(server.world.getRaw(2, 10, 0) >>> 12).toBe(7);
    await send({ t: 'dig', phase: 2, x: 2, y: 10, z: 0, face: 0 });
    tp([2.5, 10, 1.3]); // stand by the drops
    await tick(15);
    expect(session.inventory.slots.some((s) => s?.id === I.SUNWHEAT)).toBe(true);
    expect(craftingResult([I.SUNWHEAT, I.SUNWHEAT, I.SUNWHEAT, 0, 0, 0, 0, 0, 0], 3)).toEqual({ id: I.BREAD, count: 1 });
  });
});

describe('runes', () => {
  it('upgrade tools at the rune table for lumen dust', () => {
    const inv = new Inventory();
    const w = new ContainerWindow('runetable', inv, emptySlots('runetable'));
    w.slots[0] = { id: toolId(2, 0), count: 1 };
    w.slots[1] = { id: RUNE_ITEMS[0], count: 2 };
    w.slots[2] = { id: I.LUMEN_DUST, count: 10 };
    w.refreshCrafting();
    expect(w.slots[3]).toEqual({ id: toolId(2, 0), count: 1, runes: [1, 0, 0, 0] });
    w.apply(InvAction.CLICK, 3, 0);
    expect(inv.cursor!.runes).toEqual([1, 0, 0, 0]);
    expect(w.slots[0]).toBeNull();
    expect(w.slots[1]!.count).toBe(1);
    expect(w.slots[2]!.count).toBe(6);
    // Keenness only goes on swords and axes.
    expect(runeUpgrade({ id: toolId(2, 0), count: 1 }, { id: RUNE_ITEMS[1], count: 1 }, { id: I.LUMEN_DUST, count: 64 })).toBeNull();
    // Swiftness speeds up mining.
    const pick = itemDef(toolId(2, 0));
    expect(breakTime(B.STONE, pick, false, 2)).toBeLessThan(breakTime(B.STONE, pick, false, 0) * 0.7);
  });
});

describe('the Ember Deep', () => {
  it('generates sealed caverns with magma and ember ore', () => {
    const gen = new WorldGenerator(5);
    let magma = 0;
    let ore = 0;
    let air = 0;
    for (let i = 0; i < 6; i++) {
      const c = gen.generate((DEEP_ORIGIN >> 4) + i, i);
      for (let col = 0; col < 256; col++) {
        expect(c.blocks[col]).toBe(B.COREROCK);
        expect(c.blocks[col | (DEEP_CEILING << 8)]).toBe(B.COREROCK);
      }
      for (const b of c.blocks) {
        if (b === B.MAGMA) magma++;
        if (b === B.EMBER_ORE) ore++;
        if (b === B.AIR) air++;
      }
    }
    expect(magma).toBeGreaterThan(0);
    expect(ore).toBeGreaterThan(0);
    expect(air).toBeGreaterThan(1000);
  });

  it('a lit rift carries the player down and builds a way back', async () => {
    const { server, session, send, set, tick, tp } = await setup(GameMode.SURVIVAL);
    set(3, 9, 3, B.RIFT_STONE);
    for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) set(3 + dx, 9, 3 + dz, B.LUMEN_CRYSTAL);
    session.inventory.slots[0] = { id: I.LUMEN_DUST, count: 2 };
    await send({ t: 'useBlock', x: 3, y: 9, z: 3 });
    expect(server.world.getBlock(3, 10, 3)).toBe(B.RIFT);
    tp([3.5, 10, 3.5]);
    await tick(45);
    for (let i = 0; i < 10 && !isDeep(session.pos[0]); i++) await tick(2);
    expect(isDeep(session.pos[0])).toBe(true);
    const [x, y, z] = session.pos.map(Math.floor);
    // The return rift is right next to the arrival point.
    let found = false;
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) for (let dy = -1; dy <= 2; dy++) {
      if (server.world.getBlock(x + dx, y + dy, z + dz) === B.RIFT) found = true;
    }
    expect(found).toBe(true);
  });
});

describe('settlements and traders', () => {
  function findSettlement(gen: WorldGenerator) {
    for (let gz = -6; gz <= 6; gz++) for (let gx = -6; gx <= 6; gx++) {
      const s = settlementInCell(gen, gx, gz);
      if (s) return s;
    }
    throw new Error('no settlement found');
  }

  it('builds houses with doors and loot chests, the same way every time', () => {
    const gen = new WorldGenerator(1234);
    const s = findSettlement(gen);
    const h = s.houses[0];
    const cx = (h.x0 + 5) >> 4;
    const cz = (h.z0 + 1) >> 4;
    const a = gen.generate(cx, cz);
    const b = new WorldGenerator(1234).generate(cx, cz);
    expect(a.blocks).toEqual(b.blocks);
    const lx = (h.x0 + 5) & 15;
    const lz = (h.z0 + 1) & 15;
    expect(a.getBlock(lx, h.y + 1, lz)).toBe(B.CHEST);
    const chest = a.blockEntities.get(lx | (lz << 4) | ((h.y + 1) << 8));
    expect(chest?.kind).toBe('chest');
    expect(chest?.slots.some((it) => it?.id === I.LUMEN_DUST)).toBe(true);
  });

  it('traders appear at the settlement centre and trade for lumen dust', async () => {
    const { server, session, send, got, tp } = await setup(GameMode.SURVIVAL, 1234);
    const s = findSettlement(new WorldGenerator(1234));
    await server.world.ensureChunk(s.x >> 4, s.z >> 4);
    const traders = [...server.mobs.mobs.values()].filter((m) => m.def.kind === Mob.TRADER);
    expect(traders.length).toBe(3);
    const farmer = traders.find((m) => m.variant === 0)!;
    tp([farmer.body.x + 1, farmer.body.y, farmer.body.z]);
    await send({ t: 'interact', entityId: farmer.id });
    const offers = got.find((m) => m.t === 'trades');
    expect(offers && offers.t === 'trades' && offers.offers.length).toBeGreaterThan(2);
    session.inventory.slots[0] = { id: I.SUNWHEAT, count: 9 };
    await send({ t: 'trade', entityId: farmer.id, offer: 0 });
    expect(session.inventory.slots[0]).toEqual({ id: I.SUNWHEAT, count: 1 });
    expect(session.inventory.slots.some((it) => it?.id === I.LUMEN_DUST && it.count === 2)).toBe(true);
  });
});

describe('settings', () => {
  it('each player can choose their own view distance', async () => {
    const { server, send, tick } = await setup();
    const p = [...(server as unknown as { players: Map<number, { sent: Map<string, unknown> }> }).players.values()][0];
    await tick(20);
    const before = p.sent.size;
    await send({ t: 'settings', viewDistance: 5 });
    await tick(40);
    expect(p.sent.size).toBeGreaterThan(before);
  });
});
