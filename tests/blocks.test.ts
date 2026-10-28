import { describe, expect, it } from 'vitest';
import { B, BED_HEAD, BED_PAIRED, collisionBoxes, LEAVES_PLACED, WATER_FALLING, withState } from '../src/shared/blocks/registry';
import { bedPartner, placementRaw } from '../src/shared/blocks/placement';
import { GameMode, PROTOCOL_VERSION } from '../src/shared/constants';
import type { Inventory } from '../src/shared/items/Inventory';
import { blockDrops } from '../src/shared/items/mining';
import { PlayerBody } from '../src/shared/physics/PlayerBody';
import type { ClientMsg, ServerMsg } from '../src/shared/protocol/messages';
import { MoveFlag } from '../src/shared/protocol/messages';
import { Chunk } from '../src/shared/world/Chunk';
import { desiredWater, waterFlow, waterHeightPx } from '../src/shared/world/fluid';
import { computeChunkLight } from '../src/shared/world/lighting';
import { createLocalPair } from '../src/net/LocalTransport';
import { GameServer } from '../src/server/GameServer';
import type { ChunkGenerator } from '../src/server/ServerWorld';
import { newWorldMeta } from '../src/server/storage/WorldStorage';

// Block behaviours: two-block beds, cactus, falling sand, leaf decay, flowing water.

function flatChunk(cx: number, cz: number): Chunk {
  const c = new Chunk(cx, cz);
  for (let i = 0; i < 10 * 256; i++) c.blocks[i] = B.STONE; // ground: y 0..9, surface at y 10
  c.recomputeHeights();
  computeChunkLight(c);
  return c;
}
const flatGen: ChunkGenerator = { concurrency: 64, generate: async (cx, cz) => flatChunk(cx, cz) };
const flush = () => new Promise((r) => setTimeout(r, 0));

interface Session {
  inventory: Inventory;
  health: number;
  pos: number[];
  fallStartY: number;
}

interface Priv {
  tick(): void;
  players: Map<number, Session>;
  teleport(p: Session, pos: number[]): void;
  setBlockAndBroadcast(x: number, y: number, z: number, raw: number): void;
  growCactus(x: number, y: number, z: number, age: number): void;
  world: { getRaw(x: number, y: number, z: number): number; getBlock(x: number, y: number, z: number): number };
}

async function setup(mode = GameMode.SURVIVAL) {
  const server = new GameServer({ viewDistance: 2, meta: newWorldMeta('b', 1, mode) }, flatGen);
  server.mobSpawning = false;
  const priv = server as unknown as Priv;
  const [s, c] = createLocalPair<ServerMsg, ClientMsg>();
  const received: ServerMsg[] = [];
  c.onMessage = (m) => received.push(m);
  server.addConnection(s, { host: true });
  c.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'T' });
  await flush();
  const tick = async (n = 1) => {
    for (let i = 0; i < n; i++) priv.tick();
    await flush();
  };
  await tick(5);
  const session = [...priv.players.values()][0];
  const send = async (m: ClientMsg) => {
    c.send(m);
    await flush();
  };
  priv.teleport(session, [0.5, 10, 0.5]);
  await send({ t: 'move', seq: 0, x: 0.5, y: 10, z: 0.5, yaw: 0, pitch: 0, flags: MoveFlag.ON_GROUND });
  const set = (x: number, y: number, z: number, raw: number) => priv.setBlockAndBroadcast(x, y, z, raw);
  const get = (x: number, y: number, z: number) => priv.world.getBlock(x, y, z);
  const raw = (x: number, y: number, z: number) => priv.world.getRaw(x, y, z);
  return { server, priv, session, received, send, tick, set, get, raw };
}

