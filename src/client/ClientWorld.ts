import { Chunk, chunkKey, idx } from '../shared/world/Chunk';
import { mergeChunkBorders, type ChunkSource } from '../shared/world/lighting';

/** The client's copy of the chunks the host has streamed to it. */
export class ClientWorld implements ChunkSource {
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

  /** Packed light at world coordinates (full sky when not loaded). */
  getLight(x: number, y: number, z: number): number {
    if (y > 255) return 0xf0;
    if (y < 0) return 0;
    const c = this.getChunk(x >> 4, z >> 4);
    return c ? c.light[idx(x & 15, y, z & 15)] : 0xf0;
  }

  /** True when the chunk and all 8 neighbours are present (required before meshing). */
  hasNeighbourhood(cx: number, cz: number): boolean {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!this.has(cx + dx, cz + dz)) return false;
    return true;
  }
}
