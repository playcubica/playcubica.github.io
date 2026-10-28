import { Chunk } from '../shared/world/Chunk';
import type { GenRequest, GenResult } from '../workers/types';
import { defaultWorkerCount, WorkerPool } from '../workers/WorkerPool';
import type { ChunkGenerator } from './ServerWorld';

/** Generates and base-lights chunks on a pool of Web Workers. */
export class WorkerChunkGenerator implements ChunkGenerator {
  private readonly pool: WorkerPool<GenRequest, GenResult>;
  readonly concurrency: number;

  constructor(private readonly seed: number, workers = defaultWorkerCount()) {
    this.pool = new WorkerPool(
      () => new Worker(new URL('../workers/worldgen.worker.ts', import.meta.url), { type: 'module' }),
      workers,
    );
    this.concurrency = workers * 2;
  }

  async generate(cx: number, cz: number): Promise<Chunk> {
    const r = await this.pool.run({ seed: this.seed, cx, cz });
    const c = new Chunk(r.cx, r.cz, r.blocks, r.light, r.heightmap, r.biomes);
    c.maxY = r.maxY;
    for (const [i, be] of r.blockEntities) c.blockEntities.set(i, be);
    return c;
  }

  terminate(): void {
    this.pool.terminate();
  }
}
