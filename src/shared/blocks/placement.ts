import { B, DOOR_UPPER, OPAQUE, RENDER, SOLID, TORCH_WALL, withState } from './registry';

// Orientation when placing, and which blocks need another block to hold them up.
// Shared by the client (prediction) and the host (validation).

export type RawGetter = (x: number, y: number, z: number) => number;

const SAPLING_SOIL = new Set<number>([B.GRASS, B.DIRT, B.FROST_TURF]);

/** Facing (0 +z, 1 -x, 2 -z, 3 +x) that points from the block back towards a player looking along yaw. */
export function facingTowards(yaw: number): number {
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  if (Math.abs(fx) > Math.abs(fz)) return fx > 0 ? 3 : 1;
  return fz > 0 ? 0 : 2;
}

/** Facing in the direction the player looks. */
export function facingAway(yaw: number): number {
  return (facingTowards(yaw) + 2) % 4;
}

/**
 * The block value to place for a block item, given the clicked face normal and the
 * player's yaw, or null if it can't be placed against that face.
 */
export function placementRaw(block: number, nx: number, ny: number, nz: number, yaw: number): number | null {
  switch (block) {
    case B.TORCH: {
      if (ny === 1) return B.TORCH;
      if (ny === -1) return null;
      const wall = TORCH_WALL.findIndex(([x, y, z], i) => i > 0 && x === -nx && y === 0 && z === -nz);
      return wall > 0 ? withState(B.TORCH, wall) : null;
    }
    case B.FURNACE:
    case B.CHEST:
      return withState(block, facingTowards(yaw));
    case B.ASHWOOD_DOOR:
      return withState(block, facingAway(yaw));
    default:
      return block;
  }
}

/** True if a block value at (x, y, z) is held up by its surroundings. */
export function isSupported(get: RawGetter, x: number, y: number, z: number, raw: number): boolean {
  const id = raw & 0xfff;
  const state = raw >>> 12;
  const below = () => get(x, y - 1, z) & 0xfff;
  if (id === B.ASHWOOD_SAPLING || id === B.FROSTPINE_SAPLING) return SAPLING_SOIL.has(below());
  if (RENDER[id] === 2) return OPAQUE[below()] === 1;
  if (id === B.CACTUS) {
    const b = below();
    return b === B.SAND || b === B.CACTUS;
  }
  if (id === B.TORCH) {
    const [dx, dy, dz] = TORCH_WALL[state] ?? TORCH_WALL[0];
    const s = get(x + dx, y + dy, z + dz) & 0xfff;
    return OPAQUE[s] === 1 && SOLID[s] === 1;
  }
  if (id === B.ASHWOOD_DOOR) {
    if (state & DOOR_UPPER) return (get(x, y - 1, z) & 0xfff) === B.ASHWOOD_DOOR;
    const above = get(x, y + 1, z);
    return OPAQUE[below()] === 1 && (above & 0xfff) === B.ASHWOOD_DOOR;
  }
  return true;
}

/** Blocks that react to a right-click instead of having something placed against them. */
export function isInteractive(id: number): boolean {
  return id === B.WORKBENCH || id === B.FURNACE || id === B.FURNACE_LIT || id === B.CHEST || id === B.ASHWOOD_DOOR || id === B.BEDROLL;
}
