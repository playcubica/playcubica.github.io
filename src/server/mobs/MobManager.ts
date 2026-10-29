import { B, OPAQUE } from '../../shared/blocks/registry';
import {
  animalsFor, BABY_SCALE, BREED_COOLDOWN, GROW_TICKS, HOSTILE_MOBS, LOVE_TICKS, Mob, MOB_ATTACK_TICKS, MOB_REACH, MobAnim, MobFlag,
  mobDef, pickSpawnKind, SAVED_FLAGS, SPORE_DAMAGE, SPORE_FUSE_TICKS, SPORE_RADIUS, type MobDef, type SavedMob,
} from '../../shared/entities/mobs';
import { I, type ItemStack } from '../../shared/items/registry';
import { PlayerBody, type MoveInput, type WorldQuery } from '../../shared/physics/PlayerBody';
import { raycast } from '../../shared/physics/raycast';
import type { EntityInfo } from '../../shared/protocol/messages';
import { daylight } from '../../shared/time';
import { idx } from '../../shared/world/Chunk';
import type { ServerWorld } from '../ServerWorld';
import { findPath, standable, type Cell, type PathWorld } from './pathfind';

// Creatures, simulated by the host at 20 ticks per second: monsters (hunt players at night),
// animals (wander, graze, follow food, breed, grow up, lay eggs, get sheared/milked/tamed/ridden;
// saved with the world) and settlement traders.

export { MobAnim };

const DT = 1 / 20;
const DEATH_TICKS = 16;
const HURT_TICKS = 10;
const TARGET_RANGE = 16;
const DESPAWN_FAR = 80;
const SPAWN_MIN = 24;
const SPAWN_MAX = 44;
/** Hostiles further than this from every player may despawn at random (so new ones appear nearer). */
const DESPAWN_IDLE = 32;
/** Hostile caps: per player and in total. */
const HOSTILE_PER_PLAYER = 20;
const HOSTILE_MAX = 50;
/** Animals: no new ones appear while this many are already within ANIMAL_AREA of the player. */
const ANIMALS_NEAR = 10;
const ANIMAL_AREA = 48;
const ANIMALS_MAX = 250;
const THORN_SPEED = 16;
const THORN_GRAVITY = 6;
/** Pets: walk after their owner beyond this, jump to them beyond that. */
const FOLLOW_START = 6;
const FOLLOW_TELEPORT = 14;
const TEMPT_RANGE = 10;
const ANGER_TICKS = 600;

export interface MobTarget {
  readonly id: number;
  /** Save key (owner identity of pets). */
  readonly key: string;
  readonly name: string;
  readonly pos: readonly number[];
  readonly alive: boolean;
  readonly creative: boolean;
  readonly sneaking: boolean;
  /** Item id in hand (animals follow their food). */
  readonly held: number;
  /** Deals damage from a creature; `from` is where it came from (for knockback). */
  hurt(amount: number, cause: string, from: readonly number[], push?: number): void;
}

/** Who right-clicked a creature, and what they hold. */
export interface Interactor {
  readonly id: number;
  readonly key: string;
  readonly name: string;
  readonly pos: readonly number[];
  readonly held: ItemStack | null;
  readonly creative: boolean;
}

/** What a right-click did to the player's hand. */
export type InteractResult =
  | { kind: 'consume' }
  | { kind: 'replace'; stack: ItemStack }
  | { kind: 'give'; items: ItemStack[] }
  | { kind: 'ride' }
  | { kind: 'none' };

export interface MobEntity {
  id: number;
  def: MobDef;
  body: PlayerBody;
  yaw: number;
  health: number;
  hurtTicks: number;
  deadTicks: number;
  attackCooldown: number;
  path: Cell[] | null;
  pathGoal: Cell | null;
  pathAge: number;
  wanderTimer: number;
  fleeTicks: number;
  fleeFrom: [number, number];
  targetId: number | null;
  fuse: number;
  sporeCooldown: number;
  shootCooldown: number;
  anim: number;
  sent: [number, number, number, number, number];
  /** Look: trader profession, fleece colour, coat… (see MobDef.variant). */
  variant?: number;
  home?: [number, number];
  flags: number;
  /** Baby age in ticks (grows up at GROW_TICKS). */
  age: number;
  love: number;
  breedCooldown: number;
  owner: string | null;
  ownerName: string | null;
  eggTimer: number;
  /** Horses: rises with feeding and failed rides; taming succeeds with chance temper %. */
  temper: number;
  riderId: number | null;
  rideTicks: number;
  ramCooldown: number;
  ramTicks: number;
  ramDir: [number, number];
  /** Eating grass / sleeping / other short actions (ticks left). */
  actionTicks: number;
  angerTicks: number;
  angryPlayer: number | null;
  angryMob: number | null;
}

interface Thorn {
  id: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
}

export type MobEventKind = 'hurt' | 'death' | 'spores' | 'love' | 'tamed' | 'smoke' | 'baby' | 'shear' | 'ram';

export interface MobEvents {
  spawned(info: EntityInfo): void;
  despawned(id: number): void;
  moved(data: Array<{ id: number; x: number; y: number; z: number; yaw: number; anim: number }>): void;
  /** Flags, look or owner changed. */
  state(info: EntityInfo): void;
  event(id: number, event: MobEventKind, x: number, z: number): void;
  drops(items: ItemStack[], x: number, y: number, z: number): void;
  /** A creature changes the world (a sheep eats grass). */
  setBlock(x: number, y: number, z: number, id: number): void;
  /** A horse threw its rider off. */
  dismounted(riderId: number): void;
}

const PERSISTENT = (d: MobDef) => !!d.animal && !d.hostile;

export class MobManager {
  readonly mobs = new Map<number, MobEntity>();
  private readonly thorns = new Map<number, Thorn>();
  private readonly query: WorldQuery;
  private readonly pathWorld: PathWorld;

  constructor(private readonly world: ServerWorld, private readonly nextId: () => number, private readonly events: MobEvents) {
    this.query = {
      boxes: (x, y, z) => world.boxes(x, y, z),
      isWater: (x, y, z) => world.getBlock(x, y, z) === B.WATER,
      getRaw: (x, y, z) => world.getRaw(x, y, z),
    };
    this.pathWorld = {
      blocked: (x, y, z) => world.boxes(x, y, z) !== null,
      isWater: (x, y, z) => world.getBlock(x, y, z) === B.WATER,
    };
  }

  static info(m: MobEntity): EntityInfo {
    return {
      id: m.id, kind: 'mob', mob: m.def.kind, x: m.body.x, y: m.body.y, z: m.body.z, yaw: m.yaw, variant: m.variant,
      flags: m.flags || undefined, owner: m.ownerName ?? undefined,
    };
  }

  private biomeAt(x: number, z: number): number {
    const c = this.world.getChunk(Math.floor(x) >> 4, Math.floor(z) >> 4);
    return c ? c.biomes[(Math.floor(x) & 15) | ((Math.floor(z) & 15) << 4)] : 0;
  }

