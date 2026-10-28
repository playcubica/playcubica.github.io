// Voxel ray traversal (Amanatides & Woo DDA).

export interface RayHit {
  x: number;
  y: number;
  z: number;
  /** Normal of the face that was hit (points back towards the ray origin). */
  nx: number;
  ny: number;
  nz: number;
  id: number;
  distance: number;
}

/**
 * Walks the grid from (ox, oy, oz) along (dx, dy, dz) and returns the first block for
 * which `hits(id)` is true, within maxDist.
 */
export function raycast(
  getBlock: (x: number, y: number, z: number) => number,
  hits: (id: number) => boolean,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number,
): RayHit | null {
  const len = Math.hypot(dx, dy, dz);
  if (len === 0) return null;
  dx /= len; dy /= len; dz /= len;
  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  const sz = Math.sign(dz);
  const tdx = sx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tdy = sy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tdz = sz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tmx = sx > 0 ? (x + 1 - ox) * tdx : sx < 0 ? (ox - x) * tdx : Infinity;
  let tmy = sy > 0 ? (y + 1 - oy) * tdy : sy < 0 ? (oy - y) * tdy : Infinity;
  let tmz = sz > 0 ? (z + 1 - oz) * tdz : sz < 0 ? (oz - z) * tdz : Infinity;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  let t = 0;
  while (t <= maxDist) {
    const id = getBlock(x, y, z);
    if (hits(id)) return { x, y, z, nx, ny, nz, id, distance: t };
    if (tmx < tmy && tmx < tmz) {
      x += sx; t = tmx; tmx += tdx; nx = -sx; ny = 0; nz = 0;
    } else if (tmy < tmz) {
      y += sy; t = tmy; tmy += tdy; nx = 0; ny = -sy; nz = 0;
    } else {
      z += sz; t = tmz; tmz += tdz; nx = 0; ny = 0; nz = -sz;
    }
  }
  return null;
}
