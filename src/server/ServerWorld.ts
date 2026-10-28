import { Chunk, chunkKey } from '../shared/world/Chunk';
import { encodeChunk } from '../shared/world/chunkCodec';

/** Produces generated (and base-lit) chunks; backed by a worker pool in the browser. */
export interface ChunkGenerator {
  generate(cx: number, cz: number): Promise<Chunk>;
  /** How many generation jobs may be in flight at once. */
  readonly concurrency: number;
}

/** The host's authoritative block store. */
export class ServerWorld {
  readonly chunks = new Map<string, Chunk>();
  private readonly pending = new Set<string>();
  private readonly encoded = new Map<string, Uint8Array>();

  constructor(private readonly generator: ChunkGenerator) {}

  getChunk(cx: number, cz: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cz));
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Starts generating a chunk if capacity allows. Returns false when saturated. */
  request(cx: number, cz: number): boolean {
    const key = chunkKey(cx, cz);
    if (this.chunks.has(key) || this.pending.has(key)) return true;
    if (this.pending.size >= this.generator.concurrency) return false;
    this.pending.add(key);
    this.generator.generate(cx, cz).then(
      (c) => {
        this.pending.delete(key);
        this.chunks.set(key, c);
      },
      (err) => {
        this.pending.delete(key);
        console.error(`chunk ${key} failed`, err);
      },
    );
    return true;
  }

  /** Wire-format bytes for a chunk, cached until the chunk changes. */
  encodedBytes(c: Chunk): Uint8Array {
    let data = this.encoded.get(c.key);
    if (!data) {
      data = encodeChunk(c);
      this.encoded.set(c.key, data);
    }
    return data;
  }

  invalidate(cx: number, cz: number): void {
    this.encoded.delete(chunkKey(cx, cz));
  }

  /** Drops chunks for which keep() is false. (Stage 2: persist modified chunks first.) */
  unloadWhere(keep: (cx: number, cz: number) => boolean): void {
    for (const [key, c] of this.chunks) {
      if (!keep(c.cx, c.cz)) {
        this.chunks.delete(key);
        this.encoded.delete(key);
      }
    }
  }
}
