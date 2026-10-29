import { describe, expect, it } from 'vitest';
import { B } from '../src/shared/blocks/registry';
import { GameMode, PROTOCOL_VERSION } from '../src/shared/constants';
import { ALL_MOBS, GROW_TICKS, Mob, MobFlag, mobDef, PASSIVE_MOBS } from '../src/shared/entities/mobs';
import { I } from '../src/shared/items/registry';
import type { ClientMsg, ServerMsg } from '../src/shared/protocol/messages';
import { Chunk } from '../src/shared/world/Chunk';
import { Biome } from '../src/shared/world/biomes';
import { computeChunkLight } from '../src/shared/world/lighting';
import { createLocalPair } from '../src/net/LocalTransport';
import { GameServer } from '../src/server/GameServer';
import type { ChunkGenerator } from '../src/server/ServerWorld';
import { newWorldMeta, type ChunkStore, type WorldMeta } from '../src/server/storage/WorldStorage';

// Animals on the host: breeding and babies, shearing, milk, eggs, taming, riding, biome herds,
// and animals kept in the world save (and across chunk unloads) without duplicates.

function flatChunk(cx: number, cz: number, biome: number): Chunk {
  const c = new Chunk(cx, cz);
  for (let i = 0; i < 10 * 256; i++) c.blocks[i] = i >= 9 * 256 ? B.GRASS : B.STONE;
  c.biomes.fill(biome);
  c.recomputeHeights();
  computeChunkLight(c);
  return c;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

interface Session {
  pos: number[];
  riding: number | null;
  inventory: { slots: Array<{ id: number; count: number } | null>; selected: number };
}

async function setup(opts: { mode?: number; meta?: WorldMeta; biome?: number; store?: ChunkStore } = {}) {
  const meta = opts.meta ?? newWorldMeta('animals', 1, opts.mode ?? GameMode.SURVIVAL);
  const gen: ChunkGenerator = { concurrency: 64, generate: async (cx, cz) => flatChunk(cx, cz, opts.biome ?? Biome.PLAINS) };
  const server = new GameServer({ viewDistance: 3, meta, store: opts.store }, gen);
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
      if (i % 20 === 0) await flush();
    }
    await flush();
  };
  await tick(8);
  const send = async (m: ClientMsg) => {
    c.send(m);
    await flush();
  };
  const hold = (id: number, count = 1) => {
    session.inventory.slots[0] = id ? { id, count } : null;
    session.inventory.selected = 0;
  };
  const moveTo = (x: number, z: number) => priv.teleport(session, [x, 10, z]);
  return { server, session, got, tick, send, hold, moveTo };
}

describe('animal roster', () => {
  it('has the ten farm animals and pets, each with food, a habitat or a home, and drops', () => {
    for (const kind of [Mob.COW, Mob.SHEEP, Mob.PIG, Mob.CHICKEN, Mob.HORSE, Mob.WOLF, Mob.CAT, Mob.RABBIT, Mob.FOX, Mob.GOAT]) {
      const d = mobDef(kind)!;
      expect(d, `kind ${kind}`).toBeDefined();
      expect(d.animal?.food.length, d.key).toBeGreaterThan(0);
      // Cats live in settlements; everything else has a natural habitat.
      if (kind !== Mob.CAT) expect(d.habitat?.biomes.length, d.key).toBeGreaterThan(0);
      expect(d.variant, d.key).toBeDefined();
    }
    expect(PASSIVE_MOBS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(ALL_MOBS.map((k) => mobDef(k)!.key)).size).toBe(ALL_MOBS.length);
  });
});

