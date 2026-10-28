import { WorldGenerator } from '../server/worldgen/WorldGenerator';
import { computeChunkLight } from '../shared/world/lighting';
import type { GenRequest, GenResult } from './types';
import { serveWorker } from './WorkerPool';

let gen: WorldGenerator | null = null;

serveWorker<GenRequest, GenResult>((req) => {
  if (!gen || gen.seed !== req.seed) gen = new WorldGenerator(req.seed);
  const c = gen.generate(req.cx, req.cz);
  computeChunkLight(c);
  return {
    res: { cx: c.cx, cz: c.cz, blocks: c.blocks, light: c.light, heightmap: c.heightmap, biomes: c.biomes, maxY: c.maxY, blockEntities: [...c.blockEntities] },
    transfer: [c.blocks.buffer, c.light.buffer, c.heightmap.buffer, c.biomes.buffer],
  };
});
