import { B, withState, WATER_FALLING } from '../shared/blocks/registry';
import { canFlowInto, desiredWater, FLOW_DELAY, flowLevel, isWaterRaw, MAX_FLOW, spreadDirections } from '../shared/world/fluid';

// Flowing water on the host. Cells are re-checked FLOW_DELAY ticks after something next to them
// changes (the server queues that); each check settles the cell's own level and lets it spread one
// step: down first, sideways towards the nearest drop. Worldgen water is all source blocks and
// stays still until something around it changes.

export interface WaterWorld {
  getRaw(x: number, y: number, z: number): number;
  /** Sets a block (the server broadcasts it and queues neighbour checks). `washed` is what was there. */
  setWater(x: number, y: number, z: number, raw: number, washed: number): void;
}

/** Most cell checks per tick, so a big flood can't stall the host. */
const MAX_PER_TICK = 2000;

export class WaterSim {
  /** Due tick → "x,y,z" keys. */
  private readonly due = new Map<number, Set<string>>();
  private readonly pending = new Set<string>();

  constructor(private readonly world: WaterWorld) {}

  get scheduled(): number {
    return this.pending.size;
  }

  schedule(x: number, y: number, z: number, now: number): void {
    const key = `${x},${y},${z}`;
    if (this.pending.has(key)) return;
    this.pending.add(key);
    const at = now + FLOW_DELAY;
    let set = this.due.get(at);
    if (!set) this.due.set(at, (set = new Set()));
    set.add(key);
  }

  tick(now: number): void {
    let budget = MAX_PER_TICK;
    for (const [at, keys] of this.due) {
      if (at > now) continue;
      for (const key of keys) {
        if (budget-- <= 0) return;
        keys.delete(key);
        this.pending.delete(key);
        const [x, y, z] = key.split(',').map(Number);
        this.update(x, y, z);
      }
      this.due.delete(at);
    }
  }

  private update(x: number, y: number, z: number): void {
    const w = this.world;
    const get = (a: number, b: number, c: number) => w.getRaw(a, b, c);
    let raw = get(x, y, z);
    if (raw < 0) return; // unloaded
    if (isWaterRaw(raw)) {
      const state = raw >>> 12;
      if (state !== 0) {
        const want = desiredWater(get, x, y, z);
        if (want === null) {
          w.setWater(x, y, z, B.AIR, raw);
          return;
        }
        if (want !== state) {
          const old = raw;
          raw = withState(B.WATER, want);
          w.setWater(x, y, z, raw, old);
        }
      }
      this.spread(x, y, z, raw >>> 12);
    }
  }

  private spread(x: number, y: number, z: number, state: number): void {
    const w = this.world;
    const get = (a: number, b: number, c: number) => w.getRaw(a, b, c);
    const below = get(x, y - 1, z);
    if (y > 0 && canFlowInto(below)) {
      w.setWater(x, y - 1, z, withState(B.WATER, WATER_FALLING), below);
      if (state !== 0) return; // flowing water that can fall doesn't also spread sideways
    } else if (isWaterRaw(below)) {
      // Resting on water: a thinner flowing layer below becomes part of the fall. Only sources
      // spread sideways from on top of water (otherwise a waterfall would grow out of every cell).
      if (below >>> 12 !== 0 && !((below >>> 12) & WATER_FALLING)) w.setWater(x, y - 1, z, withState(B.WATER, WATER_FALLING), below);
      if (state !== 0) return;
    }
    const next = flowLevel(state) + 1;
    if (next > MAX_FLOW) return;
    for (const [dx, dz] of spreadDirections(get, x, y, z)) {
      const n = get(x + dx, y, z + dz);
      if (canFlowInto(n)) {
        w.setWater(x + dx, y, z + dz, withState(B.WATER, next), n);
      } else if (isWaterRaw(n)) {
        const ns = n >>> 12;
        if (ns !== 0 && !(ns & WATER_FALLING) && (ns & 7) > next) w.setWater(x + dx, y, z + dz, withState(B.WATER, next), n);
      }
    }
  }
}
