import { describe, expect, it } from 'vitest';
import { B } from '../src/shared/blocks/registry';
import { GameMode, PROTOCOL_VERSION } from '../src/shared/constants';
import { Mob, MobAnim, MobFlag } from '../src/shared/entities/mobs';
import { I } from '../src/shared/items/registry';
import type { ClientMsg, ServerMsg } from '../src/shared/protocol/messages';
import { Chunk } from '../src/shared/world/Chunk';
import { Biome } from '../src/shared/world/biomes';
import { computeChunkLight } from '../src/shared/world/lighting';
import { createLocalPair } from '../src/net/LocalTransport';
import { GameServer } from '../src/server/GameServer';
import type { ChunkGenerator } from '../src/server/ServerWorld';
import { newWorldMeta, type WorldMeta } from '../src/server/storage/WorldStorage';

// Stage C: fish schools, the octopus, songbirds, bats, turtles, donkeys, leads and name tags.

/** Flat grass at y 9 (plains); chunk (2, 0) is a pond (water y 4–9); chunk (-2, 0) a sandy beach. */
function chunkAt(cx: number, cz: number): Chunk {
  const c = new Chunk(cx, cz);
  const beach = cx === -2 && cz === 0;
  for (let i = 0; i < 10 * 256; i++) c.blocks[i] = i >= 9 * 256 ? (beach ? B.SAND : B.GRASS) : B.STONE;
  if (cx === 2 && cz === 0) for (let i = 4 * 256; i < 10 * 256; i++) c.blocks[i] = B.WATER;
  c.biomes.fill(beach ? Biome.BEACH : Biome.PLAINS);
  c.recomputeHeights();
  computeChunkLight(c);
  return c;
}
const gen: ChunkGenerator = { concurrency: 64, generate: async (cx, cz) => chunkAt(cx, cz) };
const flush = () => new Promise((r) => setTimeout(r, 0));

interface Session {
  health: number;
  pos: number[];
  sneaking: boolean;
  riding: number | null;
  inventory: { slots: Array<{ id: number; count: number } | null>; selected: number };
}

async function setup(opts: { time?: number; at?: number[]; meta?: WorldMeta; mode?: number } = {}) {
  const meta = opts.meta ?? newWorldMeta('wildlife', 1, opts.mode ?? GameMode.SURVIVAL);
  meta.time = opts.time ?? 6000;
  const server = new GameServer({ viewDistance: 3, meta }, gen);
  server.mobSpawning = false;
  const [s, c] = createLocalPair<ServerMsg, ClientMsg>();
  const got: ServerMsg[] = [];
  c.onMessage = (m) => got.push(m);
  server.addConnection(s, { host: true });
  c.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'T' });
  await flush();
  const priv = server as unknown as {
    tick(): void; players: Map<number, Session>; teleport(p: Session, pos: number[]): void;
    setBlockAndBroadcast(x: number, y: number, z: number, raw: number): void; mobTargets(): never;
  };
  const session = [...priv.players.values()][0];
  priv.teleport(session, opts.at ?? [0.5, 10, 0.5]);
  const tick = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      priv.tick();
      if (i % 20 === 0) await flush();
    }
    await flush();
  };
  await tick(10);
  const send = async (m: ClientMsg) => {
    c.send(m);
    await flush();
  };
  const hold = (id: number, count = 1) => {
    session.inventory.slots[0] = id ? { id, count } : null;
    session.inventory.selected = 0;
  };
  const moveTo = (x: number, y: number, z: number) => {
    session.pos = [x, y, z];
  };
  return { server, session, got, tick, send, hold, moveTo, priv };
}

