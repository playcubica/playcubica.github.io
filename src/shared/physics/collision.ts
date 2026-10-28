// Axis-aligned box vs block-grid collision. Blocks may have several partial boxes
// (doors, chests, bedrolls); full blocks are one unit cube.

export interface SolidQuery {
  /** Collision boxes of the block at integer world coords, as flat local [x0,y0,z0,x1,y1,z1,…] (0..1), or null. */
  boxes(x: number, y: number, z: number): readonly number[] | null;
}

const EPS = 1e-5;
export const UNIT_BOX: readonly number[] = [0, 0, 0, 1, 1, 1];

/** Adapter for simple worlds made only of full blocks. */
export function solidFrom(isSolid: (x: number, y: number, z: number) => boolean): SolidQuery {
  return { boxes: (x, y, z) => (isSolid(x, y, z) ? UNIT_BOX : null) };
}

/**
 * How far a box (min/max corners) can move by `d` along `axis` before touching a
 * collision box. Returns the allowed (possibly shortened) distance.
 */
export function sweepAxis(q: SolidQuery, min: number[], max: number[], axis: number, d: number): number {
  if (d === 0) return 0;
  const a1 = (axis + 1) % 3;
  const a2 = (axis + 2) % 3;
  const lo = [0, 0, 0];
  const hi = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    lo[k] = Math.floor(min[k] + EPS);
    hi[k] = Math.floor(max[k] - EPS);
  }
  if (d > 0) hi[axis] = Math.floor(max[axis] + d - EPS);
  else lo[axis] = Math.floor(min[axis] + d + EPS);
  // Shapes may be lower than a full block (bedroll): also look one block below.
  if (axis !== 1) lo[1] = Math.min(lo[1], Math.floor(min[1] + EPS) - 1);

  const p = [0, 0, 0];
  let clipped = false;
  for (let x = lo[0]; x <= hi[0]; x++) {
    for (let y = lo[1]; y <= hi[1]; y++) {
      for (let z = lo[2]; z <= hi[2]; z++) {
        const boxes = q.boxes(x, y, z);
        if (!boxes) continue;
        p[0] = x; p[1] = y; p[2] = z;
        for (let b = 0; b < boxes.length; b += 6) {
          const bmin1 = p[a1] + boxes[b + a1];
          const bmax1 = p[a1] + boxes[b + 3 + a1];
          const bmin2 = p[a2] + boxes[b + a2];
          const bmax2 = p[a2] + boxes[b + 3 + a2];
          if (bmax1 <= min[a1] + EPS || bmin1 >= max[a1] - EPS) continue;
          if (bmax2 <= min[a2] + EPS || bmin2 >= max[a2] - EPS) continue;
          const bmin = p[axis] + boxes[b + axis];
          const bmax = p[axis] + boxes[b + 3 + axis];
          if (d > 0 && bmin >= max[axis] - EPS && bmin - max[axis] < d) {
            d = bmin - max[axis];
            clipped = true;
          } else if (d < 0 && bmax <= min[axis] + EPS && bmax - min[axis] > d) {
            d = bmax - min[axis];
            clipped = true;
          }
        }
      }
    }
  }
  // Touching (within rounding) counts as no movement, never as moving backwards.
  return clipped && Math.abs(d) < EPS ? 0 : d;
}

/** True if any collision box overlaps the box. */
export function boxIntersectsSolid(q: SolidQuery, min: number[], max: number[]): boolean {
  for (let x = Math.floor(min[0] + EPS); x <= Math.floor(max[0] - EPS); x++) {
    for (let y = Math.floor(min[1] + EPS) - 1; y <= Math.floor(max[1] - EPS); y++) {
      for (let z = Math.floor(min[2] + EPS); z <= Math.floor(max[2] - EPS); z++) {
        const boxes = q.boxes(x, y, z);
        if (!boxes) continue;
        for (let b = 0; b < boxes.length; b += 6) {
          if (
            x + boxes[b] < max[0] - EPS && x + boxes[b + 3] > min[0] + EPS &&
            y + boxes[b + 1] < max[1] - EPS && y + boxes[b + 4] > min[1] + EPS &&
            z + boxes[b + 2] < max[2] - EPS && z + boxes[b + 5] > min[2] + EPS
          ) return true;
        }
      }
    }
  }
  return false;
}

/** True if the box overlaps the unit cube of block (bx, by, bz). */
export function boxOverlapsBlock(min: number[], max: number[], bx: number, by: number, bz: number): boolean {
  return (
    min[0] < bx + 1 - EPS && max[0] > bx + EPS &&
    min[1] < by + 1 - EPS && max[1] > by + EPS &&
    min[2] < bz + 1 - EPS && max[2] > bz + EPS
  );
}