describe('two-block bed', () => {
  it('places foot and head, drops once, and breaking either half removes both', async () => {
    const { session, send, tick, get, raw, server } = await setup();
    session.inventory.slots[0] = { id: B.BEDROLL, count: 1 };
    // Looking along -z (yaw 0): foot at z = -2, head at z = -3.
    const bed = placementRaw(B.BEDROLL, 0, 1, 0, 0)!;
    expect(bed >>> 12).toBe(2 | BED_PAIRED);
    await send({ t: 'place', x: 0, y: 10, z: -2, raw: bed, slot: 0 });
    const [hx, hy, hz] = bedPartner(0, 10, -2, bed >>> 12);
    expect([hx, hy, hz]).toEqual([0, 10, -3]);
    expect(raw(0, 10, -2)).toBe(bed);
    expect(raw(0, 10, -3)).toBe(withState(B.BEDROLL, (bed >>> 12) | BED_HEAD));
    expect(blockDrops(raw(0, 10, -3), undefined, Math.random)).toEqual([]);
    // Break the head: the foot pops and drops the one bed.
    await send({ t: 'dig', phase: 0, x: 0, y: 10, z: -3, face: 2 });
    (session as unknown as { dig: { start: number } }).dig.start -= 5000;
    await send({ t: 'dig', phase: 2, x: 0, y: 10, z: -3, face: 2 });
    await tick(2);
    expect(get(0, 10, -2)).toBe(B.AIR);
    expect(get(0, 10, -3)).toBe(B.AIR);
    const beds = [...server.items.all.values()].filter((e) => e.item.id === B.BEDROLL);
    expect(beds.reduce((n, e) => n + e.item.count, 0)).toBe(1);
  });

  it('bounces a falling body and halves the fall damage', async () => {
    const { set, session, send, priv } = await setup();
    set(0, 10, 0, withState(B.BEDROLL, BED_PAIRED));
    set(0, 10, 1, withState(B.BEDROLL, BED_PAIRED | BED_HEAD));
    // Client side: a body dropping onto the bed bounces back up.
    const body = new PlayerBody();
    body.x = 0.5; body.y = 20; body.z = 0.5;
    const q = { boxes: (x: number, y: number, z: number) => { const r = priv.world.getRaw(x, y, z); return r < 0 ? null : collisionBoxes(r); }, isWater: () => false, getRaw: (x: number, y: number, z: number) => priv.world.getRaw(x, y, z) };
    const input = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw: 0 };
    for (let i = 0; i < 120 && !body.bounced; i++) body.step(q, input, 1 / 60);
    expect(body.bounced).toBe(true);
    expect(body.vy).toBeGreaterThan(5);
    // Host side: a 20-block fall onto the bed costs about half the damage.
    priv.teleport(session, [0.5, 30, 0.5]);
    await send({ t: 'move', seq: 1, x: 0.5, y: 30, z: 0.5, yaw: 0, pitch: 0, flags: 0 });
    await send({ t: 'move', seq: 2, x: 0.5, y: 10.6, z: 0.5, yaw: 0, pitch: 0, flags: MoveFlag.BOUNCED });
    expect(session.health).toBe(20 - Math.floor((30 - 10.5625) / 2 - 3));
  });
});

describe('cactus', () => {
  it('hurts whoever touches it, burns items, grows to 3 and pops next to solid blocks', async () => {
    const { set, get, tick, session, priv, server } = await setup();
    set(3, 9, 0, B.SAND);
    set(3, 10, 0, B.CACTUS);
    expect(collisionBoxes(B.CACTUS)).toEqual([1 / 16, 0, 1 / 16, 15 / 16, 15 / 16, 15 / 16]);
    // Standing right against its side.
    priv.teleport(session, [3 - 0.3 + 1 / 16 - 0.001, 10, 0.5]);
    session.pos = [2.76, 10, 0.5];
    await tick(20);
    expect(session.health).toBeLessThan(20);
    // A dropped item landing on it is destroyed.
    server.items.spawn({ id: B.DIRT, count: 1 }, 3.5, 12, 0.5);
    await tick(40);
    expect([...server.items.all.values()].some((e) => e.item.id === B.DIRT)).toBe(false);
    // Growth: 16 random ticks per block, never above 3.
    for (let n = 0; n < 60; n++) priv.growCactus(3, 10 + (get(3, 11, 0) === B.CACTUS ? 1 : 0), 0, 15);
    await tick(2);
    expect(get(3, 11, 0)).toBe(B.CACTUS);
    expect(get(3, 12, 0)).toBe(B.CACTUS);
    for (let n = 0; n < 20; n++) priv.growCactus(3, 12, 0, 15);
    expect(get(3, 13, 0)).toBe(B.AIR);
    // A block put right beside it breaks it (and the cactus above it falls with it).
    set(4, 10, 0, B.STONE);
    await tick(3);
    expect(get(3, 10, 0)).toBe(B.AIR);
  });
});

describe('falling sand and leaves', () => {
  it('drops sand when its support goes and lands it as a block', async () => {
    const { set, get, tick } = await setup();
    set(6, 14, 6, B.STONE);
    set(6, 15, 6, B.SAND);
    set(6, 16, 6, B.GRAVEL);
    await tick(2);
    expect(get(6, 15, 6)).toBe(B.SAND); // held up
    set(6, 14, 6, B.AIR);
    await tick(80);
    expect(get(6, 10, 6)).toBe(B.SAND);
    expect(get(6, 11, 6)).toBe(B.GRAVEL);
    expect(get(6, 15, 6)).toBe(B.AIR);
  });

  it('decays natural leaves cut off from their log, but not placed ones', async () => {
    const { set, get, tick } = await setup();
    set(8, 10, 8, B.ASHWOOD_LOG);
    set(8, 11, 8, B.ASHWOOD_LOG);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) set(8 + dx, 11, 8 + dz, B.ASHWOOD_LEAVES);
    set(8, 12, 8, withState(B.ASHWOOD_LEAVES, LEAVES_PLACED));
    await tick(300);
    expect(get(9, 11, 8)).toBe(B.ASHWOOD_LEAVES); // still attached
    set(8, 11, 8, B.AIR);
    set(8, 10, 8, B.AIR);
    await tick(300);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) expect(get(8 + dx, 11, 8 + dz)).toBe(B.AIR);
    expect(get(8, 12, 8)).toBe(B.ASHWOOD_LEAVES);
  });
});

