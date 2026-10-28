import { B, OPAQUE } from '../../shared/blocks/registry';
import { HOSTILE_MOBS, Mob, MOB_ATTACK_TICKS, MOB_REACH, mobDef, PASSIVE_MOBS, PASTURE_BLOCKS, SPORE_DAMAGE, SPORE_FUSE_TICKS, SPORE_RADIUS, type MobDef } from '../../shared/entities/mobs';
import type { ItemStack } from '../../shared/items/registry';
import { PlayerBody, type MoveInput, type WorldQuery } from '../../shared/physics/PlayerBody';
import { raycast } from '../../shared/physics/raycast';
import type { EntityInfo } from '../../shared/protocol/messages';
import { daylight } from '../../shared/time';
import { idx } from '../../shared/world/Chunk';
import type { ServerWorld } from '../ServerWorld';
import { findPath, standable, type Cell, type PathWorld } from './pathfind';

// Creatures, simulated by the host at 20 ticks per second.

const DT = 1 / 20;
const DEATH_TICKS = 16;
const HURT_TICKS = 10;
const TARGET_RANGE = 16;
const DESPAWN_FAR = 80;
const SPAWN_MIN = 24;
const SPAWN_MAX = 44;
const THORN_SPEED = 16;
const THORN_GRAVITY = 6;

/** Anim flags sent in mobMove. */
export const MobAnim = { ATTACK: 1, FUSE: 2, FLEE: 4 } as const;

export interface MobTarget {
  readonly id: number;
  readonly pos: readonly number[];
  readonly alive: boolean;
  readonly creative: boolean;
  /** Deals damage from a creature; `from` is where it came from (for knockback). */
  hurt(amount: number, cause: string, from: readonly number[]): void;
}

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
  sent: [number, number, number, number];
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

export interface MobEvents {
  spawned(info: EntityInfo): void;
  despawned(id: number): void;
  moved(data: Array<{ id: number; x: number; y: number; z: number; yaw: number; anim: number }>): void;
  event(id: number, event: 'hurt' | 'death' | 'spores', x: number, z: number): void;
  drops(items: ItemStack[], x: number, y: number, z: number): void;
}

export class MobManager {
  readonly mobs = new Map<number, MobEntity>();
  private readonly thorns = new Map<number, Thorn>();
  private readonly query: WorldQuery;
  private readonly pathWorld: PathWorld;

  constructor(private readonly world: ServerWorld, private readonly nextId: () => number, private readonly events: MobEvents) {
    this.query = {
      boxes: (x, y, z) => world.boxes(x, y, z),
      isWater: (x, y, z) => world.getBlock(x, y, z) === B.WATER,
    };
    this.pathWorld = {
      blocked: (x, y, z) => world.boxes(x, y, z) !== null,
      isWater: (x, y, z) => world.getBlock(x, y, z) === B.WATER,
    };
  }

  static info(m: MobEntity): EntityInfo {
    return { id: m.id, kind: 'mob', mob: m.def.kind, x: m.body.x, y: m.body.y, z: m.body.z, yaw: m.yaw };
  }

  spawn(kind: number, x: number, y: number, z: number): MobEntity | null {
    const def = mobDef(kind);
    if (!def) return null;
    const body = new PlayerBody();
    body.x = x;
    body.y = y;
    body.z = z;
    body.width = def.width;
    body.height = def.height;
    body.walkSpeed = def.speed;
    body.climber = !!def.climber;
    const m: MobEntity = {
      id: this.nextId(), def, body, yaw: Math.random() * Math.PI * 2, health: def.health, hurtTicks: 0, deadTicks: 0,
      attackCooldown: 0, path: null, pathGoal: null, pathAge: 0, wanderTimer: Math.floor(Math.random() * 100), fleeTicks: 0,
      fleeFrom: [x, z], targetId: null, fuse: 0, sporeCooldown: 0, shootCooldown: 40, anim: 0, sent: [x, y, z, 0],
    };
    this.mobs.set(m.id, m);
    this.events.spawned(MobManager.info(m));
    return m;
  }

