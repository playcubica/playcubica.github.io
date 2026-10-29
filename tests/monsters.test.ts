import { describe, expect, it } from 'vitest';
import { B } from '../src/shared/blocks/registry';
import { GameMode, PROTOCOL_VERSION } from '../src/shared/constants';
import { ALL_MOBS, Mob, MobAnim, MobFlag, mobDef, monstersFor } from '../src/shared/entities/mobs';
import { I, toolId } from '../src/shared/items/registry';
import type { ClientMsg, ServerMsg } from '../src/shared/protocol/messages';
import { Chunk } from '../src/shared/world/Chunk';
import { Biome } from '../src/shared/world/biomes';
import { computeChunkLight } from '../src/shared/world/lighting';
import { createLocalPair } from '../src/net/LocalTransport';
import { GameServer } from '../src/server/GameServer';
import type { ChunkGenerator } from '../src/server/ServerWorld';
import { newWorldMeta } from '../src/server/storage/WorldStorage';
import { CREATURES } from '../src/client/render/monsterModels';
import type { AnimState, Bone, Pose } from '../src/client/render/mobModels';

// The monster ecosystem: every creature is complete (model, animator, rules), and each monster's
// own moves work on the host.

describe('creature registry is complete', () => {
  const allBoxes = (bones: Bone[]): Bone['boxes'] => bones.flatMap((b) => [...b.boxes, ...allBoxes(b.children ?? [])]);
  const allBones = (bones: Bone[]): Bone[] => bones.flatMap((b) => [b, ...allBones(b.children ?? [])]);

  it('gives every creature a model, an animator, drops and a way to appear', () => {
    for (const kind of ALL_MOBS) {
      const def = mobDef(kind)!;
      const species = CREATURES[kind];
      expect(species, `${def.key} has no model`).toBeDefined();
      for (const variant of species!.variants) {
        for (const flags of def.animal ? [0, MobFlag.BABY] : [0]) {
          const rig = species!.build({ variant, flags });
          const boxes = allBoxes(rig.bones);
          expect(boxes.length, def.key).toBeGreaterThan(2);
          for (const b of boxes) {
            expect(b.size.every((v) => v > 0) && [...b.at, ...b.color].every(Number.isFinite), `${def.key} box`).toBe(true);
          }
          const names = allBones(rig.bones).map((b) => b.name);
          expect(new Set(names).size, `${def.key} bone names`).toBe(names.length);
          // The animator runs for every state without touching missing bones.
          const pose: Pose = new Map(names.map((n) => [n, {
            obj: { rotation: { x: 0, y: 0, z: 0, set() {} }, position: { x: 0, y: 0, z: 0 }, scale: { setScalar() {} } },
            rest: [0, 0, 0], base: [0, 0, 0],
          }]));
          for (const anim of [0, ...Object.values(MobAnim)]) {
            const s: AnimState = { t: 1.3, dt: 0.016, walk: 2, speed: 3, vy: -2, anim, flags: flags | MobFlag.SITTING, seed: 0.4, slam: 0.2 };
            species!.animate(pose, s);
          }
        }
      }
      expect(typeof def.drops).toBe('function');
      // Bosses and traders have their own ways in; cats live in settlements; everyone else spawns naturally.
      const special = def.boss || def.trader || kind === Mob.CAT;
      if (!special) expect(!!def.habitat || (def.zones?.length ?? 0) > 0, `${def.key} never spawns`).toBe(true);
    }
  });

  it('places monsters in their own zones', () => {
    expect(monstersFor('deep')).toEqual([Mob.EMBER_MITE]);
    expect(monstersFor('water')).toEqual([Mob.MIREFIN]);
    expect(monstersFor('air')).toEqual([Mob.DUSKWING]);
    expect(monstersFor('cave')).toContain(Mob.CRAGBACK);
    expect(monstersFor('surface')).toContain(Mob.BRAMBLEHULK);
    for (const zone of ['surface', 'cave', 'deep', 'water', 'air'] as const) expect(monstersFor(zone)).not.toContain(Mob.MATRIARCH);
  });
});

// --- Host simulation -----------------------------------------------------------

