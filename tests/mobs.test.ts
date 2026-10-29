import { describe, expect, it } from 'vitest';
import { B } from '../src/shared/blocks/registry';
import { GameMode, PROTOCOL_VERSION } from '../src/shared/constants';
import { Mob, monstersFor, pickSpawnKind } from '../src/shared/entities/mobs';
import { I, toolId } from '../src/shared/items/registry';
import type { ClientMsg, ServerMsg } from '../src/shared/protocol/messages';
import { Chunk } from '../src/shared/world/Chunk';
import { Biome } from '../src/shared/world/biomes';
import { computeChunkLight } from '../src/shared/world/lighting';
import { createLocalPair } from '../src/net/LocalTransport';
import { GameServer } from '../src/server/GameServer';
import { findPath, type PathWorld } from '../src/server/mobs/pathfind';
import type { ChunkGenerator } from '../src/server/ServerWorld';
import { newWorldMeta } from '../src/server/storage/WorldStorage';

function gridWorld(solid: (x: number, y: number, z: number) => boolean): PathWorld {
  return { blocked: solid, isWater: () => false };
}

describe('pathfinding', () => {
  it('walks around a wall', () => {
    // Floor at y=0, a wall at x=3 for z in -3..3.
    const w = gridWorld((x, y, z) => y <= 0 || (x === 3 && y <= 2 && Math.abs(z) <= 3));
    const path = findPath(w, [0, 1, 0], [6, 1, 0], 2)!;
    expect(path[path.length - 1]).toEqual([6, 1, 0]);
    expect(path.some(([x, , z]) => x === 3 && Math.abs(z) > 3)).toBe(true);
  });

  it('jumps up one block but not two, and drops down', () => {
    const step = gridWorld((x, y) => y <= 0 || (x >= 3 && y <= 1));
    expect(findPath(step, [0, 1, 0], [5, 2, 0], 2)!.at(-1)).toEqual([5, 2, 0]);
    const wall = gridWorld((x, y) => y <= 0 || (x >= 3 && y <= 2));
    const partial = findPath(wall, [0, 1, 0], [5, 3, 0], 2)!;
    expect(partial.at(-1)![0]).toBeLessThan(3); // gets as close as it can
    const down = gridWorld((x, y) => y <= (x >= 3 ? -2 : 0));
    expect(findPath(down, [0, 1, 0], [5, -1, 0], 2)!.at(-1)).toEqual([5, -1, 0]);
  });

  it('lets climbers go up walls', () => {
    const wall = gridWorld((x, y) => y <= 0 || (x >= 3 && y <= 3));
    expect(findPath(wall, [0, 1, 0], [5, 4, 0], 1, 400, true)!.at(-1)).toEqual([5, 4, 0]);
  });
});

// --- Host simulation -----------------------------------------------------------

function flatChunk(cx: number, cz: number): Chunk {
  const c = new Chunk(cx, cz);
  for (let i = 0; i < 10 * 256; i++) c.blocks[i] = i >= 9 * 256 ? B.GRASS : B.STONE;
  c.biomes.fill(Biome.PLAINS);
  c.recomputeHeights();
  computeChunkLight(c);
  return c;
}
const flatGen: ChunkGenerator = { concurrency: 64, generate: async (cx, cz) => flatChunk(cx, cz) };
const flush = () => new Promise((r) => setTimeout(r, 0));

interface Session {
  health: number;
  pos: number[];
  inventory: { slots: unknown[] };
}

async function setup(mode: number = GameMode.SURVIVAL, time = 1000) {
  const meta = newWorldMeta('mobs', 1, mode);
  meta.time = time;
  const server = new GameServer({ viewDistance: 3, meta }, flatGen);
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
  await tick(8);
  const send = async (m: ClientMsg) => {
    c.send(m);
    await flush();
  };
  return { server, session, got, tick, send };
}

