import { REPLACEABLE, SOLID } from '../shared/blocks/registry';
import type { EntityInfo } from '../shared/protocol/messages';

// Sand and gravel that lost their support fall as entities, then turn back into a block where
// they land (or into an item if that cell is taken, e.g. by a torch). Simulated by the host.

export interface FallingBlock {
  id: number;
  raw: number;
  /** Centre x/z, bottom y. */
  x: number;
  y: number;
  z: number;
  /** Blocks per tick (downwards is negative). */
  vy: number;
  age: number;
}

export interface FallingWorld {
  getBlock(x: number, y: number, z: number): number;
}

const GRAVITY = 0.04; // blocks/tick², like the genre
const DRAG = 0.98;
const MAX_AGE = 20 * 30;

export class FallingBlocks {
  readonly all = new Map<number, FallingBlock>();

  constructor(
    private readonly world: FallingWorld,
    private readonly nextId: () => number,
    private readonly events: {
      spawned(e: FallingBlock): void;
      /** `x, y, z` is the cell it came to rest in. */
      landed(e: FallingBlock, x: number, y: number, z: number): void;
      moved(list: FallingBlock[]): void;
    },
  ) {}

  static info(e: FallingBlock): EntityInfo {
    return { id: e.id, kind: 'block', raw: e.raw, x: e.x, y: e.y, z: e.z };
  }

  /** Starts a block at cell (x, y, z) falling (the caller clears the cell). */
  spawn(raw: number, x: number, y: number, z: number): void {
    const e: FallingBlock = { id: this.nextId(), raw, x: x + 0.5, y, z: z + 0.5, vy: 0, age: 0 };
    this.all.set(e.id, e);
    this.events.spawned(e);
  }

  tick(): void {
    const moved: FallingBlock[] = [];
    for (const e of this.all.values()) {
      e.age++;
      e.vy = (e.vy - GRAVITY) * DRAG;
      const bx = Math.floor(e.x);
      const bz = Math.floor(e.z);
      const from = Math.floor(e.y);
      let ny = e.y + e.vy;
      // Stop on the first solid cell below (it may be several cells down at speed).
      let land: number | null = null;
      for (let cy = from - 1; cy >= Math.floor(ny); cy--) {
        const id = cy < 0 ? 1 : this.world.getBlock(bx, cy, bz);
        if (id < 0 || SOLID[id] === 1) {
          land = cy + 1;
          break;
        }
      }
      if (land === null && e.age > MAX_AGE) land = Math.max(0, Math.floor(ny));
      if (land !== null) {
        ny = land;
        this.all.delete(e.id);
        this.events.landed(e, bx, land, bz);
        continue;
      }
      e.y = ny;
      moved.push(e);
    }
    if (moved.length > 0) this.events.moved(moved);
  }
}

/** True if the block at a cell can take a landing block (air, water, plants). */
export const canLandIn = (id: number): boolean => id >= 0 && REPLACEABLE[id] === 1;