/** Flat grass at y 9; chunk (2, 0) holds a pond (water y 4–9). */
function chunkAt(cx: number, cz: number): Chunk {
  const c = new Chunk(cx, cz);
  for (let i = 0; i < 10 * 256; i++) c.blocks[i] = i >= 9 * 256 ? B.GRASS : B.STONE;
  if (cx === 2 && cz === 0) for (let i = 4 * 256; i < 10 * 256; i++) c.blocks[i] = B.WATER;
  c.biomes.fill(Biome.PLAINS);
  c.recomputeHeights();
  computeChunkLight(c);
  return c;
}
const gen: ChunkGenerator = { concurrency: 64, generate: async (cx, cz) => chunkAt(cx, cz) };
const flush = () => new Promise((r) => setTimeout(r, 0));

interface Session {
  health: number;
  pos: number[];
  yaw: number;
  inventory: { slots: Array<{ id: number; count: number } | null>; selected: number };
}

async function setup(time = 18000, at: number[] = [0.5, 10, 0.5]) {
  const meta = newWorldMeta('monsters', 1, GameMode.SURVIVAL);
  meta.time = time;
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
    setBlockAndBroadcast(x: number, y: number, z: number, raw: number): void;
  };
  const session = [...priv.players.values()][0];
  priv.teleport(session, at);
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
  return { server, session, got, tick, send, priv };
}