  spawn(
    kind: number, x: number, y: number, z: number,
    extra: { variant?: number; home?: [number, number]; flags?: number; baby?: boolean } = {},
  ): MobEntity | null {
    const def = mobDef(kind);
    if (!def) return null;
    const body = new PlayerBody();
    body.x = x;
    body.y = y;
    body.z = z;
    body.walkSpeed = def.speed;
    body.climber = !!def.climber;
    body.slowFall = !!def.slowFall;
    if (kind === Mob.GOAT) body.jumpVelocity = 10.5;
    const variant = extra.variant ?? def.variant?.(this.biomeAt(x, z), Math.random);
    const m: MobEntity = {
      id: this.nextId(), def, body, yaw: Math.random() * Math.PI * 2, health: def.health, hurtTicks: 0, deadTicks: 0,
      attackCooldown: 0, path: null, pathGoal: null, pathAge: 0, wanderTimer: Math.floor(Math.random() * 100), fleeTicks: 0,
      fleeFrom: [x, z], targetId: null, fuse: 0, sporeCooldown: 0, shootCooldown: 40, anim: 0, sent: [x, y, z, 0, 0],
      variant, home: extra.home, flags: (extra.flags ?? 0) | (extra.baby ? MobFlag.BABY : 0), age: 0, love: 0, breedCooldown: 0,
      owner: null, ownerName: null, eggTimer: 6000 + Math.floor(Math.random() * 6000), temper: 0, riderId: null, rideTicks: 0,
      ramCooldown: 600 + Math.floor(Math.random() * 1800), ramTicks: 0, ramDir: [0, 0], actionTicks: 0, angerTicks: 0,
      angryPlayer: null, angryMob: null,
    };
    this.applySize(m);
    this.mobs.set(m.id, m);
    this.events.spawned(MobManager.info(m));
    return m;
  }

  private applySize(m: MobEntity): void {
    const s = m.flags & MobFlag.BABY ? BABY_SCALE : 1;
    m.body.width = m.def.width * s;
    m.body.height = m.def.height * s;
  }

  private setFlags(m: MobEntity, flags: number): void {
    if (flags === m.flags) return;
    const sized = (flags ^ m.flags) & MobFlag.BABY;
    m.flags = flags;
    if (sized) this.applySize(m);
    this.events.state(MobManager.info(m));
  }

  private remove(id: number): void {
    if (this.mobs.delete(id) || this.thorns.delete(id)) this.events.despawned(id);
  }

  // --- Saving ------------------------------------------------------------------

  static save(m: MobEntity): SavedMob {
    const b = m.body;
    const s: SavedMob = { k: m.def.kind, x: b.x, y: b.y, z: b.z, yaw: m.yaw, hp: m.health, f: m.flags & SAVED_FLAGS };
    if (m.variant !== undefined) s.v = m.variant;
    if (m.flags & MobFlag.BABY) s.age = m.age;
    if (m.owner) {
      s.o = m.owner;
      s.on = m.ownerName ?? '';
    }
    if (m.temper) s.temper = m.temper;
    return s;
  }

  restore(s: SavedMob): MobEntity | null {
    if (!mobDef(s.k) || ![s.x, s.y, s.z].every(Number.isFinite)) return null;
    const m = this.spawn(s.k, s.x, s.y, s.z, { variant: s.v, flags: s.f & SAVED_FLAGS });
    if (!m) return null;
    m.yaw = s.yaw || 0;
    m.health = Math.max(1, Math.min(m.def.health, s.hp || m.def.health));
    m.age = s.age ?? 0;
    m.owner = s.o ?? null;
    m.ownerName = s.on ?? null;
    m.temper = s.temper ?? 0;
    if (m.owner) this.events.state(MobManager.info(m));
    return m;
  }

  /** Animals that are alive right now, as saves (for the world file). */
  saveAll(): SavedMob[] {
    return [...this.mobs.values()].filter((m) => PERSISTENT(m.def) && m.deadTicks === 0).map(MobManager.save);
  }

  /** Removes everything where drop() is true (unloaded chunks); returns the animals among them as saves. */
  removeWhere(drop: (x: number, z: number) => boolean): SavedMob[] {
    const kept: SavedMob[] = [];
    for (const m of [...this.mobs.values()]) {
      if (!drop(m.body.x, m.body.z) || m.riderId !== null) continue;
      if (PERSISTENT(m.def) && m.deadTicks === 0) kept.push(MobManager.save(m));
      this.remove(m.id);
    }
    for (const t of [...this.thorns.values()]) if (drop(t.x, t.z)) this.remove(t.id);
    return kept;
  }

  inChunk(cx: number, cz: number): EntityInfo[] {
    const out: EntityInfo[] = [];
    for (const m of this.mobs.values()) {
      if (Math.floor(m.body.x) >> 4 === cx && Math.floor(m.body.z) >> 4 === cz && m.deadTicks === 0) out.push(MobManager.info(m));
    }
    return out;
  }

  countNear(x: number, z: number, r: number, test: (m: MobEntity) => boolean): number {
    let n = 0;
    for (const m of this.mobs.values()) if (m.deadTicks === 0 && test(m) && Math.hypot(m.body.x - x, m.body.z - z) < r) n++;
    return n;
  }

  tradersNear(x: number, z: number, r: number): number {
    return this.countNear(x, z, r, (m) => !!m.def.trader);
  }

  hostilesNear(x: number, y: number, z: number, r: number): number {
    let n = 0;
    for (const m of this.mobs.values()) {
      if (m.def.hostile && m.deadTicks === 0 && (m.body.x - x) ** 2 + (m.body.y - y) ** 2 + (m.body.z - z) ** 2 < r * r) n++;
    }
    return n;
  }

  /** Hostile creatures within `h` blocks horizontally and `v` vertically (the bed's sleep check). */
  hostilesAround(x: number, y: number, z: number, h: number, v: number): number {
    let n = 0;
    for (const m of this.mobs.values()) {
      if (m.def.hostile && m.deadTicks === 0 && Math.abs(m.body.x - x) <= h && Math.abs(m.body.z - z) <= h && Math.abs(m.body.y - y) <= v) n++;
    }
    return n;
  }

  // --- Damage ------------------------------------------------------------------

