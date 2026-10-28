import { CHUNK_AREA, CHUNK_VOLUME } from '../constants';
import { OPAQUE } from '../blocks/registry';
import type { BlockEntity } from './blockEntities';

/** Index of a block inside a chunk: x fastest, then z, then y (horizontal layers are contiguous). */
export function idx(x: number, y: number, z: number): number {
  return x | (z << 4) | (y << 8);
}

export function chunkKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

export const blockIdOf = (raw: number): number => raw & 0xfff;
export const blockStateOf = (raw: number): number => raw >>> 12;

/**
 * A 16×16×256 column of blocks.
 *  - blocks: 12-bit id | 4-bit state
 *  - light:  high nibble = sky light, low nibble = block light
 */
export class Chunk {
  readonly blocks: Uint16Array;
  readonly light: Uint8Array;
  /** Highest y that is not air, per column (x | z<<4). */
  readonly heightmap: Uint8Array;
  readonly biomes: Uint8Array;
  /** Highest non-air y in the whole chunk (-1 when empty). */
  maxY = -1;
  /** Chests, furnaces… by block index. Only the host keeps these filled in. */
  readonly blockEntities = new Map<number, BlockEntity>();

  constructor(
    readonly cx: number,
    readonly cz: number,
    blocks?: Uint16Array,
    light?: Uint8Array,
    heightmap?: Uint8Array,
    biomes?: Uint8Array,
  ) {
    this.blocks = blocks ?? new Uint16Array(CHUNK_VOLUME);
    this.light = light ?? new Uint8Array(CHUNK_VOLUME);
    this.heightmap = heightmap ?? new Uint8Array(CHUNK_AREA);
    this.biomes = biomes ?? new Uint8Array(CHUNK_AREA);
  }

  get key(): string {
    return chunkKey(this.cx, this.cz);
  }

  getBlock(x: number, y: number, z: number): number {
    return this.blocks[idx(x, y, z)] & 0xfff;
  }

  setBlock(x: number, y: number, z: number, raw: number): void {
    this.blocks[idx(x, y, z)] = raw;
    const col = x | (z << 4);
    if (raw !== 0) {
      if (y > this.heightmap[col]) this.heightmap[col] = y;
      if (y > this.maxY) this.maxY = y;
    } else if (y === this.heightmap[col]) {
      let top = y;
      while (top > 0 && this.blocks[col | (top << 8)] === 0) top--;
      this.heightmap[col] = top;
    }
  }

  skyLight(x: number, y: number, z: number): number {
    return this.light[idx(x, y, z)] >> 4;
  }

  blockLight(x: number, y: number, z: number): number {
    return this.light[idx(x, y, z)] & 15;
  }

  /** Recomputes heightmap and maxY from the block data. */
  recomputeHeights(): void {
    const blocks = this.blocks;
    let maxY = -1;
    for (let col = 0; col < CHUNK_AREA; col++) {
      let y = 255;
      while (y > 0 && blocks[col | (y << 8)] === 0) y--;
      this.heightmap[col] = y;
      if (y > maxY && blocks[col | (y << 8)] !== 0) maxY = y;
    }
    this.maxY = maxY;
  }

  /** Highest opaque block in a column, or -1. */
  topOpaque(x: number, z: number): number {
    for (let y = this.heightmap[x | (z << 4)]; y >= 0; y--) {
      if (OPAQUE[this.blocks[idx(x, y, z)] & 0xfff]) return y;
    }
    return -1;
  }
}
