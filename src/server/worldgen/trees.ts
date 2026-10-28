import { B } from '../../shared/blocks/registry';
import { hash01 } from '../../shared/rng';

/** Writes a block at world coords; `onlyAir` leaves existing blocks alone. */
export type BlockSetter = (x: number, y: number, z: number, id: number, onlyAir: boolean) => void;

/** Broad-leaved Ashwood tree rooted on the ground block at (x, y, z). */
export function ashwoodTree(set: BlockSetter, x: number, y: number, z: number, variant: number, seed: number): void {
  const trunk = 4 + (variant % 3);
  const topY = y + trunk;
  for (let ly = topY - 2; ly <= topY + 1; ly++) {
    const rad = ly >= topY ? 1 : 2;
    for (let dz = -rad; dz <= rad; dz++) {
      for (let dx = -rad; dx <= rad; dx++) {
        const corner = Math.abs(dx) === rad && Math.abs(dz) === rad;
        if (corner && (ly === topY + 1 || hash01(seed ^ 0x1eaf, x + dx, ly, z + dz) < 0.5)) continue;
        set(x + dx, ly, z + dz, B.ASHWOOD_LEAVES, true);
      }
    }
  }
  for (let ly = 1; ly <= trunk; ly++) set(x, y + ly, z, B.ASHWOOD_LOG, false);
}

/** Conical Frostpine tree rooted on the ground block at (x, y, z). */
export function frostpineTree(set: BlockSetter, x: number, y: number, z: number, variant: number): void {
  const trunk = 6 + (variant % 4);
  const topY = y + trunk + 1;
  for (let ly = y + 3; ly <= topY; ly++) {
    const k = topY - ly;
    let rad = k === 0 ? 0 : k <= 2 ? 1 : k <= 5 ? 2 : 3;
    if (k > 1 && k % 2 === 1) rad = Math.max(1, rad - 1);
    for (let dz = -rad; dz <= rad; dz++) {
      for (let dx = -rad; dx <= rad; dx++) {
        if (Math.abs(dx) + Math.abs(dz) > rad + (rad > 1 ? 1 : 0)) continue;
        set(x + dx, ly, z + dz, B.FROSTPINE_NEEDLES, true);
      }
    }
  }
  for (let ly = 1; ly <= trunk; ly++) set(x, y + ly, z, B.FROSTPINE_LOG, false);
}

/** Height a tree needs above its ground block. */
export const TREE_HEIGHT = { ashwood: 8, frostpine: 11 };