  /**
   * Something hit a creature (`by`: the attacking player or creature, if any). Returns false if it
   * could not be hurt right now.
   */
  hit(mobId: number, damage: number, from: readonly number[], by?: { player?: number; playerKey?: string; mob?: number }): boolean {
    const m = this.mobs.get(mobId);
    if (!m || m.deadTicks > 0 || m.hurtTicks > 0) return false;
    m.health -= damage;
    m.hurtTicks = HURT_TICKS;
    const dx = m.body.x - from[0];
    const dz = m.body.z - from[2];
    const len = Math.hypot(dx, dz) || 1;
    if (m.riderId === null) m.body.push((dx / len) * 6, 5, (dz / len) * 6);
    this.events.event(m.id, 'hurt', m.body.x, m.body.z);
    if (m.health <= 0) {
      this.kill(m);
      return true;
    }
    if (m.flags & MobFlag.SITTING) this.setFlags(m, m.flags & ~MobFlag.SITTING);
    if (m.def.retaliates && !(by?.playerKey && by.playerKey === m.owner)) {
      // Wolves fight back, and the wild ones of the pack join in.
      this.anger(m, by);
      if (!(m.flags & MobFlag.TAMED)) {
        for (const o of this.mobs.values()) {
          if (o !== m && o.def.kind === m.def.kind && !(o.flags & MobFlag.TAMED) && Math.hypot(o.body.x - m.body.x, o.body.z - m.body.z) < 12) this.anger(o, by);
        }
      }
    } else if (!m.def.hostile && m.ramTicks === 0) {
      m.fleeTicks = m.def.trader ? 30 : 80;
      m.fleeFrom = [from[0], from[2]];
      m.path = null;
    }
    return true;
  }

  private anger(m: MobEntity, by?: { player?: number; mob?: number }): void {
    if (!by || (by.player === undefined && by.mob === undefined)) return;
    m.angryPlayer = by.player ?? null;
    m.angryMob = by.mob ?? null;
    m.angerTicks = ANGER_TICKS;
    this.setFlags(m, m.flags | MobFlag.ANGRY);
  }

  private kill(m: MobEntity): void {
    m.deadTicks = 1;
    if (m.riderId !== null) this.dismount(m);
    this.events.event(m.id, 'death', m.body.x, m.body.z);
    const drops = m.flags & MobFlag.BABY ? [] : m.def.drops(Math.random, m.flags);
    if (m.flags & MobFlag.SADDLED) drops.push({ id: I.SADDLE, count: 1 });
    this.events.drops(drops, Math.floor(m.body.x), Math.floor(m.body.y), Math.floor(m.body.z));
  }

  /** Environmental damage (cactus) to every creature whose box `touches` says yes; no knockback. */
  hurtWhere(touches: (min: number[], max: number[]) => boolean, damage: number): void {
    for (const m of this.mobs.values()) {
      if (m.deadTicks > 0 || m.hurtTicks > 0 || m.def.trader) continue;
      const b = m.body;
      const h = b.width / 2 + 0.01;
      if (!touches([b.x - h, b.y - 0.01, b.z - h], [b.x + h, b.y + b.height, b.z + h])) continue;
      m.health -= damage;
      m.hurtTicks = HURT_TICKS;
      this.events.event(m.id, 'hurt', b.x, b.z);
      if (m.health <= 0) this.kill(m);
    }
  }

  /** A player attacked a creature: their tamed wolves join in. */
  ownerAttacks(ownerKey: string, mobId: number): void {
    const target = this.mobs.get(mobId);
    if (!target || target.owner === ownerKey) return;
    for (const m of this.mobs.values()) {
      if (m.owner === ownerKey && m.def.retaliates && !(m.flags & MobFlag.SITTING)) this.anger(m, { mob: mobId });
    }
  }

  /** A creature (or player) hurt a player: that player's tamed wolves defend them. */
  ownerHurt(ownerKey: string, by: { mob?: number; player?: number }): void {
    for (const m of this.mobs.values()) {
      if (m.owner === ownerKey && m.def.retaliates && !(m.flags & MobFlag.SITTING) && m.id !== by.mob) this.anger(m, by);
    }
  }

  // --- Riding ------------------------------------------------------------------

  mount(m: MobEntity, riderId: number): void {
    m.riderId = riderId;
    m.rideTicks = 0;
    m.path = null;
    this.setFlags(m, m.flags | MobFlag.RIDDEN);
  }

  dismount(m: MobEntity): void {
    const rider = m.riderId;
    m.riderId = null;
    this.setFlags(m, m.flags & ~MobFlag.RIDDEN);
    if (rider !== null) this.events.dismounted(rider);
  }

  /** The rider moved (the host checked the move): the mount goes along. */
  carry(m: MobEntity, x: number, y: number, z: number, yaw: number): void {
    m.body.x = x;
    m.body.y = y;
    m.body.z = z;
    m.body.vx = m.body.vy = m.body.vz = 0;
    m.yaw = yaw;
  }

  /** Can this rider steer the mount? (tamed and saddled) */
  static steerable(m: MobEntity): boolean {
    return (m.flags & (MobFlag.TAMED | MobFlag.SADDLED)) === (MobFlag.TAMED | MobFlag.SADDLED);
  }

  // --- Right-click ---------------------------------------------------------------

  interact(m: MobEntity, who: Interactor): InteractResult | null {
    const a = m.def.animal;
    if (!a || m.deadTicks > 0 || m.riderId !== null) return null;
    const held = who.held?.id ?? 0;
    const baby = (m.flags & MobFlag.BABY) !== 0;
    const tamed = (m.flags & MobFlag.TAMED) !== 0;
    const b = m.body;

    if (a.shear && held === I.SHEARS && !baby && !(m.flags & MobFlag.SHEARED)) {
      this.setFlags(m, m.flags | MobFlag.SHEARED);
      this.events.event(m.id, 'shear', b.x, b.z);
      return { kind: 'give', items: [{ id: I.FLEECE, count: 1 + Math.floor(Math.random() * 3) }] };
    }
    if (a.milk && held === I.BUCKET && !baby) return { kind: 'replace', stack: { id: I.MILK_BUCKET, count: 1 } };
    if (m.def.kind === Mob.HORSE && held === I.SADDLE && tamed && !baby && !(m.flags & MobFlag.SADDLED)) {
      this.setFlags(m, m.flags | MobFlag.SADDLED);
      return { kind: 'consume' };
    }

    if (a.food.includes(held)) {
      const tame = a.tame;
      if (tame && tame !== 'ride' && !tamed && tame.items.includes(held) && !(m.flags & MobFlag.ANGRY)) {
        if (Math.random() < tame.chance || who.creative) {
          m.owner = who.key;
          m.ownerName = who.name;
          m.health = m.def.health;
          m.path = null;
          this.setFlags(m, m.flags | MobFlag.TAMED | MobFlag.SITTING);
          this.events.state(MobManager.info(m));
          this.events.event(m.id, 'tamed', b.x, b.z);
        } else {
          this.events.event(m.id, 'smoke', b.x, b.z);
        }
        return { kind: 'consume' };
      }
      if (m.health < m.def.health && (tamed || tame === undefined)) {
        m.health = Math.min(m.def.health, m.health + 2);
        this.events.event(m.id, 'love', b.x, b.z);
        return { kind: 'consume' };
      }
      if (baby) {
        m.age += GROW_TICKS / 10;
        this.events.event(m.id, 'love', b.x, b.z);
        return { kind: 'consume' };
      }
      if (tame === 'ride' && !tamed) {
        m.temper = Math.min(100, m.temper + 5);
        this.events.event(m.id, 'love', b.x, b.z);
        return { kind: 'consume' };
      }
      // Pets and horses breed only once tamed.
      if (m.love === 0 && m.breedCooldown === 0 && (!tame || tamed)) {
        m.love = LOVE_TICKS;
        this.setFlags(m, m.flags | MobFlag.LOVE);
        this.events.event(m.id, 'love', b.x, b.z);
        return { kind: 'consume' };
      }
      return null;
    }

    if (m.def.kind === Mob.HORSE && !baby) {
      this.mount(m, who.id);
      return { kind: 'ride' };
    }
    if (tamed && m.owner === who.key && a.tame && a.tame !== 'ride') {
      this.setFlags(m, m.flags ^ MobFlag.SITTING);
      m.path = null;
      return { kind: 'none' };
    }
    return null;
  }