describe('monsters on the host', () => {
  it('duskwings circle overhead, then dive at you', async () => {
    const { server, session, tick } = await setup();
    const w = server.mobs.spawn(Mob.DUSKWING, 4.5, 18, 0.5)!;
    expect(w.body.flying && w.body.hover).toBe(true);
    let dived = false;
    for (let i = 0; i < 30 && session.health === 20; i++) {
      await tick(20);
      dived ||= w.mode === 'dive' || w.mode === 'climb';
    }
    expect(dived).toBe(true);
    expect(session.health).toBeLessThan(20);
    // It never landed.
    expect(w.body.flying).toBe(true);
  });

  it('mirefins bite swimmers, and dry out on land', async () => {
    const { server, session, tick } = await setup(6000, [36.5, 6, 6.5]);
    const fin = server.mobs.spawn(Mob.MIREFIN, 42.5, 6, 10.5)!;
    await tick(200);
    expect(fin.body.inWater).toBe(true);
    expect(session.health).toBeLessThan(20);
    // Within 32 blocks of the player (farther ones may despawn at random), away from the pond.
    const stranded = server.mobs.spawn(Mob.MIREFIN, 22.5, 10, 6.5)!;
    await tick(120);
    expect(stranded.health).toBeLessThan(12);
  });

  it("a cragback's shell blocks blows from the front, but not a pickaxe or a blow from behind", async () => {
    const { server, session, send } = await setup(6000);
    const wait = () => new Promise((r) => setTimeout(r, 420));
    const hitWith = async (tool: number, from: number[], yaw: number) => {
      const m = server.mobs.spawn(Mob.CRAGBACK, 2.5, 10, 0.5)!;
      m.yaw = yaw;
      session.pos = from;
      session.inventory.slots[0] = { id: tool, count: 1 };
      session.inventory.selected = 0;
      await wait();
      await send({ t: 'attack', entityId: m.id });
      return m;
    };
    const facing = Math.atan2(1, 0); // looks towards -x, at the player
    const sword = toolId(2, 3);
    const front = await hitWith(sword, [0.5, 10, 0.5], facing);
    expect(front.health).toBeGreaterThan(22);
    expect(front.stun).toBeGreaterThan(0);
    const pick = await hitWith(toolId(2, 0), [0.5, 10, 0.5], facing);
    expect(pick.health).toBe(24 - 4); // cracks the shell: double damage
    const back = await hitWith(sword, [4.5, 10, 0.5], facing);
    expect(back.health).toBe(24 - 6);
  });

  it('shades blink to just behind you', async () => {
    const { server, session, tick } = await setup();
    session.yaw = 0; // looking towards -z: behind is +z
    const s = server.mobs.spawn(Mob.SHADE, 0.5, 10, -9.5)!;
    s.timers[0] = 1;
    await tick(2);
    expect(s.body.z).toBeGreaterThan(session.pos[2]);
    expect(Math.hypot(s.body.x - session.pos[0], s.body.z - session.pos[2])).toBeLessThan(3.5);
  });

  it('bramblehulks wind up and slam the ground around them; their back is soft', async () => {
    const { server, session, got, tick } = await setup();
    const hulk = server.mobs.spawn(Mob.BRAMBLEHULK, 2.5, 10, 0.5)!;
    await tick(60);
    expect(got.some((m) => m.t === 'entityEvent' && m.event === 'slam')).toBe(true);
    expect(session.health).toBeLessThan(20);
    const before = hulk.health;
    hulk.yaw = 0; // facing -z
    hulk.hurtTicks = 0;
    server.mobs.hit(hulk.id, 5, [hulk.body.x, 10, hulk.body.z + 3], { player: 1 });
    expect(before - hulk.health).toBe(10);
  });

  it('the ember altar wakes the matriarch in the Ember Deep only; she fights in phases and drops her heart', async () => {
    const deep = 1_000_000.5;
    const { server, session, got, tick, send, priv } = await setup(6000, [deep, 10, 0.5]);
    await tick(40);
    session.inventory.slots[0] = { id: I.LUMEN_DUST, count: 4 };
    session.inventory.selected = 0;
    priv.setBlockAndBroadcast(1_000_003, 10, 0, B.EMBER_ALTAR);
    await send({ t: 'useBlock', x: 1_000_003, y: 10, z: 0 });
    const boss = [...server.mobs.mobs.values()].find((m) => m.def.kind === Mob.MATRIARCH)!;
    expect(boss).toBeDefined();
    expect(server.world.getBlock(1_000_003, 10, 0)).toBe(B.EMBERSTONE);
    await tick(10);
    expect(got.some((m) => m.t === 'bossBar' && m.id === boss.id && m.max === 300)).toBe(true);
    // A second altar does nothing while she is awake.
    priv.setBlockAndBroadcast(1_000_004, 10, 3, B.EMBER_ALTAR);
    await send({ t: 'useBlock', x: 1_000_004, y: 10, z: 3 });
    expect([...server.mobs.mobs.values()].filter((m) => m.def.kind === Mob.MATRIARCH).length).toBe(1);
    // Stunned, she takes extra damage.
    boss.stun = 40;
    boss.hurtTicks = 0;
    server.mobs.hit(boss.id, 10, [boss.body.x + 3, 10, boss.body.z], { player: 1 });
    expect(boss.health).toBe(275);
    // From half health she calls mites.
    boss.stun = 0;
    boss.health = 140;
    boss.timers[2] = 1;
    await tick(4);
    expect(boss.phase).toBe(2);
    expect([...server.mobs.mobs.values()].filter((m) => m.def.kind === Mob.EMBER_MITE).length).toBeGreaterThanOrEqual(3);
    // Defeat: the heart drops and the bar goes away.
    boss.hurtTicks = 0;
    server.mobs.hit(boss.id, 999, [boss.body.x + 3, 10, boss.body.z], { player: 1 });
    await tick(10);
    expect([...server.items.all.values()].some((e) => e.item.id === I.MATRIARCH_HEART)).toBe(true);
    expect(got.some((m) => m.t === 'bossBar' && m.id === null)).toBe(true);
  });

  it('the ember altar refuses to work on the surface', async () => {
    const { server, session, send, priv } = await setup(6000);
    session.inventory.slots[0] = { id: I.LUMEN_DUST, count: 1 };
    session.inventory.selected = 0;
    priv.setBlockAndBroadcast(3, 10, 0, B.EMBER_ALTAR);
    await send({ t: 'useBlock', x: 3, y: 10, z: 0 });
    expect([...server.mobs.mobs.values()].some((m) => m.def.kind === Mob.MATRIARCH)).toBe(false);
    expect(server.world.getBlock(3, 10, 0)).toBe(B.EMBER_ALTAR);
  });

  it('the matriarch crashes into walls and is stunned', async () => {
    const deep = 1_000_000.5;
    const { server, tick, priv } = await setup(6000, [deep, 10, 0.5]);
    await tick(40);
    for (let y = 10; y < 14; y++) for (let z = -4; z <= 4; z++) priv.setBlockAndBroadcast(1_000_012, y, z, B.STONE);
    const boss = server.mobs.spawn(Mob.MATRIARCH, 1_000_006.5, 10, 0.5)!;
    boss.dash = 40;
    boss.dashDir = [1, 0];
    await tick(40);
    expect(boss.stun).toBeGreaterThan(0);
  });
});
