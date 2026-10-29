// A* over the block grid for walking creatures.
// A cell is "standable" when the creature's body fits (height in whole blocks) and the
// block below holds it up (or the cell is water, where creatures swim). Land animals ask for
// `dry` cells only: solid ground and no water at their feet.

export interface PathWorld {
  /** True if the block blocks movement (anything with a collision box counts). */
  blocked(x: number, y: number, z: number): boolean;
  isWater(x: number, y: number, z: number): boolean;
}

export type Cell = [number, number, number];

const DIRS: Array<[number, number, number]> = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, 1.42], [1, -1, 1.42], [-1, 1, 1.42], [-1, -1, 1.42],
];

export function standable(w: PathWorld, x: number, y: number, z: number, height: number, dry = false): boolean {
  for (let h = 0; h < height; h++) if (w.blocked(x, y + h, z)) return false;
  if (dry) return w.blocked(x, y - 1, z) && !w.isWater(x, y, z);
  return w.blocked(x, y - 1, z) || w.isWater(x, y, z);
}

/**
 * Finds a walking path from start to goal (cells are feet positions). Returns the cells
 * after the start, or, if the goal can't be reached within `maxNodes`, the path to the
 * explored cell closest to it. Null if no step at all is possible.
 */
export function findPath(w: PathWorld, start: Cell, goal: Cell, height: number, maxNodes = 400, climber = false, dry = false): Cell[] | null {
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const h = (x: number, y: number, z: number) => Math.abs(x - goal[0]) + Math.abs(z - goal[2]) + Math.abs(y - goal[1]) * 0.5;
  interface Node { x: number; y: number; z: number; g: number; f: number; parent: Node | null }
  const open: Node[] = [];
  const best = new Map<string, number>();
  const closed = new Set<string>();
  const startNode: Node = { x: start[0], y: start[1], z: start[2], g: 0, f: h(...start), parent: null };
  open.push(startNode);
  best.set(key(...start), 0);
  let nearest = startNode;
  let nearestH = h(...start);
  let expanded = 0;

  while (open.length > 0 && expanded < maxNodes) {
    // Small open sets: a linear scan for the lowest f is fast enough.
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open[bi];
    open[bi] = open[open.length - 1];
    open.pop();
    const ck = key(cur.x, cur.y, cur.z);
    if (closed.has(ck)) continue;
    closed.add(ck);
    expanded++;
    const ch = h(cur.x, cur.y, cur.z);
    if (ch < nearestH) {
      nearest = cur;
      nearestH = ch;
    }
    if (cur.x === goal[0] && cur.y === goal[1] && cur.z === goal[2]) {
      nearest = cur;
      break;
    }
    for (const [dx, dz, cost] of DIRS) {
      const nx = cur.x + dx;
      const nz = cur.z + dz;
      // Diagonals must not cut corners.
      if (dx !== 0 && dz !== 0 && (!standableOrPassable(w, cur.x + dx, cur.y, cur.z, height) || !standableOrPassable(w, cur.x, cur.y, cur.z + dz, height))) continue;
      // Try the same level, one up (jump), then dropping up to 3.
      const options = climber ? [0, 1, 2, 3, -1, -2, -3] : [0, 1, -1, -2, -3];
      for (const dy of options) {
        const ny = cur.y + dy;
        if (dy > 0) {
          // Head room above the current cell for the jump / climb.
          let clear = true;
          for (let k = 1; k <= dy; k++) if (w.blocked(cur.x, cur.y + height - 1 + k, cur.z)) clear = false;
          if (!clear) continue;
        } else if (dy < 0) {
          // The target column above the landing spot must be open to fall through.
          let clear = true;
          for (let k = 0; k < -dy; k++) if (w.blocked(nx, cur.y - k + height - 1, nz) || w.blocked(nx, cur.y - k, nz)) clear = false;
          if (!clear) continue;
        }
        if (!standable(w, nx, ny, nz, height, dry)) continue;
        const nk = key(nx, ny, nz);
        if (closed.has(nk)) break;
        const g = cur.g + cost + (dy > 0 ? 0.5 * dy : 0) + (w.isWater(nx, ny, nz) ? 1 : 0);
        if (g < (best.get(nk) ?? Infinity)) {
          best.set(nk, g);
          open.push({ x: nx, y: ny, z: nz, g, f: g + h(nx, ny, nz), parent: cur });
        }
        break;
      }
    }
  }
  if (nearest === startNode) return null;
  const path: Cell[] = [];
  for (let n: Node | null = nearest; n && n !== startNode; n = n.parent) path.push([n.x, n.y, n.z]);
  return path.reverse();
}

function standableOrPassable(w: PathWorld, x: number, y: number, z: number, height: number): boolean {
  for (let h = 0; h < height; h++) if (w.blocked(x, y + h, z)) return false;
  return true;
}