  // --- Simulation ----------------------------------------------------------------

  tick(players: MobTarget[], time: number, tickCount: number): void {
    const moved: Array<{ id: number; x: number; y: number; z: number; yaw: number; anim: number }> = [];
    const light = daylight(time);
    for (const m of [...this.mobs.values()]) {
      if (m.deadTicks > 0) {
        if (++m.deadTicks > DEATH_TICKS) this.remove(m.id);
        continue;
      }
      if (m.hurtTicks > 0) m.hurtTicks--;
      const b = m.body;
      let nearest = Infinity;
      for (const p of players) nearest = Math.min(nearest, Math.hypot(p.pos[0] - b.x, p.pos[2] - b.z));
      // Animals and traders stay (animals are saved when their ground unloads); monsters wander off.
      if (b.y < -16 || (m.def.hostile && (nearest > DESPAWN_FAR || (nearest > DESPAWN_IDLE && Math.random() < 1 / 600)))) {
        this.remove(m.id);
        continue;
      }
      if (m.def.sunSensitive && light > 0.6 && tickCount % 20 === 0 && this.skyAt(b.x, b.y + b.height, b.z) >= 12) {
        this.hit(m.id, 2, [b.x, b.y, b.z]);
        if (m.deadTicks > 0) continue;
      }
      if (m.def.animal) this.live(m, players);
      if (m.deadTicks > 0) continue;
      if (m.riderId !== null) {
        this.ridden(m, players);
      } else {
        const input = this.think(m, players, light);
        b.step(this.query, input, DT);
        if (Math.abs(input.yaw - m.yaw) > 1e-3) {
          let d = input.yaw - m.yaw;
          d = Math.atan2(Math.sin(d), Math.cos(d));
          m.yaw += d * 0.5;
        }
      }
      const [sx, sy, sz, syaw, sanim] = m.sent;
      if (Math.abs(b.x - sx) + Math.abs(b.y - sy) + Math.abs(b.z - sz) > 0.02 || Math.abs(m.yaw - syaw) > 0.05 || m.anim !== sanim) {
        if (tickCount % 2 === 0) {
          m.sent = [b.x, b.y, b.z, m.yaw, m.anim];
          moved.push({ id: m.id, x: b.x, y: b.y, z: b.z, yaw: m.yaw, anim: m.anim });
        }
      }
    }
    this.tickThorns(players);
    if (moved.length > 0) this.events.moved(moved);
  }

  /** Animal timers: growing up, love, eggs, regrowing fleece, anger. */
  private live(m: MobEntity, players: MobTarget[]): void {
    const b = m.body;
    if (m.flags & MobFlag.BABY && ++m.age >= GROW_TICKS) {
      m.age = 0;
      this.setFlags(m, m.flags & ~MobFlag.BABY);
    }
    if (m.breedCooldown > 0) m.breedCooldown--;
    if (m.love > 0 && --m.love === 0) this.setFlags(m, m.flags & ~MobFlag.LOVE);
    if (m.angerTicks > 0 && --m.angerTicks === 0) {
      m.angryPlayer = m.angryMob = null;
      this.setFlags(m, m.flags & ~MobFlag.ANGRY);
    }
    if (m.def.animal?.eggs && !(m.flags & MobFlag.BABY) && --m.eggTimer <= 0) {
      m.eggTimer = 6000 + Math.floor(Math.random() * 6000);
      this.events.drops([{ id: I.EGG, count: 1 }], Math.floor(b.x), Math.floor(b.y), Math.floor(b.z));
    }
    if (m.riderId !== null && !(m.flags & MobFlag.TAMED) && ++m.rideTicks > 40 + Math.floor(Math.random() * 60)) {
      // Breaking in a horse: it accepts the rider, or throws them off and gets a bit used to it.
      const rider = players.find((p) => p.id === m.riderId);
      if (Math.random() * 100 < m.temper && rider) {
        m.owner = rider.key;
        m.ownerName = rider.name;
        this.setFlags(m, m.flags | MobFlag.TAMED);
        this.events.state(MobManager.info(m));
        this.events.event(m.id, 'tamed', b.x, b.z);
      } else {
        m.temper = Math.min(100, m.temper + 5);
        this.events.event(m.id, 'smoke', b.x, b.z);
        this.dismount(m);
        b.push(0, 4, 0);
      }
      m.rideTicks = 0;
    }
  }

  private ridden(m: MobEntity, players: MobTarget[]): void {
    const rider = players.find((p) => p.id === m.riderId);
    if (!rider || !rider.alive) {
      this.dismount(m);
      return;
    }
    m.anim = 0;
  }

  // --- AI ----------------------------------------------------------------------

  private think(m: MobEntity, players: MobTarget[], light: number): MoveInput {
    const b = m.body;
    const input: MoveInput = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw: m.yaw };
    m.anim = 0;
    if (m.attackCooldown > 0) m.attackCooldown--;
    if (m.sporeCooldown > 0) m.sporeCooldown--;
    if (m.shootCooldown > 0) m.shootCooldown--;
    b.walkSpeed = m.def.speed;

    if (m.def.hostile) return this.thinkHostile(m, players, input);
    if (m.def.animal) return this.thinkAnimal(m, players, input, light);