  private remove(id: number): void {
    if (this.mobs.delete(id) || this.thorns.delete(id)) this.events.despawned(id);
  }

  /** Removes everything outside the area for which keep() is true (unloaded chunks). */
  removeWhere(drop: (x: number, z: number) => boolean): void {
    for (const m of [...this.mobs.values()]) if (drop(m.body.x, m.body.z)) this.remove(m.id);
    for (const t of [...this.thorns.values()]) if (drop(t.x, t.z)) this.remove(t.id);
  }

  inChunk(cx: number, cz: number): EntityInfo[] {
    const out: EntityInfo[] = [];
    for (const m of this.mobs.values()) {
      if (Math.floor(m.body.x) >> 4 === cx && Math.floor(m.body.z) >> 4 === cz && m.deadTicks === 0) out.push(MobManager.info(m));
    }
    return out;
  }

  hostilesNear(x: number, y: number, z: number, r: number): number {
    let n = 0;
    for (const m of this.mobs.values()) {
      if (m.def.hostile && m.deadTicks === 0 && (m.body.x - x) ** 2 + (m.body.y - y) ** 2 + (m.body.z - z) ** 2 < r * r) n++;
    }
    return n;
  }

  /** A player hit a creature. Returns false if it could not be hurt right now. */
  hit(mobId: number, damage: number, from: readonly number[]): boolean {
    const m = this.mobs.get(mobId);
    if (!m || m.deadTicks > 0 || m.hurtTicks > 0) return false;
    m.health -= damage;
    m.hurtTicks = HURT_TICKS;
    const dx = m.body.x - from[0];
    const dz = m.body.z - from[2];
    const len = Math.hypot(dx, dz) || 1;
    m.body.push((dx / len) * 6, 5, (dz / len) * 6);
    this.events.event(m.id, 'hurt', m.body.x, m.body.z);
    if (m.health <= 0) {
      m.deadTicks = 1;
      this.events.event(m.id, 'death', m.body.x, m.body.z);
      this.events.drops(m.def.drops(Math.random), Math.floor(m.body.x), Math.floor(m.body.y), Math.floor(m.body.z));
    } else if (!m.def.hostile) {
      m.fleeTicks = 80;
      m.fleeFrom = [from[0], from[2]];
      m.path = null;
    }
    return true;
  }

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
      if (nearest > DESPAWN_FAR || b.y < -16 || (m.def.hostile && nearest > 40 && Math.random() < 1 / 600)) {
        this.remove(m.id);
        continue;
      }
      if (m.def.sunSensitive && light > 0.6 && tickCount % 20 === 0 && this.skyAt(b.x, b.y + b.height, b.z) >= 12) {
        this.hit(m.id, 2, [b.x, b.y, b.z]);
        if (m.deadTicks > 0) continue;
      }
      const input = this.think(m, players);
      b.step(this.query, input, DT);
      if (Math.abs(input.yaw - m.yaw) > 1e-3) {
        let d = input.yaw - m.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        m.yaw += d * 0.5;
      }
      const [sx, sy, sz, syaw] = m.sent;
      if (Math.abs(b.x - sx) + Math.abs(b.y - sy) + Math.abs(b.z - sz) > 0.02 || Math.abs(m.yaw - syaw) > 0.05 || m.anim !== 0) {
        if (tickCount % 2 === 0) {
          m.sent = [b.x, b.y, b.z, m.yaw];
          moved.push({ id: m.id, x: b.x, y: b.y, z: b.z, yaw: m.yaw, anim: m.anim });
        }
      }
    }
    this.tickThorns(players);
    if (moved.length > 0) this.events.moved(moved);
  }

  // --- AI ----------------------------------------------------------------------

  private think(m: MobEntity, players: MobTarget[]): MoveInput {
    const b = m.body;
    const input: MoveInput = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, yaw: m.yaw };
    m.anim = 0;
    if (m.attackCooldown > 0) m.attackCooldown--;
    if (m.sporeCooldown > 0) m.sporeCooldown--;
    if (m.shootCooldown > 0) m.shootCooldown--;
    b.walkSpeed = m.def.speed;

    if (m.def.hostile) {
      const target = this.pickTarget(m, players);
      if (target) {
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
            m.anim |= 1;
          }
          return input;
        }
        if (kind === Mob.SPORECAP) {
          if (dist < 2.5 && m.sporeCooldown === 0) {
            m.fuse++;
            m.anim |= 2;
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
          m.attackCooldown = MOB_ATTACK_TICKS;
          m.anim |= 1;
        }
        if (dist < 1.2) input.forward = 0;
        return input;
      }
      this.wander(m, input, 0.01);
      return input;
    }

    // Passive.
    if (m.fleeTicks > 0) {
      m.fleeTicks--;
      b.walkSpeed = m.def.speed * 2.2;
      m.anim |= 4;
      this.steerAway(m, input, m.fleeFrom[0], m.fleeFrom[1]);
      return input;
    }
    this.wander(m, input, 0.008);
    return input;
  }

  private pickTarget(m: MobEntity, players: MobTarget[]): MobTarget | null {
    let best: MobTarget | null = null;
    let bestD = TARGET_RANGE;
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
      m.path = findPath(this.pathWorld, start, goal, Math.ceil(m.def.height), 300, !!m.def.climber);
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
    let passive = 0;
    for (const m of this.mobs.values()) m.def.hostile ? hostile++ : passive++;
    const sun = daylight(time);
    for (const p of alive) {
      for (let attempt = 0; attempt < 3 && hostile < Math.min(30, 10 * alive.length); attempt++) {
        if (this.trySpawn(p, alive, true, sun)) hostile++;
      }
      if (passive < Math.min(24, 8 * alive.length) && Math.random() < 0.35) {
        passive += this.trySpawn(p, alive, false, sun);
      }
    }
  }

  private trySpawn(p: MobTarget, players: MobTarget[], hostile: boolean, sun: number): number {
    const a = Math.random() * Math.PI * 2;
    const r = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
    const x = Math.floor(p.pos[0] + Math.cos(a) * r);
    const z = Math.floor(p.pos[2] + Math.sin(a) * r);
    const c = this.world.getChunk(x >> 4, z >> 4);
    if (!c) return 0;
    let y: number;
    if (hostile) {
      // Any dark floor near the player's height: caves as well as the night surface.
      y = Math.max(2, Math.min(250, Math.floor(p.pos[1] + (Math.random() - 0.5) * 40)));
      while (y > 1 && !standable(this.pathWorld, x, y, z, 2)) y--;
      if (y <= 1 || this.world.getBlock(x, y, z) === B.WATER) return 0;
      const l = c.light[idx(x & 15, y, z & 15)];
      if (Math.max(l & 15, (l >> 4) * sun) > 7) return 0;
    } else {
      y = c.heightmap[(x & 15) | ((z & 15) << 4)] + 1;
      if (!PASTURE_BLOCKS.has(this.world.getBlock(x, y - 1, z)) || !standable(this.pathWorld, x, y, z, 2)) return 0;
      if ((c.light[idx(x & 15, y, z & 15)] >> 4) < 9) return 0;
    }
    for (const q of players) if (Math.hypot(q.pos[0] - x, q.pos[2] - z) < SPAWN_MIN) return 0;
    const pool = hostile ? HOSTILE_MOBS : PASSIVE_MOBS;
    const kind = pool[Math.floor(Math.random() * pool.length)];
    const group = hostile ? 1 : 2 + Math.floor(Math.random() * 2);
    let spawned = 0;
    for (let i = 0; i < group; i++) {
      const gx = x + (i === 0 ? 0 : Math.floor(Math.random() * 5) - 2);
      const gz = z + (i === 0 ? 0 : Math.floor(Math.random() * 5) - 2);
      if (!standable(this.pathWorld, gx, y, gz, Math.ceil(mobDef(kind)!.height))) continue;
      this.spawn(kind, gx + 0.5, y, gz + 0.5);
      spawned++;
    }
    return spawned;
  }
}