describe('wildlife', () => {
  it('fish school under the water, and die stranded on land', async () => {
    const { server, tick } = await setup({ at: [0.5, 10, 0.5] });
    const school = [0, 1, 2].map((i) => server.mobs.spawn(Mob.FISH, 40.5 + i, 6, 8.5, { variant: 0 })!);
    await tick(200);
    for (const f of school) {
      expect(f.body.inWater).toBe(true);
      expect(f.body.y).toBeLessThan(9.2);
    }
    // They keep together.
    expect(Math.hypot(school[0].body.x - school[2].body.x, school[0].body.z - school[2].body.z)).toBeLessThan(10);
    const stranded = server.mobs.spawn(Mob.FISH, 6.5, 10, 6.5)!;
    await tick(140);
    expect(stranded.health < 3 || stranded.deadTicks > 0).toBe(true);
  });

  it('octopuses squirt ink and jet away when hit', async () => {
    const { server, got, tick } = await setup({ at: [36.5, 6, 8.5] });
    const o = server.mobs.spawn(Mob.OCTOPUS, 38.5, 6, 8.5)!;
    server.mobs.hit(o.id, 1, [36.5, 6, 8.5], { player: 1 });
    await tick(2);
    expect(got.some((m) => m.t === 'entityEvent' && m.event === 'ink')).toBe(true);
    expect(o.fleeTicks).toBeGreaterThan(0);
  });

  it('songbirds perch, then the whole flock takes off when someone walks up', async () => {
    const { server, session, tick, moveTo } = await setup();
    const flock = [0, 1, 2].map((i) => server.mobs.spawn(Mob.SONGBIRD, 10.5 + i * 0.6, 10, 10.5)!);
    await tick(40);
    for (const b of flock) {
      expect(b.mode).toBe('perch');
      expect(b.body.flying).toBe(false); // perched (it may be mid-hop)
      expect(b.body.y).toBeLessThan(11.5);
    }
    session.sneaking = false;
    moveTo(10.5, 10, 13.5);
    await tick(10);
    for (const b of flock) expect(b.mode).toBe('fly');
    await tick(20);
    expect(Math.max(...flock.map((b) => b.body.y))).toBeGreaterThan(10.5);
  });

  it('bats flutter, roost upside down under a ceiling, and wake when disturbed', async () => {
    const { server, tick, priv, moveTo } = await setup({ time: 18000 });
    for (let x = 18; x < 26; x++) for (let z = 18; z < 26; z++) priv.setBlockAndBroadcast(x, 14, z, B.STONE);
    const bat = server.mobs.spawn(Mob.BAT, 21.5, 14 - 0.6, 21.5)!; // hanging with its feet at the ceiling
    expect(bat.body.hover).toBe(true);
    bat.mode = 'roost';
    await tick(40);
    expect(bat.mode).toBe('roost');
    expect(bat.anim & MobAnim.SLEEP).toBeTruthy();
    moveTo(21.5, 10, 23.5);
    await tick(3);
    expect(bat.mode).not.toBe('roost');
  });

  it('turtles live on beaches and swim fast in water', async () => {
    const w = await setup({ at: [-24.5, 10, 8.5] });
    w.server.mobSpawning = true;
    const targets = (w.server as unknown as { mobTargets(): never }).mobTargets();
    for (let i = 0; i < 120 && ![...w.server.mobs.mobs.values()].some((m) => m.def.kind === Mob.TURTLE); i++) w.server.mobs.spawnTick(targets, 6000);
    // The beach chunk is the only sand: if anything spawned on it, it is a turtle or a rabbit.
    const t = w.server.mobs.spawn(Mob.TURTLE, 40.5, 6, 8.5)!;
    w.server.mobs.mobs.get(t.id)!.path = null;
    await w.tick(5);
    expect(t.body.inWater).toBe(true);
    expect(t.body.walkSpeed).toBeGreaterThan(2);
  });

  it('donkeys are broken in like horses and carry a saddle', async () => {
    const { server, session, got, tick, send, hold } = await setup();
    const d = server.mobs.spawn(Mob.DONKEY, 2.5, 10, 0.5)!;
    d.temper = 100;
    hold(0);
    await send({ t: 'interact', entityId: d.id });
    expect(session.riding).toBe(d.id);
    await tick(120);
    expect(d.flags & MobFlag.TAMED).toBeTruthy();
    await send({ t: 'dismount' });
    hold(I.SADDLE);
    await send({ t: 'interact', entityId: d.id });
    hold(0);
    await send({ t: 'interact', entityId: d.id });
    expect(got.some((m) => m.t === 'ride' && m.entityId === d.id && m.steer && m.speed === 6.5)).toBe(true);
  });
});

