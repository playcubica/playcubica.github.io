// Axis-aligned box vs block-grid collision.

export interface SolidQuery {
  /** True if the block at integer world coordinates blocks movement. */
  isSolid(x: number, y: number, z: number): boolean;
}

const EPS = 1e-5;

/**
 * How far a box (min/max corners) can move by `d` along `axis` before touching a
 * solid block. Returns the allowed (possibly shortened) distance.
 */
export function sweepAxis(q: SolidQuery, min: number[], max: number[], axis: number, d: number): number {
  if (d === 0) return 0;
  const a1 = (axis + 1) % 3;
  const a2 = (axis + 2) % 3;
  const lo1 = Math.floor(min[a1] + EPS);
  const hi1 = Math.floor(max[a1] - EPS);
  const lo2 = Math.floor(min[a2] + EPS);
  const hi2 = Math.floor(max[a2] - EPS);
  const p = [0, 0, 0];

  const solidLayer = (b: number): boolean => {
    p[axis] = b;
    for (let i = lo1; i <= hi1; i++) {
      p[a1] = i;
      for (let j = lo2; j <= hi2; j++) {
        p[a2] = j;
        if (q.isSolid(p[0], p[1], p[2])) return true;
      }
    }
    return false;
  };

  if (d > 0) {
    const start = Math.floor(max[axis] - EPS) + 1;
    const end = Math.floor(max[axis] + d - EPS);
    for (let b = start; b <= end; b++) {
      if (solidLayer(b)) return Math.max(0, b - max[axis]);
    }
  } else {
    const start = Math.floor(min[axis] + EPS) - 1;
    const end = Math.floor(min[axis] + d + EPS);
    for (let b = start; b >= end; b--) {
      if (solidLayer(b)) return Math.min(0, b + 1 - min[axis]);
    }
  }
  return d;
}

/** True if any solid block overlaps the box. */
export function boxIntersectsSolid(q: SolidQuery, min: number[], max: number[]): boolean {
  for (let x = Math.floor(min[0] + EPS); x <= Math.floor(max[0] - EPS); x++) {
    for (let y = Math.floor(min[1] + EPS); y <= Math.floor(max[1] - EPS); y++) {
      for (let z = Math.floor(min[2] + EPS); z <= Math.floor(max[2] - EPS); z++) {
        if (q.isSolid(x, y, z)) return true;
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
