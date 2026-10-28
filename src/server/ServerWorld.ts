import { Chunk, chunkKey, idx } from '../shared/world/Chunk';
import { decodeChunk, encodeChunk } from '../shared/world/chunkCodec';
import { updateLightAt } from '../shared/world/lighting';
import type { ChunkStore } from './storage/WorldStorage';

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
  /** Chunks changed since the last save. */
  private readonly modified = new Set<string>();
  /** Changed chunks that were unloaded but whose save may not have finished yet. */
  private readonly evicted = new Map<string, Uint8Array>();

  constructor(private readonly generator: ChunkGenerator, private readonly store?: ChunkStore) {}

  getChunk(cx: number, cz: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cz));
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Starts loading (saved) or generating a chunk if capacity allows. Returns false when saturated. */
  request(cx: number, cz: number): boolean {
    const key = chunkKey(cx, cz);
    if (this.chunks.has(key) || this.pending.has(key)) return true;
    if (this.pending.size >= this.generator.concurrency) return false;
    this.pending.add(key);
    this.load(cx, cz).then(
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

  private async load(cx: number, cz: number): Promise<Chunk> {
    const evicted = this.evicted.get(chunkKey(cx, cz));
    if (evicted) return decodeChunk(evicted);
    if (this.store) {
      try {
        const saved = await this.store.loadChunk(cx, cz);
        if (saved) return decodeChunk(saved);
      } catch (err) {
        console.warn(`saved chunk ${cx},${cz} unreadable, regenerating`, err);
      }
    }
    return this.generator.generate(cx, cz);
  }

  getBlock(x: number, y: number, z: number): number {
    if (y < 0 || y > 255) return 0;
    const c = this.getChunk(x >> 4, z >> 4);
    return c ? c.blocks[idx(x & 15, y, z & 15)] & 0xfff : -1;
  }

  /** Changes a block (chunk must be loaded) and repairs light. Returns false if not loaded. */
  setBlock(x: number, y: number, z: number, id: number): boolean {
    if (y < 0 || y > 255) return false;
    const c = this.getChunk(x >> 4, z >> 4);
    if (!c) return false;
    c.setBlock(x & 15, y, z & 15, id);
    for (const t of updateLightAt(this, x, y, z)) {
      this.encoded.delete(t.key);
      this.modified.add(t.key);
    }
    this.encoded.delete(c.key);
    this.modified.add(c.key);
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

  /** Encodes and clears the set of changed chunks, for saving. */
  takeModified(): Array<{ cx: number; cz: number; data: Uint8Array }> {
    const out: Array<{ cx: number; cz: number; data: Uint8Array }> = [];
    for (const key of this.modified) {
      const c = this.chunks.get(key);
      if (c) out.push({ cx: c.cx, cz: c.cz, data: this.encodedBytes(c) });
    }
    this.modified.clear();
    return out;
  }

  /** Drops chunks for which keep() is false. Returns changed chunks that must be saved first. */
  unloadWhere(keep: (cx: number, cz: number) => boolean): Array<{ cx: number; cz: number; data: Uint8Array }> {
    const unsaved: Array<{ cx: number; cz: number; data: Uint8Array }> = [];
    for (const [key, c] of this.chunks) {
      if (keep(c.cx, c.cz)) continue;
      if (this.modified.has(key)) {
        const data = this.encodedBytes(c);
        unsaved.push({ cx: c.cx, cz: c.cz, data });
        this.evicted.set(key, data);
        this.modified.delete(key);
      }
      this.chunks.delete(key);
      this.encoded.delete(key);
    }
    return unsaved;
  }

  /** Call once chunks returned by unloadWhere() are safely stored. */
  markSaved(chunks: Array<{ cx: number; cz: number; data: Uint8Array }>): void {
    for (const c of chunks) {
      const key = chunkKey(c.cx, c.cz);
      if (this.evicted.get(key) === c.data) this.evicted.delete(key);
    }
  }

  /** Puts chunks back on the to-save list (after a failed save). */
  markModified(chunks: Array<{ cx: number; cz: number }>): void {
    for (const c of chunks) if (this.chunks.has(chunkKey(c.cx, c.cz))) this.modified.add(chunkKey(c.cx, c.cz));
  }
}