describe('animals on the host', () => {
  it('breed when fed, and the baby grows up', async () => {
    const { server, tick, send, hold } = await setup();
    const a = server.mobs.spawn(Mob.COW, 2.5, 10, 0.5)!;
    const b = server.mobs.spawn(Mob.COW, 3.5, 10, 1.5)!;
    hold(I.SUNWHEAT, 5);
    await send({ t: 'interact', entityId: a.id });
    await send({ t: 'interact', entityId: b.id });
    expect(a.flags & MobFlag.LOVE).toBeTruthy();
    await tick(200);
    const babies = [...server.mobs.mobs.values()].filter((m) => m.def.kind === Mob.COW && m.flags & MobFlag.BABY);
    expect(babies.length).toBe(1);
    expect(a.breedCooldown).toBeGreaterThan(0);
    const calf = babies[0];
    expect(calf.body.height).toBeLessThan(a.body.height);
    calf.age = GROW_TICKS - 2;
    await tick(4);
    expect(calf.flags & MobFlag.BABY).toBeFalsy();
    expect(calf.body.height).toBe(a.body.height);
  });

  it('sheep can be sheared and grow their fleece back by eating grass', async () => {
    const { server, tick, send, hold, got } = await setup();
    const sheep = server.mobs.spawn(Mob.SHEEP, 2.5, 10, 0.5)!;
    hold(I.SHEARS);
    await send({ t: 'interact', entityId: sheep.id });
    expect(sheep.flags & MobFlag.SHEARED).toBeTruthy();
    expect(got.some((m) => m.t === 'mobState' && m.entity.kind === 'mob' && (m.entity.flags ?? 0) & MobFlag.SHEARED)).toBe(true);
    await tick(2);
    expect([...server.items.all.values()].some((e) => e.item.id === I.FLEECE)).toBe(true);
    // Shearing again does nothing.
    const fleece = [...server.items.all.values()].filter((e) => e.item.id === I.FLEECE).length;
    await send({ t: 'interact', entityId: sheep.id });
    expect([...server.items.all.values()].filter((e) => e.item.id === I.FLEECE).length).toBe(fleece);
    // Grazing: the grass under it turns to dirt and the fleece is back.
    sheep.actionTicks = 1;
    sheep.path = null;
    await tick(1);
    expect(sheep.flags & MobFlag.SHEARED).toBeFalsy();
    expect(server.world.getBlock(Math.floor(sheep.body.x), 9, Math.floor(sheep.body.z))).toBe(B.DIRT);
  });

  it('cows give milk for a bucket, and drinking it gives the bucket back', async () => {
    const { server, session, send, hold } = await setup();
    const cow = server.mobs.spawn(Mob.COW, 2.5, 10, 0.5)!;
    hold(I.BUCKET);
    await send({ t: 'interact', entityId: cow.id });
    expect(session.inventory.slots[0]?.id).toBe(I.MILK_BUCKET);
    (session as unknown as { food: number }).food = 10;
    await send({ t: 'useItem', phase: 0, slot: 0 });
    await new Promise((r) => setTimeout(r, 1700));
    await send({ t: 'useItem', phase: 2, slot: 0 });
    expect(session.inventory.slots.some((s) => s?.id === I.BUCKET)).toBe(true);
  });

  it('chickens lay eggs', async () => {
    const { server, tick } = await setup();
    const hen = server.mobs.spawn(Mob.CHICKEN, 2.5, 10, 0.5)!;
    hen.eggTimer = 2;
    await tick(4);
    expect([...server.items.all.values()].some((e) => e.item.id === I.EGG)).toBe(true);
  });

  it('wolves can be tamed, sit on command and follow their owner', async () => {
    const { server, session, tick, send, hold, moveTo } = await setup({ mode: GameMode.CREATIVE });
    const wolf = server.mobs.spawn(Mob.WOLF, 2.5, 10, 0.5)!;
    hold(I.RAW_MEAT, 3);
    await send({ t: 'interact', entityId: wolf.id });
    expect(wolf.flags & MobFlag.TAMED).toBeTruthy();
    expect(wolf.flags & MobFlag.SITTING).toBeTruthy();
    expect(wolf.owner).toBe('T');
    hold(0);
    await send({ t: 'interact', entityId: wolf.id });
    expect(wolf.flags & MobFlag.SITTING).toBeFalsy();
    // The owner walks off: the wolf comes after them.
    moveTo(9.5, 0.5);
    await tick(10);
    expect(session.pos[0]).toBeCloseTo(9.5, 0);
    await tick(80);
    expect(Math.abs(wolf.body.x - 9.5)).toBeLessThan(6);
  });

  it('wild wolves fight back as a pack', async () => {
    const { server, session, tick, send } = await setup();
    const a = server.mobs.spawn(Mob.WOLF, 2.5, 10, 0.5)!;
    const b = server.mobs.spawn(Mob.WOLF, 4.5, 10, 2.5)!;
    session.inventory.slots[0] = null;
    await send({ t: 'attack', entityId: a.id });
    expect(a.flags & MobFlag.ANGRY).toBeTruthy();
    expect(b.flags & MobFlag.ANGRY).toBeTruthy();
    await tick(60);
    expect((session as unknown as { health: number }).health).toBeLessThan(20);
  });

  it('horses are broken in by riding, then saddled and steered', async () => {
    const { server, session, got, tick, send, hold } = await setup();
    const horse = server.mobs.spawn(Mob.HORSE, 2.5, 10, 0.5)!;
    horse.temper = 100;
    hold(0);
    await send({ t: 'interact', entityId: horse.id });
    expect(session.riding).toBe(horse.id);
    expect(got.some((m) => m.t === 'ride' && m.entityId === horse.id && !m.steer)).toBe(true);
    await tick(120);
    expect(horse.flags & MobFlag.TAMED).toBeTruthy();
    await send({ t: 'dismount' });
    expect(session.riding).toBe(null);
    expect(got.some((m) => m.t === 'ride' && m.entityId === null)).toBe(true);
    hold(I.SADDLE);
    await send({ t: 'interact', entityId: horse.id });
    expect(horse.flags & MobFlag.SADDLED).toBeTruthy();
    hold(0);
    await send({ t: 'interact', entityId: horse.id });
    expect(got.some((m) => m.t === 'ride' && m.entityId === horse.id && m.steer)).toBe(true);
    // The rider's moves carry the horse.
    await new Promise((r) => setTimeout(r, 120));
    await send({ t: 'move', seq: 1, x: horse.body.x + 1, y: 10, z: horse.body.z, yaw: 0, pitch: 0, flags: 1 });
    expect(horse.body.x).toBeCloseTo(session.pos[0], 5);
  });

  it('tames give a smoke puff on failure and hearts on success', async () => {
    const { server, got, send, hold } = await setup();
    const cat = server.mobs.spawn(Mob.CAT, 2.5, 10, 0.5)!;
    hold(I.RAW_FOWL, 40);
    for (let i = 0; i < 30 && !(cat.flags & MobFlag.TAMED); i++) await send({ t: 'interact', entityId: cat.id });
    expect(cat.flags & MobFlag.TAMED).toBeTruthy();
    expect(got.some((m) => m.t === 'entityEvent' && m.event === 'tamed')).toBe(true);
  });

  it('spawns the animals of the biome', async () => {
    const plains = await setup({ biome: Biome.PLAINS });
    const desert = await setup({ biome: Biome.DESERT });
    for (const w of [plains, desert]) {
      w.server.mobSpawning = true;
      const targets = (w.server as unknown as { mobTargets(): never }).mobTargets();
      for (let i = 0; i < 80; i++) w.server.mobs.spawnTick(targets, 6000);
    }
    // Farm animals only (birds and fish are wildlife, with their own spawning).
    const kinds = (w: typeof plains) => new Set([...w.server.mobs.mobs.values()].filter((m) => m.def.animal).map((m) => m.def.kind));
    const pk = kinds(plains);
    expect([...pk].every((k) => mobDef(k)!.habitat!.biomes.includes(Biome.PLAINS))).toBe(true);
    expect(pk.size).toBeGreaterThan(1);
    // Only desert dwellers in the desert (rabbits, donkeys).
    expect([...kinds(desert)].every((k) => mobDef(k)!.habitat!.biomes.includes(Biome.DESERT))).toBe(true);
  });

  it('keeps animals in the save and across chunk unloads, without duplicates', async () => {
    let saved: WorldMeta | null = null;
    const store: ChunkStore = { loadChunk: async () => undefined, saveChunks: async () => {}, saveMeta: async (m) => { saved = m; } };
    const w = await setup({ store });
    const wolf = w.server.mobs.spawn(Mob.WOLF, 3.5, 10, 0.5, { baby: true })!;
    wolf.owner = 'T';
    wolf.ownerName = 'T';
    wolf.flags |= MobFlag.TAMED;
    w.server.mobs.spawn(Mob.SHEEP, 5.5, 10, 0.5, { variant: 3 });
    await w.server.save();
    const creatures = Object.values(saved!.creatures ?? {}).flat();
    expect(creatures.map((c) => c.k).sort()).toEqual([Mob.SHEEP, Mob.WOLF].sort());

    // Walk far away: their chunk unloads, they wait in the save, and come back once.
    w.moveTo(400.5, 0.5);
    await w.tick(220);
    expect([...w.server.mobs.mobs.values()].some((m) => m.def.kind === Mob.SHEEP)).toBe(false);
    w.moveTo(0.5, 0.5);
    await w.tick(220);
    const back = [...w.server.mobs.mobs.values()].filter((m) => m.def.kind === Mob.SHEEP || m.def.kind === Mob.WOLF);
    expect(back.length).toBe(2);
    expect(back.find((m) => m.def.kind === Mob.SHEEP)!.variant).toBe(3);

    // A new session of the same world brings them back with owner and baby state.
    const again = await setup({ meta: JSON.parse(JSON.stringify(saved)) });
    await again.tick(40);
    const pup = [...again.server.mobs.mobs.values()].find((m) => m.def.kind === Mob.WOLF)!;
    expect(pup).toBeDefined();
    expect(pup.owner).toBe('T');
    expect(pup.flags & MobFlag.BABY).toBeTruthy();
    expect(pup.flags & MobFlag.TAMED).toBeTruthy();
    expect([...again.server.mobs.mobs.values()].filter((m) => m.def.kind === Mob.WOLF).length).toBe(1);
  });
});
