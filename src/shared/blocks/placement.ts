import { I, toolId } from '../items/registry';
import { B, BED_HEAD, BED_PAIRED, DIR_VEC, DOOR_UPPER, FACING_DIR, LEAVES_PLACED, OPAQUE, OPPOSITE_DIR, PUSHER_EXTENDED, RENDER, SOLID, TORCH_WALL, withState } from './registry';

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

/** The other half of a two-block bed. */
export function bedPartner(x: number, y: number, z: number, state: number): [number, number, number] {
  const [dx, , dz] = DIR_VEC[FACING_DIR[state & 3]];
  return state & BED_HEAD ? [x - dx, y, z - dz] : [x + dx, y, z + dz];
}

/** Facing in the direction the player looks. */
export function facingAway(yaw: number): number {
  return (facingTowards(yaw) + 2) % 4;
}

/**
 * The block value to place for a block item, given the clicked face normal and the
 * player's yaw, or null if it can't be placed against that face.
 */
export function placementRaw(block: number, nx: number, ny: number, nz: number, yaw: number, pitch = 0): number | null {
  switch (block) {
    case B.RELAY:
    case B.INVERTER:
      // The signal travels the way the player is looking.
      return withState(block, facingAway(yaw));
    case B.PUSHER: {
      // Pushes the way the player is looking (up/down when looking steeply).
      if (pitch > 0.8) return withState(block, 2);
      if (pitch < -0.8) return withState(block, 3);
      return withState(block, FACING_DIR[facingAway(yaw)]);
    }
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
    case B.BEDROLL:
      // The foot goes where the player clicks, the head one block further in the looking direction.
      return withState(block, facingAway(yaw) | BED_PAIRED);
    case B.ASHWOOD_LEAVES:
    case B.FROSTPINE_NEEDLES:
      return withState(block, LEAVES_PLACED);
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
  if (id === B.SUNWHEAT) return below() === B.FARMLAND;
  if (id === B.GLOWWIRE || id === B.LEVER || id === B.PRESSURE_PLATE || id === B.RELAY || id === B.INVERTER) {
    const b = below();
    return OPAQUE[b] === 1 && SOLID[b] === 1;
  }
  if (id === B.RIFT) {
    const b = below();
    return b === B.RIFT_STONE || b === B.RIFT;
  }
  if (id === B.PUSHER_HEAD) {
    const [dx, dy, dz] = DIR_VEC[OPPOSITE_DIR[state & 7]];
    const behind = get(x + dx, y + dy, z + dz);
    return (behind & 0xfff) === B.PUSHER && ((behind >>> 12) & PUSHER_EXTENDED) !== 0;
  }
  if (RENDER[id] === 2) return OPAQUE[below()] === 1;
  if (id === B.CACTUS) {
    const b = below();
    if (b !== B.SAND && b !== B.CACTUS) return false;
    // Anything solid right beside a cactus breaks it.
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (SOLID[get(x + dx, y, z + dz) & 0xfff]) return false;
    return true;
  }
  if (id === B.BEDROLL && state & BED_PAIRED) {
    const [px, py, pz] = bedPartner(x, y, z, state);
    const other = get(px, py, pz);
    return (other & 0xfff) === B.BEDROLL && (other >>> 12) === (state ^ BED_HEAD);
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

const SHOVEL_IDS = new Set([0, 1, 2, 3, 4].map((t) => toolId(t, 2)));
const TILLABLE = new Set<number>([B.GRASS, B.DIRT, B.FROST_TURF]);

/**
 * True if right-clicking this block (holding `heldId`) does something to it — opening,
 * toggling, tilling, fertilising, igniting a rift — instead of placing against it.
 */
export function isInteractive(id: number, heldId = 0): boolean {
  switch (id) {
    case B.WORKBENCH:
    case B.FURNACE:
    case B.FURNACE_LIT:
    case B.CHEST:
    case B.ASHWOOD_DOOR:
    case B.BEDROLL:
    case B.LEVER:
    case B.RUNE_TABLE:
      return true;
    case B.RIFT_STONE:
      return heldId === I.LUMEN_DUST;
    case B.SUNWHEAT:
      return heldId === I.SPORE_POWDER;
    default:
      return TILLABLE.has(id) && SHOVEL_IDS.has(heldId);
  }
}
