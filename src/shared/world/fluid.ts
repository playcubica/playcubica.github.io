import { B, REPLACEABLE, SOLID, WATER_FALLING } from '../blocks/registry';

// Flowing water, shared by the host simulation (server/water.ts) and player physics (the current).
// Water state: 0 = source, 1..7 = flowing (one lower per block from the source), bit 3 = falling
// (water with water above it, drawn full height). Spreading treats sources and falling water as
// level 0, so water reaches 7 blocks from a source or from where a waterfall lands.

export type RawGet = (x: number, y: number, z: number) => number;

export const MAX_FLOW = 7;
/** Ticks between flow steps (20 TPS → 4 blocks a second). */
export const FLOW_DELAY = 5;

export const isWaterRaw = (raw: number): boolean => raw >= 0 && (raw & 0xfff) === B.WATER;

/** Spreading level of a water state: 0 for sources and falling water, else 1..7. */
export function flowLevel(state: number): number {
  return state === 0 || state & WATER_FALLING ? 0 : state & 7;
}

/** Water can move into this cell (air or a plant it washes away). Unloaded cells (-1) are not. */
export function canFlowInto(raw: number): boolean {
  if (raw < 0) return false;
  const id = raw & 0xfff;
  return id === B.AIR || (REPLACEABLE[id] === 1 && id !== B.WATER && id !== B.MAGMA);
}

/** Height of the water surface in a cell, in 1/16 block (for meshing). */
export function waterHeightPx(state: number, waterAbove: boolean): number {
  if (waterAbove || state & WATER_FALLING) return 16;
  return Math.max(2, Math.round(((8 - flowLevel(state)) / 9) * 16));
}

const H = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/**
 * Direction the water in a cell pushes things (x, y, z), roughly unit length, or null for still
 * water: towards lower neighbours, and downwards in falling water.
 */
export function waterFlow(get: RawGet, x: number, y: number, z: number): [number, number, number] | null {
  const raw = get(x, y, z);
  if (!isWaterRaw(raw)) return null;
  const state = raw >>> 12;
  if (state & WATER_FALLING) return [0, -1, 0];
  const own = flowLevel(state);
  let fx = 0;
  let fz = 0;
  for (const [dx, dz] of H) {
    const n = get(x + dx, y, z + dz);
    let drop = 0;
    if (isWaterRaw(n)) {
      const ns = n >>> 12;
      if (!(ns & WATER_FALLING)) drop = flowLevel(ns) - own;
    } else if (canFlowInto(n) && state !== 0) {
      // Spilling over an edge or into an open cell.
      drop = isWaterRaw(get(x + dx, y - 1, z + dz)) || canFlowInto(get(x + dx, y - 1, z + dz)) ? 8 - own : 1;
    }
    if (drop > 0) {
      fx += dx * drop;
      fz += dz * drop;
    }
  }
  const len = Math.hypot(fx, fz);
  return len > 0 ? [fx / len, 0, fz / len] : null;
}

/**
 * The state a non-source cell should have from its surroundings, or null if it should be dry.
 * Two sources next to each other on solid ground (or above a source) make a new source.
 */
export function desiredWater(get: RawGet, x: number, y: number, z: number): number | null {
  if (isWaterRaw(get(x, y + 1, z))) return WATER_FALLING;
  let sources = 0;
  let best = Infinity;
  for (const [dx, dz] of H) {
    const n = get(x + dx, y, z + dz);
    if (!isWaterRaw(n)) continue;
    const ns = n >>> 12;
    if (ns === 0) sources++;
    best = Math.min(best, flowLevel(ns));
  }
  if (sources >= 2) {
    const below = get(x, y - 1, z);
    if (below >= 0 && (SOLID[below & 0xfff] === 1 || (isWaterRaw(below) && below >>> 12 === 0))) return 0;
  }
  const level = best + 1;
  return level > MAX_FLOW ? null : level;
}

/**
 * Horizontal directions water should spread to: those with the shortest way down within 4
 * blocks, or all open ones when there is no way down nearby.
 */
export function spreadDirections(get: RawGet, x: number, y: number, z: number): Array<readonly [number, number]> {
  const open = (raw: number) => canFlowInto(raw) || (isWaterRaw(raw) && raw >>> 12 !== 0);
  const dist: number[] = [];
  for (const [dx, dz] of H) {
    const sx = x + dx;
    const sz = z + dz;
    if (!open(get(sx, y, sz))) {
      dist.push(Infinity);
      continue;
    }
    // Breadth-first over open cells at this height, up to 4 steps, looking for a hole below.
    let best = Infinity;
    const seen = new Set<string>([`${x},${z}`]);
    let frontier: Array<[number, number]> = [[sx, sz]];
    for (let d = 1; d <= 4 && frontier.length > 0 && best === Infinity; d++) {
      const next: Array<[number, number]> = [];
      for (const [cx, cz] of frontier) {
        const k = `${cx},${cz}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const under = get(cx, y - 1, cz);
        if (canFlowInto(under) || isWaterRaw(under)) {
          best = d;
          break;
        }
        for (const [ex, ez] of H) if (open(get(cx + ex, y, cz + ez))) next.push([cx + ex, cz + ez]);
      }
      frontier = next;
    }
    dist.push(best);
  }
  const min = Math.min(...dist);
  return H.filter((_, i) => (min === Infinity ? open(get(x + H[i][0], y, z + H[i][1])) : dist[i] === min));
}