describe('land animals keep out of water', () => {
  it("don't wade in while wandering or following food across a pond", async () => {
    const { server, session, tick, hold, moveTo } = await setup({ at: [37.5, 10, 8.5] });
    const animals = [Mob.SHEEP, Mob.CHICKEN, Mob.COW, Mob.PIG].map((k, i) => server.mobs.spawn(k, 28.5, 10, 5.5 + i * 2)!);
    // The player stands out over the pond holding food each of them likes: they come to the edge, not in.
    session.inventory.slots[0] = { id: I.SUNWHEAT, count: 8 };
    session.inventory.slots[1] = { id: I.SEEDS, count: 8 };
    session.inventory.slots[2] = { id: I.ASHFRUIT, count: 8 };
    let wet = 0;
    for (let i = 0; i < 30; i++) {
      hold([I.SUNWHEAT, I.SEEDS, I.ASHFRUIT][i % 3], 8);
      moveTo(37.5, 10, 8.5);
      await tick(10);
      for (const a of animals) if (a.body.inWater) wet++;
    }
    expect(wet).toBe(0);
    // They did come up to the shore.
    expect(Math.max(...animals.map((a) => a.body.x))).toBeGreaterThan(30);
  });

  it('flee along the shore instead of into the water', async () => {
    const { server, tick } = await setup({ at: [27.5, 10, 8.5] });
    const sheep = server.mobs.spawn(Mob.SHEEP, 30.5, 10, 8.5)!;
    sheep.fleeTicks = 80;
    sheep.fleeFrom = [27.5, 8.5];
    let wet = 0;
    for (let i = 0; i < 16; i++) {
      await tick(5);
      if (sheep.body.inWater) wet++;
    }
    expect(wet).toBe(0);
  });

  it('swim straight back to land if they end up in the water', async () => {
    const { server, tick } = await setup({ at: [20.5, 10, 8.5] });
    const hen = server.mobs.spawn(Mob.CHICKEN, 37.5, 9, 8.5)!;
    const ewe = server.mobs.spawn(Mob.SHEEP, 40.5, 8.5, 8.5)!;
    await tick(5);
    expect(ewe.body.inWater).toBe(true);
    await tick(400);
    for (const a of [hen, ewe]) {
      expect(a.body.inWater).toBe(false);
      expect(server.world.getBlock(Math.floor(a.body.x), Math.floor(a.body.y - 0.5), Math.floor(a.body.z))).not.toBe(B.WATER);
    }
  });

  it('turtles still swim', async () => {
    const { server, tick } = await setup({ at: [20.5, 10, 8.5] });
    // Unlike land animals, it isn't driven out: after a second it is still out in the pond.
    const t = server.mobs.spawn(Mob.TURTLE, 40.5, 6, 8.5)!;
    await tick(20);
    expect(t.body.x).toBeGreaterThan(35);
    expect(t.body.x).toBeLessThan(46);
    expect(server.world.getBlock(Math.floor(t.body.x), Math.floor(t.body.y), Math.floor(t.body.z))).toBe(B.WATER);
  });
});

