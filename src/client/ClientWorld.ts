import { B, collisionBoxes } from '../shared/blocks/registry';
import { UNIT_BOX } from '../shared/physics/collision';
import type { WorldQuery } from '../shared/physics/PlayerBody';
import { Chunk, chunkKey, idx } from '../shared/world/Chunk';
import { mergeChunkBorders, updateLightAt, type ChunkSource } from '../shared/world/lighting';

/** The client's copy of the chunks the host has streamed to it. */
export class ClientWorld implements ChunkSource, WorldQuery {
  readonly chunks = new Map<string, Chunk>();

  getChunk(cx: number, cz: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cz));
  }

  has(cx: number, cz: number): boolean {
    return this.chunks.has(chunkKey(cx, cz));
  }

  /** Adds a chunk and lets light flow across its borders. Returns chunks whose light changed. */
  add(c: Chunk): Set<Chunk> {
    this.chunks.set(c.key, c);
    const touched = mergeChunkBorders(this, c);
    touched.add(c);
    return touched;
  }

  remove(cx: number, cz: number): void {
    this.chunks.delete(chunkKey(cx, cz));
  }

  /** Block id at world coordinates (0 when not loaded). */
  getBlock(x: number, y: number, z: number): number {
    if (y < 0 || y > 255) return 0;
    const c = this.getChunk(x >> 4, z >> 4);
    return c ? c.blocks[idx(x & 15, y, z & 15)] & 0xfff : 0;
  }

  /** Changes a block (raw value: id + state) and repairs light. Returns the chunks that need remeshing. */
  setBlock(x: number, y: number, z: number, raw: number): Set<Chunk> {
    const c = y >= 0 && y <= 255 ? this.getChunk(x >> 4, z >> 4) : undefined;
    if (!c || c.blocks[idx(x & 15, y, z & 15)] === raw) return new Set();
    c.setBlock(x & 15, y, z & 15, raw);
    const touched = updateLightAt(this, x, y, z);
    touched.add(c);
    return touched;
  }

  /** Packed light at world coordinates (full sky when not loaded). */
  getLight(x: number, y: number, z: number): number {
    if (y > 255) return 0xf0;
    if (y < 0) return 0;
    const c = this.getChunk(x >> 4, z >> 4);
    return c ? c.light[idx(x & 15, y, z & 15)] : 0xf0;
  }

  /** Physics: block shapes; unloaded chunks are solid (so nobody falls out of the world while it streams in). */
  boxes(x: number, y: number, z: number): readonly number[] | null {
    if (y < 0) return UNIT_BOX;
    if (y > 255) return null;
    const c = this.getChunk(x >> 4, z >> 4);
    return c ? collisionBoxes(c.blocks[idx(x & 15, y, z & 15)]) : UNIT_BOX;
  }

  /** Raw block value (id + state) at world coordinates. */
  getRaw(x: number, y: number, z: number): number {
    if (y < 0 || y > 255) return 0;
    const c = this.getChunk(x >> 4, z >> 4);
    return c ? c.blocks[idx(x & 15, y, z & 15)] : 0;
  }

  /** Liquids you swim in (water, and slowly through magma). */
  isWater(x: number, y: number, z: number): boolean {
    const id = this.getBlock(x, y, z);
    return id === B.WATER || id === B.MAGMA;
  }

  /** True when the chunk and all 8 neighbours are present (required before meshing). */
  hasNeighbourhood(cx: number, cz: number): boolean {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!this.has(cx + dx, cz + dz)) return false;
    return true;
  }
}