    // Traders drift back home when they wander too far.
    if (m.home && m.fleeTicks === 0 && Math.hypot(b.x - m.home[0], b.z - m.home[1]) > 10) {
      this.walkTo(m, input, [Math.floor(m.home[0]), Math.floor(b.y), Math.floor(m.home[1])]);
      return input;
    }
    if (this.flee(m, input)) return input;
    this.wander(m, input, 0.008);
    return input;
  }

  private flee(m: MobEntity, input: MoveInput): boolean {
    if (m.fleeTicks <= 0) return false;
    m.fleeTicks--;
    m.body.walkSpeed = m.def.speed * 2.2;
    m.anim |= MobAnim.FLEE;
    this.steerAway(m, input, m.fleeFrom[0], m.fleeFrom[1]);
    if (m.def.animal?.hops) input.jump ||= m.body.onGround;
    return true;
  }

  private thinkHostile(m: MobEntity, players: MobTarget[], input: MoveInput): MoveInput {
    const b = m.body;
    const target = this.pickTarget(m, players);
    if (!target) {
      this.wander(m, input, 0.01);
      return input;
    }
    const tx = target.pos[0];
    const ty = target.pos[1];
    const tz = target.pos[2];
    const dist = Math.hypot(tx - b.x, tz - b.z);
    const kind = m.def.kind;
    if (kind === Mob.THORNSLINGER) {
      if (dist < 5) this.steerAway(m, input, tx, tz);
      else if (dist > 10) this.walkTo(m, input, [Math.floor(tx), Math.floor(ty), Math.floor(tz)]);
      input.yaw = Math.atan2(-(tx - b.x), -(tz - b.z));
      if (m.shootCooldown === 0 && dist < 16 && this.canSee(b.x, b.y + b.height * 0.7, b.z, tx, ty + 1.5, tz)) {
        this.shoot(m, tx, ty + 1.2, tz);
        m.shootCooldown = 40;
        m.anim |= MobAnim.ATTACK;
      }
      return input;
    }
    if (kind === Mob.SPORECAP) {
      if (dist < 2.5 && m.sporeCooldown === 0) {
        m.fuse++;
        m.anim |= MobAnim.FUSE;
        if (m.fuse >= SPORE_FUSE_TICKS) {
          m.fuse = 0;
          m.sporeCooldown = 120;
          this.sporeCloud(m, players);
        }
        input.yaw = Math.atan2(-(tx - b.x), -(tz - b.z));
        return input;
      }
      m.fuse = Math.max(0, m.fuse - 2);
    }
    // Melee chase.
    this.walkTo(m, input, [Math.floor(tx), Math.floor(ty), Math.floor(tz)]);
    const reach = MOB_REACH + m.def.width / 2;
    if (m.def.damage > 0 && dist < reach && Math.abs(ty - b.y) < 2 && m.attackCooldown === 0) {
      target.hurt(m.def.damage, `mob:${m.def.key}`, [b.x, b.y, b.z]);
      this.ownerHurt(target.key, { mob: m.id });
      m.attackCooldown = MOB_ATTACK_TICKS;
      m.anim |= MobAnim.ATTACK;
    }
    if (dist < 1.2) input.forward = 0;
    return input;
  }

  private thinkAnimal(m: MobEntity, players: MobTarget[], input: MoveInput, light: number): MoveInput {
    const b = m.body;
    const a = m.def.animal!;
    const baby = (m.flags & MobFlag.BABY) !== 0;
    const tamed = (m.flags & MobFlag.TAMED) !== 0;
    if (baby) b.walkSpeed = m.def.speed * 1.15;

    // Fighting (wolves when angry; foxes hunting).
    if (m.angerTicks > 0 && this.fight(m, players, input)) return input;
    if (this.flee(m, input)) return input;
    if (m.ramTicks > 0) return this.ram(m, players, input);

    if (m.flags & MobFlag.SITTING) {
      this.lookAtNearest(m, players, input, 6);
      return input;
    }
    if (m.actionTicks > 0) {
      // Grazing / a short pause.
      if (--m.actionTicks === 0) this.grazed(m);
      else m.anim |= MobAnim.EAT;
      return input;
    }

    // Pets follow their owner.
    if (tamed && m.owner && a.tame !== 'ride') {
      const owner = players.find((p) => p.key === m.owner && p.alive);
      if (owner) {
        const d = Math.hypot(owner.pos[0] - b.x, owner.pos[2] - b.z);
        if (d > FOLLOW_TELEPORT || Math.abs(owner.pos[1] - b.y) > 8) {
          if (this.teleportNear(m, owner.pos)) return input;
        }
        if (d > FOLLOW_START) {
          b.walkSpeed = m.def.speed * 1.4;
          this.walkTo(m, input, [Math.floor(owner.pos[0]), Math.floor(owner.pos[1]), Math.floor(owner.pos[2])]);
          return input;
        }
      }
    }

    // Foxes sleep through the day (and wake when someone comes close without sneaking).
    if (a.nocturnal && light > 0.6) {
      const near = players.some((p) => p.alive && !p.sneaking && Math.hypot(p.pos[0] - b.x, p.pos[2] - b.z) < 4);
      if (near) {
        m.fleeTicks = 60;
        m.fleeFrom = [players[0].pos[0], players[0].pos[2]];
        const scarer = players.find((p) => Math.hypot(p.pos[0] - b.x, p.pos[2] - b.z) < 4);
        if (scarer) m.fleeFrom = [scarer.pos[0], scarer.pos[2]];
        return input;
      }
      if (b.onGround) {
        m.anim |= MobAnim.SLEEP;
        m.path = null;
        return input;
      }
    }

    // Love: go to a partner and make a baby.
    if (m.love > 0 && !baby && this.seekPartner(m, input)) return input;

    // Food in someone's hand draws animals in.
    const tempter = this.tempter(m, players);
    if (tempter) {
      const d = Math.hypot(tempter.pos[0] - b.x, tempter.pos[2] - b.z);
      if (d > 2.2) this.walkTo(m, input, [Math.floor(tempter.pos[0]), Math.floor(tempter.pos[1]), Math.floor(tempter.pos[2])]);
      else m.path = null;
      if (d <= 2.2 || !m.path) input.yaw = Math.atan2(-(tempter.pos[0] - b.x), -(tempter.pos[2] - b.z));
      if (a.hops && input.forward) input.jump = b.onGround;
      return input;
    }

    // Shy animals keep away from people (unless tamed).
    if (!tamed && (m.def.kind === Mob.RABBIT || m.def.kind === Mob.FOX || m.def.kind === Mob.CAT)) {
      const scarer = players.find((p) => p.alive && !p.sneaking && Math.hypot(p.pos[0] - b.x, p.pos[2] - b.z) < 6);
      if (scarer) {
        m.fleeTicks = 40;
        m.fleeFrom = [scarer.pos[0], scarer.pos[2]];
        return input;
      }
    }

    // Hunting (foxes at night): chickens and rabbits.
    if (a.prey && light < 0.6 && Math.random() < 0.02) {
      const prey = this.nearestMob(m, 10, (o) => a.prey!.includes(o.def.kind) && !(o.flags & MobFlag.TAMED));
      if (prey) this.anger(m, { mob: prey.id });
    }

    // Goats charge at people now and then.
    if (a.rams && !baby && --m.ramCooldown <= 0) {
      m.ramCooldown = 600 + Math.floor(Math.random() * 1800);
      const target = players.find((p) => p.alive && !p.creative && Math.hypot(p.pos[0] - b.x, p.pos[2] - b.z) > 3 && Math.hypot(p.pos[0] - b.x, p.pos[2] - b.z) < 10);
      if (target) {
        const dx = target.pos[0] - b.x;
        const dz = target.pos[2] - b.z;
        const len = Math.hypot(dx, dz);
        m.ramDir = [dx / len, dz / len];
        m.ramTicks = 50;
        m.targetId = target.id;
        return this.ram(m, players, input);
      }
    }

    // Babies keep near a grown-up of their kind.
    if (baby) {
      const parent = this.nearestMob(m, 16, (o) => o.def.kind === m.def.kind && !(o.flags & MobFlag.BABY));
      if (parent && Math.hypot(parent.body.x - b.x, parent.body.z - b.z) > 4) {
        this.walkTo(m, input, [Math.floor(parent.body.x), Math.floor(parent.body.y), Math.floor(parent.body.z)]);
        if (a.hops && input.forward) input.jump = b.onGround;
        return input;
      }
    }

    // Grazing: sheep eat grass (and grow their fleece back); the others just nibble.
    if (b.onGround && !m.path && Math.random() < (m.flags & MobFlag.SHEARED ? 1 / 300 : 1 / 900)) {
      if (m.def.kind === Mob.SHEEP || m.def.kind === Mob.COW || m.def.kind === Mob.GOAT || m.def.kind === Mob.HORSE || m.def.kind === Mob.RABBIT) {
        m.actionTicks = 40;
        m.anim |= MobAnim.EAT;
        return input;
      }
    }
    // Look at nearby people while standing around.
    if (!m.path && Math.random() < 0.6) this.lookAtNearest(m, players, input, 8);
    this.wander(m, input, tamed ? 0.004 : 0.008);
    if (a.hops && input.forward) input.jump = b.onGround;
    return input;
  }

  private grazed(m: MobEntity): void {
    const b = m.body;
    const x = Math.floor(b.x);
    const y = Math.floor(b.y - 0.01);
    const z = Math.floor(b.z);
    if (m.def.kind !== Mob.SHEEP) return;
    const below = this.world.getBlock(x, y, z);
    const at = this.world.getBlock(x, y + 1, z);
    if (at === B.TALL_GRASS) this.events.setBlock(x, y + 1, z, B.AIR);
    else if (below === B.GRASS) this.events.setBlock(x, y, z, B.DIRT);
    else return;
    if (m.flags & MobFlag.SHEARED) this.setFlags(m, m.flags & ~MobFlag.SHEARED);
    if (m.flags & MobFlag.BABY) m.age += 1200;
  }

  private tempter(m: MobEntity, players: MobTarget[]): MobTarget | null {
    const food = m.def.animal!.food;
    // Wild wolves don't come begging; untamed pets only for their taming food.
    if (m.def.retaliates && !(m.flags & MobFlag.TAMED)) return null;
    let best: MobTarget | null = null;
    let bestD = TEMPT_RANGE;
    for (const p of players) {
      if (!p.alive || !food.includes(p.held)) continue;
      const d = Math.hypot(p.pos[0] - m.body.x, p.pos[1] - m.body.y, p.pos[2] - m.body.z);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  private seekPartner(m: MobEntity, input: MoveInput): boolean {
    const b = m.body;
    const partner = this.nearestMob(m, 8, (o) => o.def.kind === m.def.kind && o.love > 0 && !(o.flags & MobFlag.BABY));
    if (!partner) return false;
    const d = Math.hypot(partner.body.x - b.x, partner.body.z - b.z);
    if (d > b.width + 0.6) {
      this.walkTo(m, input, [Math.floor(partner.body.x), Math.floor(partner.body.y), Math.floor(partner.body.z)]);
      return true;
    }
    if (m.id > partner.id) return true;
    // The pair: a baby between them.
    m.love = partner.love = 0;
    m.breedCooldown = partner.breedCooldown = BREED_COOLDOWN;
    this.setFlags(m, m.flags & ~MobFlag.LOVE);
    this.setFlags(partner, partner.flags & ~MobFlag.LOVE);
    const pick = () => (Math.random() < 0.5 ? m.variant : partner.variant);
    let variant = pick();
    if (m.def.kind === Mob.HORSE && m.variant !== undefined && partner.variant !== undefined) {
      variant = ((Math.random() < 0.5 ? m.variant : partner.variant) & 7) | ((Math.random() < 0.5 ? m.variant : partner.variant) & ~7);
    }
    const tamedByOne = m.owner && m.owner === partner.owner;
    const baby = this.spawn(m.def.kind, (b.x + partner.body.x) / 2, Math.max(b.y, partner.body.y) + 0.2, (b.z + partner.body.z) / 2, {
      variant, baby: true, flags: tamedByOne && m.def.animal?.tame !== 'ride' ? MobFlag.TAMED : 0,
    });
    if (baby && tamedByOne && m.def.animal?.tame !== 'ride') {
      baby.owner = m.owner;
      baby.ownerName = m.ownerName;
      this.events.state(MobManager.info(baby));
    }
    if (baby) this.events.event(baby.id, 'baby', baby.body.x, baby.body.z);
    return true;
  }

  /** Chase and bite whoever made it angry (a player or a creature). False when the target is gone. */
  private fight(m: MobEntity, players: MobTarget[], input: MoveInput): boolean {
    const b = m.body;
    let tx: number;
    let ty: number;
    let tz: number;
    let player: MobTarget | undefined;
    let mob: MobEntity | undefined;
    if (m.angryPlayer !== null) {
      player = players.find((p) => p.id === m.angryPlayer && p.alive && !p.creative);
      if (!player) return this.calm(m);
      [tx, ty, tz] = player.pos as [number, number, number];
    } else {
      mob = m.angryMob !== null ? this.mobs.get(m.angryMob) : undefined;
      if (!mob || mob.deadTicks > 0) return this.calm(m);
      [tx, ty, tz] = [mob.body.x, mob.body.y, mob.body.z];
    }
    const dist = Math.hypot(tx - b.x, tz - b.z);
    if (dist > 24) return this.calm(m);
    b.walkSpeed = m.def.speed * 1.3;
    this.walkTo(m, input, [Math.floor(tx), Math.floor(ty), Math.floor(tz)]);
    const reach = MOB_REACH + m.def.width / 2 + (mob ? mob.body.width / 2 : 0);
    if (dist < reach && Math.abs(ty - b.y) < 2) {
      input.forward = 0;
      input.yaw = Math.atan2(-(tx - b.x), -(tz - b.z));
      if (m.attackCooldown === 0) {
        const dmg = Math.max(1, m.def.damage);
        if (player) player.hurt(dmg, `mob:${m.def.key}`, [b.x, b.y, b.z]);
        else if (mob) this.hit(mob.id, dmg, [b.x, b.y, b.z], { mob: m.id });
        m.attackCooldown = MOB_ATTACK_TICKS;
        m.anim |= MobAnim.ATTACK;
      }
    }
    return true;
  }

  private calm(m: MobEntity): false {
    m.angerTicks = 0;
    m.angryPlayer = m.angryMob = null;
    this.setFlags(m, m.flags & ~MobFlag.ANGRY);
    return false;
  }

  private ram(m: MobEntity, players: MobTarget[], input: MoveInput): MoveInput {
    const b = m.body;
    m.ramTicks--;
    m.anim |= MobAnim.RAM;
    b.walkSpeed = 5.5;
    input.forward = 1;
    input.yaw = Math.atan2(-m.ramDir[0], -m.ramDir[1]);
    const target = players.find((p) => p.id === m.targetId);
    if (target && Math.hypot(target.pos[0] - b.x, target.pos[2] - b.z) < 1.1 + b.width / 2 && Math.abs(target.pos[1] - b.y) < 1.5) {
      target.hurt(m.def.damage, `mob:${m.def.key}`, [b.x - m.ramDir[0] * 2, b.y, b.z - m.ramDir[1] * 2], 2);
      this.events.event(m.id, 'ram', b.x, b.z);
      m.ramTicks = 0;
    }
    if (b.horizontalCollision) m.ramTicks = 0;
    return input;
  }

  private teleportNear(m: MobEntity, pos: readonly number[]): boolean {
    for (let i = 0; i < 10; i++) {
      const x = Math.floor(pos[0]) + Math.floor(Math.random() * 5) - 2;
      const z = Math.floor(pos[2]) + Math.floor(Math.random() * 5) - 2;
      const y = Math.floor(pos[1]);
      if (Math.abs(x - pos[0]) < 1 && Math.abs(z - pos[2]) < 1) continue;
      if (!this.world.getChunk(x >> 4, z >> 4) || !standable(this.pathWorld, x, y, z, Math.ceil(m.body.height))) continue;
      m.body.x = x + 0.5;
      m.body.y = y;
      m.body.z = z + 0.5;
      m.body.vx = m.body.vy = m.body.vz = 0;
      m.path = null;
      return true;
    }
    return false;
  }

  private nearestMob(m: MobEntity, r: number, test: (o: MobEntity) => boolean): MobEntity | null {
    let best: MobEntity | null = null;
    let bestD = r;
    for (const o of this.mobs.values()) {
      if (o === m || o.deadTicks > 0 || !test(o)) continue;
      const d = Math.hypot(o.body.x - m.body.x, o.body.y - m.body.y, o.body.z - m.body.z);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }

  private lookAtNearest(m: MobEntity, players: MobTarget[], input: MoveInput, r: number): void {
    for (const p of players) {
      const dx = p.pos[0] - m.body.x;
      const dz = p.pos[2] - m.body.z;
      if (p.alive && Math.hypot(dx, dz) < r) {
        input.yaw = Math.atan2(-dx, -dz);
        return;
      }
    }
  }

  private pickTarget(m: MobEntity, players: MobTarget[]): MobTarget | null {
    let best: MobTarget | null = null;
    let bestD = m.def.followRange ?? TARGET_RANGE;
    for (const p of players) {
      if (!p.alive || p.creative) continue;
      const d = Math.hypot(p.pos[0] - m.body.x, p.pos[1] - m.body.y, p.pos[2] - m.body.z);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    m.targetId = best?.id ?? null;
    return best;
  }

  private wander(m: MobEntity, input: MoveInput, chance: number): void {
    const b = m.body;
    if (!m.path && Math.random() < chance) {
      const a = Math.random() * Math.PI * 2;
      const r = 3 + Math.random() * 6;
      this.walkTo(m, input, [Math.floor(b.x + Math.cos(a) * r), Math.floor(b.y), Math.floor(b.z + Math.sin(a) * r)]);
      return;
    }
    if (m.path) this.followPath(m, input);
  }

  private steerAway(m: MobEntity, input: MoveInput, fx: number, fz: number): void {
    const b = m.body;
    const dx = b.x - fx;
    const dz = b.z - fz;
    input.yaw = Math.atan2(-dx, -dz);
    input.forward = 1;
    input.jump = b.horizontalCollision || b.inWater;
    m.path = null;
  }

  private walkTo(m: MobEntity, input: MoveInput, goal: Cell): void {
    const b = m.body;
    m.pathAge++;
    const g = m.pathGoal;
    const stale = !m.path || !g || m.pathAge > 25 || Math.abs(g[0] - goal[0]) + Math.abs(g[2] - goal[2]) > 2;
    if (stale) {
      const start: Cell = [Math.floor(b.x), Math.floor(b.y + 0.01), Math.floor(b.z)];
      m.path = findPath(this.pathWorld, start, goal, Math.max(1, Math.ceil(b.height)), 300, !!m.def.climber);
      m.pathGoal = goal;
      m.pathAge = 0;
    }
    this.followPath(m, input);
  }

  private followPath(m: MobEntity, input: MoveInput): void {
    const b = m.body;
    const path = m.path;
    if (!path || path.length === 0) {
      m.path = null;
      return;
    }
    let next = path[0];
    while (path.length > 1 && Math.hypot(next[0] + 0.5 - b.x, next[2] + 0.5 - b.z) < 0.35) {
      path.shift();
      next = path[0];
    }
    const dx = next[0] + 0.5 - b.x;
    const dz = next[2] + 0.5 - b.z;
    if (path.length === 1 && Math.hypot(dx, dz) < 0.35) {
      m.path = null;
      return;
    }
    input.yaw = Math.atan2(-dx, -dz);
    input.forward = 1;
    input.jump = next[1] > Math.floor(b.y + 0.01) || (b.horizontalCollision && b.onGround) || b.inWater;
  }

  // --- Attacks -----------------------------------------------------------------

  private canSee(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
    const d = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    const hit = raycast((x, y, z) => this.world.getBlock(x, y, z), (id) => id < 0 || OPAQUE[id] === 1, x0, y0, z0, x1 - x0, y1 - y0, z1 - z0, d);
    return hit === null;
  }

  private shoot(m: MobEntity, tx: number, ty: number, tz: number): void {
    const b = m.body;
    const x = b.x;
    const y = b.y + b.height * 0.7;
    const z = b.z;
    const dx = tx - x;
    const dz = tz - z;
    const horiz = Math.hypot(dx, dz);
    const flight = horiz / THORN_SPEED;
    // Aim a little high to make up for the drop.
    const vy = (ty - y) / flight + 0.5 * THORN_GRAVITY * flight;
    const t: Thorn = { id: this.nextId(), x, y, z, vx: (dx / horiz) * THORN_SPEED, vy, vz: (dz / horiz) * THORN_SPEED, age: 0 };
    this.thorns.set(t.id, t);
    this.events.spawned({ id: t.id, kind: 'projectile', x, y, z, vx: t.vx, vy: t.vy, vz: t.vz });
  }

  private tickThorns(players: MobTarget[]): void {
    for (const t of [...this.thorns.values()]) {
      t.age++;
      t.vy -= THORN_GRAVITY * DT;
      const steps = 4;
      let done = t.age > 60;
      for (let s = 0; s < steps && !done; s++) {
        t.x += (t.vx * DT) / steps;
        t.y += (t.vy * DT) / steps;
        t.z += (t.vz * DT) / steps;
        if (this.world.boxes(Math.floor(t.x), Math.floor(t.y), Math.floor(t.z))) done = true;
        for (const p of players) {
          if (!p.alive || p.creative) continue;
          if (Math.abs(p.pos[0] - t.x) < 0.5 && Math.abs(p.pos[2] - t.z) < 0.5 && t.y > p.pos[1] - 0.1 && t.y < p.pos[1] + 1.9) {
            p.hurt(2, 'thorn', [t.x - t.vx, t.y, t.z - t.vz]);
            done = true;
            break;
          }
        }
      }
      if (done) this.remove(t.id);
    }
  }

  private sporeCloud(m: MobEntity, players: MobTarget[]): void {
    const b = m.body;
    this.events.event(m.id, 'spores', b.x, b.z);
    for (const p of players) {
      if (!p.alive || p.creative) continue;
      const d = Math.hypot(p.pos[0] - b.x, p.pos[1] - b.y, p.pos[2] - b.z);
      if (d > SPORE_RADIUS) continue;
      const dmg = Math.max(1, Math.round(SPORE_DAMAGE * (1 - d / SPORE_RADIUS)));
      p.hurt(dmg, 'spores', [b.x, b.y, b.z]);
    }
  }

  // --- Spawning ----------------------------------------------------------------

  private skyAt(x: number, y: number, z: number): number {
    const c = this.world.getChunk(Math.floor(x) >> 4, Math.floor(z) >> 4);
    const iy = Math.floor(y);
    if (!c || iy < 0) return 0;
    if (iy > 255) return 15;
    return c.light[idx(Math.floor(x) & 15, iy, Math.floor(z) & 15)] >> 4;
  }

  /** Tries to add creatures around the players. Call about once a second. */
  spawnTick(players: MobTarget[], time: number): void {
    const alive = players.filter((p) => p.alive);
    if (alive.length === 0) return;
    let hostile = 0;
    let animals = 0;
    for (const m of this.mobs.values()) {
      if (m.def.hostile) hostile++;
      else if (m.def.animal) animals++;
    }
    const sun = daylight(time);
    const hostileCap = Math.min(HOSTILE_MAX, HOSTILE_PER_PLAYER * alive.length);
    for (const p of alive) {
      for (let attempt = 0; attempt < 3 && hostile < hostileCap; attempt++) {
        hostile += this.trySpawnHostile(p, alive, sun, hostileCap - hostile);
      }
      if (animals < ANIMALS_MAX && Math.random() < 0.35) {
        const room = ANIMALS_NEAR - this.countNear(p.pos[0], p.pos[2], ANIMAL_AREA, (m) => !!m.def.animal);
        if (room > 0) animals += this.trySpawnAnimals(p, alive, room);
      }
    }
  }

  private ringSpot(p: MobTarget): [number, number] {
    const a = Math.random() * Math.PI * 2;
    const r = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
    return [Math.floor(p.pos[0] + Math.cos(a) * r), Math.floor(p.pos[2] + Math.sin(a) * r)];
  }

  private farFromPlayers(players: MobTarget[], x: number, z: number): boolean {
    return players.every((q) => Math.hypot(q.pos[0] - x, q.pos[2] - z) >= SPAWN_MIN);
  }

  private trySpawnHostile(p: MobTarget, players: MobTarget[], sun: number, room: number): number {
    const [x, z] = this.ringSpot(p);
    const c = this.world.getChunk(x >> 4, z >> 4);
    if (!c) return 0;
    // A dark floor near the player's height: mostly the surface while they are on it (so the cap
    // isn't spent on caves far below), otherwise caves around them. Never on leaves or glass.
    const pc = this.world.getChunk(Math.floor(p.pos[0]) >> 4, Math.floor(p.pos[2]) >> 4);
    const onSurface = !!pc && p.pos[1] >= pc.heightmap[(Math.floor(p.pos[0]) & 15) | ((Math.floor(p.pos[2]) & 15) << 4)] - 8;
    let y = onSurface && Math.random() < 0.75
      ? c.heightmap[(x & 15) | ((z & 15) << 4)] + 1
      : Math.max(2, Math.min(250, Math.floor(p.pos[1] + (Math.random() - 0.5) * 40)));
    while (y > 1 && !(standable(this.pathWorld, x, y, z, 2) && OPAQUE[this.world.getBlock(x, y - 1, z) & 0xfff])) y--;
    if (y <= 1 || this.world.getBlock(x, y, z) === B.WATER) return 0;
    const l = c.light[idx(x & 15, y, z & 15)];
    if (Math.max(l & 15, (l >> 4) * sun) > 7) return 0;
    if (!this.farFromPlayers(players, x, z)) return 0;
    const kind = pickSpawnKind(HOSTILE_MOBS, Math.random());
    const [gmin, gmax] = mobDef(kind)!.group ?? [1, 1];
    return this.spawnGroup(kind, x, y, z, Math.min(room, gmin + Math.floor(Math.random() * (gmax - gmin + 1))));
  }

  /** Herds by biome: each biome has its own animals (see MobDef.habitat). */
  private trySpawnAnimals(p: MobTarget, players: MobTarget[], room: number): number {
    const [x, z] = this.ringSpot(p);
    const c = this.world.getChunk(x >> 4, z >> 4);
    if (!c) return 0;
    const col = (x & 15) | ((z & 15) << 4);
    const y = c.heightmap[col] + 1;
    const candidates = animalsFor(c.biomes[col]);
    if (candidates.length === 0 || !this.farFromPlayers(players, x, z)) return 0;
    let pick = Math.random() * candidates.reduce((s, d) => s + d.habitat!.weight, 0);
    const def = candidates.find((d) => (pick -= d.habitat!.weight) < 0) ?? candidates[0];
    if (!def.habitat!.ground.includes(this.world.getBlock(x, y - 1, z)) || !standable(this.pathWorld, x, y, z, Math.ceil(def.height))) return 0;
    if ((c.light[idx(x & 15, y, z & 15)] >> 4) < 9) return 0;
    const [gmin, gmax] = def.habitat!.group;
    return this.spawnGroup(def.kind, x, y, z, Math.min(room, gmin + Math.floor(Math.random() * (gmax - gmin + 1))), true);
  }

  private spawnGroup(kind: number, x: number, y: number, z: number, count: number, animals = false): number {
    const def = mobDef(kind)!;
    // One look per herd (mostly), so a flock reads as a flock.
    const variant = def.variant?.(this.biomeAt(x, z), Math.random);
    let spawned = 0;
    for (let i = 0; i < count; i++) {
      const gx = x + (i === 0 ? 0 : Math.floor(Math.random() * 5) - 2);
      const gz = z + (i === 0 ? 0 : Math.floor(Math.random() * 5) - 2);
      if (!standable(this.pathWorld, gx, y, gz, Math.ceil(def.height))) continue;
      const own = kind === Mob.SHEEP || kind === Mob.HORSE ? undefined : variant;
      this.spawn(kind, gx + 0.5, y, gz + 0.5, { variant: own, baby: animals && Math.random() < 0.08 });
      spawned++;
    }
    return spawned;
  }
}