describe('leads and name tags', () => {
  it('a lead makes an animal follow; it snaps if pulled too far; taking it off gives it back', async () => {
    const { server, session, got, tick, send, hold, moveTo } = await setup();
    const cow = server.mobs.spawn(Mob.COW, 2.5, 10, 0.5)!;
    hold(I.LEAD, 2);
    await send({ t: 'interact', entityId: cow.id });
    expect(cow.leash).toBe(session ? [...(server as unknown as { players: Map<number, { id: number }> }).players.values()][0].id : -1);
    expect(got.some((m) => m.t === 'mobState' && m.entity.kind === 'mob' && m.entity.leash !== undefined)).toBe(true);
    moveTo(10.5, 10, 0.5);
    await tick(120);
    expect(Math.hypot(cow.body.x - 10.5, cow.body.z - 0.5)).toBeLessThan(5);
    // Take it off: the lead comes back as an item.
    moveTo(cow.body.x + 1.5, 10, cow.body.z);
    await send({ t: 'interact', entityId: cow.id });
    expect(cow.leash).toBe(null);
    await tick(2);
    expect([...server.items.all.values()].some((e) => e.item.id === I.LEAD)).toBe(true);
    // On again, then too far: it snaps and drops.
    for (const e of [...server.items.all.values()]) server.items.all.delete(e.id);
    hold(I.LEAD, 1);
    await send({ t: 'interact', entityId: cow.id });
    moveTo(cow.body.x + 30, 10, cow.body.z);
    await tick(3);
    expect(cow.leash).toBe(null);
    expect([...server.items.all.values()].some((e) => e.item.id === I.LEAD)).toBe(true);
  });

  it('a name tag names a creature; the name is kept in the save and stops it wandering off', async () => {
    let saved: WorldMeta | null = null;
    const meta = newWorldMeta('named', 1, GameMode.SURVIVAL);
    const store = { loadChunk: async () => undefined, saveChunks: async () => {}, saveMeta: async (m: WorldMeta) => { saved = m; } };
    const w = await setup({ meta });
    (w.server.options as { store?: unknown }).store = store;
    const pig = w.server.mobs.spawn(Mob.PIG, 2.5, 10, 0.5)!;
    w.hold(I.NAME_TAG, 2);
    await w.send({ t: 'nameMob', entityId: pig.id, name: '  ורוד   קטן ' });
    expect(pig.name).toBe('ורוד קטן');
    expect(w.session.inventory.slots[0]?.count).toBe(1);
    expect(w.got.some((m) => m.t === 'mobState' && m.entity.kind === 'mob' && m.entity.name === 'ורוד קטן')).toBe(true);
    // Bad names are refused (and the tag kept).
    await w.send({ t: 'nameMob', entityId: pig.id, name: '<script>' });
    expect(pig.name).toBe('ורוד קטן');
    expect(w.session.inventory.slots[0]?.count).toBe(1);
    // A named monster stays even when nobody is near.
    const walker = w.server.mobs.spawn(Mob.GLOOMWALKER, 60.5, 10, 0.5)!;
    w.server.mobs.rename(walker, 'Bob');
    w.moveTo(0.5, 10, 0.5);
    await w.tick(40);
    expect(w.server.mobs.mobs.has(walker.id)).toBe(true);
    await w.server.save();
    const back = Object.values(saved!.creatures ?? {}).flat().find((c) => c.k === Mob.PIG)!;
    expect(back.n).toBe('ורוד קטן');
  });
});

describe('wildlife spawning', () => {
  it('fills the pond with fish and the meadow with songbirds by day', async () => {
    const w = await setup({ at: [20.5, 10, 30.5] });
    w.server.mobSpawning = true;
    const targets = w.priv.mobTargets();
    // The pond is a small part of the spawn ring: give it plenty of tries.
    for (let i = 0; i < 1500; i++) w.server.mobs.spawnTick(targets, 6000);
    const kinds = [...w.server.mobs.mobs.values()].map((m) => m.def.kind);
    expect(kinds).toContain(Mob.SONGBIRD);
    expect(kinds.some((k) => k === Mob.FISH || k === Mob.OCTOPUS)).toBe(true);
    for (const m of w.server.mobs.mobs.values()) if (m.def.kind === Mob.FISH) expect(w.server.world.getBlock(Math.floor(m.body.x), Math.floor(m.body.y), Math.floor(m.body.z))).toBe(B.WATER);
  });
});