describe('flowing water', () => {
  it('spreads 7 blocks from a source, falls into holes, and dries up when the source goes', async () => {
    const { set, get, raw, tick } = await setup();
    set(0, 10, 20, B.WATER);
    await tick(5 * 10);
    for (let d = 1; d <= 7; d++) expect(raw(d, 10, 20)).toBe(withState(B.WATER, d));
    expect(get(8, 10, 20)).toBe(B.AIR);
    // Dig a hole: water pours down into it.
    set(3, 9, 22, B.AIR);
    await tick(5 * 12);
    expect(raw(3, 9, 22) >>> 12 & WATER_FALLING).toBe(WATER_FALLING);
    // Remove the source: everything drains away.
    set(0, 10, 20, B.AIR);
    await tick(5 * 20);
    for (let d = 0; d <= 7; d++) expect(get(d, 10, 20)).toBe(B.AIR);
  });

  it('pours off a ledge as one column and spreads only where it lands', async () => {
    const { set, get, tick } = await setup();
    for (let x = -30; x <= -26; x++) for (let z = -2; z <= 2; z++) set(x, 20, z, B.STONE); // a ledge 10 above the ground
    set(-26, 21, 0, B.WATER);
    await tick(5 * 40);
    let mid = 0;
    let ground = 0;
    for (let x = -40; x <= -15; x++) for (let z = -12; z <= 12; z++) {
      for (let y = 11; y <= 19; y++) if (get(x, y, z) === B.WATER) mid++;
      if (get(x, 10, z) === B.WATER) ground++;
    }
    expect(mid).toBeLessThanOrEqual(9); // just the falling column
    expect(ground).toBeGreaterThan(20);
    expect(ground).toBeLessThan(200);
  });

  it('makes a new source between two sources on solid ground', async () => {
    const { set, raw, tick } = await setup();
    set(0, 10, -20, B.WATER);
    set(2, 10, -20, B.WATER);
    await tick(5 * 3);
    expect(raw(1, 10, -20)).toBe(B.WATER); // state 0 = source
    set(0, 10, -20, B.STONE);
    set(2, 10, -20, B.STONE);
    await tick(5 * 3);
    expect(raw(1, 10, -20)).toBe(B.WATER); // stays: it is a source now
  });

  it('carries a swimmer along with the current (world queried as an object with methods)', () => {
    // Like ClientWorld: getRaw uses `this`, so the physics must call it as a method.
    class World {
      private cells = new Map<string, number>([['0,10,0', withState(B.WATER, 1)], ['1,10,0', withState(B.WATER, 2)], ['-1,10,0', B.WATER]]);
      getRaw(x: number, y: number, z: number): number {
        return this.cells.get(`${x},${y},${z}`) ?? (y < 10 ? B.STONE : B.AIR);
      }
      boxes(x: number, y: number, z: number) {
        return collisionBoxes(this.getRaw(x, y, z));
      }
      isWater(x: number, y: number, z: number) {
        return (this.getRaw(x, y, z) & 0xfff) === B.WATER;
      }
    }
    const body = new PlayerBody();
    body.x = 0.5; body.y = 10; body.z = 0.5;
    const input = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw: 0 };
    for (let i = 0; i < 20; i++) body.step(new World(), input, 1 / 60);
    expect(body.vx).toBeGreaterThan(0.3); // pushed towards +x (lower water)
  });

  it('pushes towards lower water and draws flowing water lower', () => {
    const cells = new Map<string, number>([['0,0,0', withState(B.WATER, 2)], ['1,0,0', withState(B.WATER, 3)], ['-1,0,0', withState(B.WATER, 1)]]);
    const get = (x: number, y: number, z: number) => cells.get(`${x},${y},${z}`) ?? (y < 0 ? B.STONE : B.STONE);
    const f = waterFlow(get, 0, 0, 0)!;
    expect(f[0]).toBeGreaterThan(0.9);
    expect(desiredWater(get, 0, 0, 0)).toBe(2);
    expect(waterHeightPx(0, false)).toBeGreaterThan(waterHeightPx(5, false));
    expect(waterHeightPx(WATER_FALLING, false)).toBe(16);
  });
});
