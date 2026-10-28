import { canMerge } from '../shared/items/Inventory';
import { maxStack, type ItemStack } from '../shared/items/registry';
import { sweepAxis, type SolidQuery } from '../shared/physics/collision';
import type { EntityInfo } from '../shared/protocol/messages';

// Dropped items lying in the world. Simulated by the host; clients only render them.

export interface ItemEntity {
  id: number;
  item: ItemStack;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  pickupDelay: number;
  resting: boolean;
}

export interface Collector {
  readonly id: number;
  /** Feet position. */
  readonly pos: readonly number[];
  readonly alive: boolean;
  /** Adds the stack; returns how many did not fit. */
  collect(item: ItemStack): number;
}

const SIZE = 0.25;
const GRAVITY = 18;
const DESPAWN_TICKS = 5 * 60 * 20;
const DT = 1 / 20;

export class ItemEntities {
  readonly all = new Map<number, ItemEntity>();

  constructor(
    private readonly world: SolidQuery,
    /** Entity ids are shared with creatures, so the host hands them out. */
    private readonly nextId: () => number,
    private readonly events: {
      spawned(e: ItemEntity): void;
      despawned(e: ItemEntity, pickedBy?: number): void;
      moved(moves: ItemEntity[]): void;
    },
  ) {}

  spawn(item: ItemStack, x: number, y: number, z: number, vx = 0, vy = 0, vz = 0, pickupDelay = 10): void {
    if (item.count <= 0) return;
    const e: ItemEntity = { id: this.nextId(), item: { ...item }, x, y, z, vx, vy, vz, age: 0, pickupDelay, resting: false };
    this.all.set(e.id, e);
    this.events.spawned(e);
  }

  /** Spawns a block's drops with a little random scatter. */
  spawnDrops(items: ItemStack[], x: number, y: number, z: number): void {
    for (const it of items) {
      const r = () => (Math.random() - 0.5) * 2;
      this.spawn(it, x + 0.5 + r() * 0.2, y + 0.4, z + 0.5 + r() * 0.2, r() * 1.2, 3 + Math.random() * 1.5, r() * 1.2);
    }
  }

  static info(e: ItemEntity): EntityInfo {
    return { id: e.id, kind: 'item', x: e.x, y: e.y, z: e.z, item: { ...e.item } };
  }

  tick(collectors: Iterable<Collector>, tickCount: number): void {
    const moved: ItemEntity[] = [];
    const players = [...collectors].filter((c) => c.alive);
    for (const e of this.all.values()) {
      e.age++;
      if (e.age > DESPAWN_TICKS) {
        this.remove(e);
        continue;
      }
      if (!e.resting) {
        e.vy = Math.max(e.vy - GRAVITY * DT, -30);
        const drag = Math.pow(0.15, DT);
        e.vx *= drag;
        e.vz *= drag;
        const h = SIZE / 2;
        const min = [e.x - h, e.y, e.z - h];
        const max = [e.x + h, e.y + SIZE, e.z + h];
        const dy = sweepAxis(this.world, min, max, 1, e.vy * DT);
        min[1] += dy; max[1] += dy;
        const dx = sweepAxis(this.world, min, max, 0, e.vx * DT);
        min[0] += dx; max[0] += dx;
        const dz = sweepAxis(this.world, min, max, 2, e.vz * DT);
        const landed = e.vy < 0 && dy > e.vy * DT;
        if (dx !== e.vx * DT) e.vx = 0;
        if (dz !== e.vz * DT) e.vz = 0;
        if (dy !== e.vy * DT) e.vy = 0;
        e.x += dx;
        e.y += dy;
        e.z += dz;
        if (landed) {
          e.vx *= 0.5;
          e.vz *= 0.5;
          if (Math.abs(e.vx) < 0.05 && Math.abs(e.vz) < 0.05) e.resting = true;
        }
        moved.push(e);
      } else if (tickCount % 20 === 0) {
        // Wake up if the ground disappeared.
        const h = SIZE / 2;
        if (sweepAxis(this.world, [e.x - h, e.y, e.z - h], [e.x + h, e.y + SIZE, e.z + h], 1, -0.05) !== 0) e.resting = false;
      }

      if (e.age >= e.pickupDelay) {
        for (const p of players) {
          const dx = p.pos[0] - e.x;
          const dz = p.pos[2] - e.z;
          // From one block below the feet (a block just mined underfoot) to above the head.
          if (dx * dx + dz * dz > 1.5 * 1.5 || e.y < p.pos[1] - 1.1 || e.y > p.pos[1] + 2.3) continue;
          const left = p.collect(e.item);
          if (left === 0) {
            this.remove(e, p.id);
            break;
          }
          e.item.count = left;
        }
      }
    }

    // Merge nearby identical stacks every second.
    if (tickCount % 20 === 0) {
      const list = [...this.all.values()];
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        if (!this.all.has(a.id)) continue;
        for (let j = i + 1; j < list.length; j++) {
          const b = list[j];
          if (!this.all.has(b.id) || !canMerge(a.item, b.item)) continue;
          if ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2 > 1) continue;
          if (a.item.count + b.item.count > maxStack(a.item.id)) continue;
          b.item.count += a.item.count;
          b.age = Math.min(a.age, b.age);
          this.remove(a);
          this.remove(b);
          this.all.set(b.id, b);
          this.events.spawned(b);
          break;
        }
      }
    }
    if (moved.length > 0) this.events.moved(moved);
  }

  private remove(e: ItemEntity, pickedBy?: number): void {
    if (!this.all.delete(e.id)) return;
    this.events.despawned(e, pickedBy);
  }

  /** Entities inside a chunk (to send to a client that just received it). */
  inChunk(cx: number, cz: number): ItemEntity[] {
    return [...this.all.values()].filter((e) => Math.floor(e.x) >> 4 === cx && Math.floor(e.z) >> 4 === cz);
  }
}