describe('creatures on the host', () => {
  it('spawns hostiles only in the dark and herds on grass by day', async () => {
    const day = await setup(GameMode.SURVIVAL, 6000);
    for (let i = 0; i < 30; i++) day.server.mobs.spawnTick((day.server as unknown as { mobTargets(): never }).mobTargets(), day.server.time);
    const dayMobs = [...day.server.mobs.mobs.values()];
    expect(dayMobs.some((m) => m.def.hostile)).toBe(false);
    expect(dayMobs.some((m) => !m.def.hostile)).toBe(true);

    const night = await setup(GameMode.SURVIVAL, 18000);
    for (let i = 0; i < 10; i++) night.server.mobs.spawnTick((night.server as unknown as { mobTargets(): never }).mobTargets(), night.server.time);
    const nightMobs = [...night.server.mobs.mobs.values()];
    expect(nightMobs.some((m) => m.def.hostile)).toBe(true);
    for (const m of nightMobs) {
      const d = Math.hypot(m.body.x - 0.5, m.body.z - 0.5);
      expect(d).toBeGreaterThan(20);
    }
  });

  it('makes gloomwalkers the most common night creature, in groups', async () => {
    const counts = new Map<number, number>();
    const surface = monstersFor('surface');
    for (let i = 0; i < 1000; i++) {
      const k = pickSpawnKind(surface, i / 1000);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const most = [...counts].sort((a, b) => b[1] - a[1])[0][0];
    expect(most).toBe(Mob.GLOOMWALKER);
    expect(counts.size).toBe(surface.length);

    const night = await setup(GameMode.SURVIVAL, 18000);
    const mobs = night.server.mobs;
    const targets = () => (night.server as unknown as { mobTargets(): never }).mobTargets();
    for (let i = 0; i < 40; i++) mobs.spawnTick(targets(), night.server.time);
    const walkers = [...mobs.mobs.values()].filter((m) => m.def.kind === Mob.GLOOMWALKER);
    expect(walkers.length).toBeGreaterThan(3);
    expect([...mobs.mobs.values()].filter((m) => m.def.hostile).length).toBeLessThanOrEqual(20);
  });

  it('takes hits with knockback, flees, and drops its loot when killed', async () => {
    const { server, session, send, tick } = await setup();
    const m = server.mobs.spawn(Mob.SHEEP, 2.5, 10, 0.5)!;
    session.inventory.slots[0] = { id: toolId(2, 3), count: 1 }; // iron sword, 6 damage
    await send({ t: 'attack', entityId: m.id });
    expect(m.health).toBe(2);
    expect(m.body.vx).toBeGreaterThan(0); // pushed away from the player
    expect(m.fleeTicks).toBeGreaterThan(0);
    await tick(12);
    await new Promise((r) => setTimeout(r, 400)); // player attack cooldown
    const b = m.body;
    (server as unknown as { teleport(p: Session, pos: number[]): void }).teleport(session, [b.x - 1.5, 10, b.z]);
    await send({ t: 'attack', entityId: m.id });
    expect(m.deadTicks).toBeGreaterThan(0);
    expect([...server.items.all.values()].some((e) => e.item.id === I.FLEECE || e.item.id === I.RAW_MEAT)).toBe(true);
    await tick(20);
    expect(server.mobs.mobs.has(m.id)).toBe(false);
  });

  it('gloomwalkers chase and hurt survival players, with knockback', async () => {
    const { server, session, got, tick } = await setup(GameMode.SURVIVAL, 18000);
    server.mobs.spawn(Mob.GLOOMWALKER, 5.5, 10, 0.5);
    await tick(60);
    expect(session.health).toBeLessThan(20);
    expect(got.some((m) => m.t === 'knockback')).toBe(true);
  });

  it('ignore creative players', async () => {
    const { server, session, tick } = await setup(GameMode.CREATIVE, 18000);
    server.mobs.spawn(Mob.GLOOMWALKER, 2.5, 10, 0.5);
    await tick(40);
    expect(session.health).toBe(20);
  });

  it('sporecaps release a cloud that hurts nearby players', async () => {
    const { server, session, got, tick } = await setup(GameMode.SURVIVAL, 18000);
    server.mobs.spawn(Mob.SPORECAP, 2.5, 10, 0.5);
    await tick(60);
    expect(got.some((m) => m.t === 'entityEvent' && m.event === 'spores')).toBe(true);
    expect(session.health).toBeLessThan(20);
  });

  it('thornslingers shoot from a distance', async () => {
    const { server, session, got, tick } = await setup(GameMode.SURVIVAL, 18000);
    server.mobs.spawn(Mob.THORNSLINGER, 8.5, 10, 0.5);
    await tick(80);
    expect(got.some((m) => m.t === 'entitySpawn' && m.entity.kind === 'projectile')).toBe(true);
    expect(session.health).toBeLessThan(20);
  });

  it('burns gloomwalkers in daylight', async () => {
    const { server, tick } = await setup(GameMode.SURVIVAL, 6000);
    const m = server.mobs.spawn(Mob.GLOOMWALKER, 20.5, 10, 0.5)!;
    await tick(30);
    expect(m.health).toBeLessThan(20);
  });

  it('removes monsters far from every player', async () => {
    const { server, tick } = await setup();
    const m = server.mobs.spawn(Mob.GLOOMWALKER, 200.5, 10, 0.5)!;
    await tick(1);
    expect(server.mobs.mobs.has(m.id)).toBe(false);
  });
});
