import { buildChunkMesh, type MeshBuffers, type MeshOutput } from '../shared/mesh/mesher';
import type { MeshRequest } from './types';
import { serveWorker } from './WorkerPool';

serveWorker<MeshRequest, MeshOutput>((req) => {
  const out = buildChunkMesh(req);
  const transfer: Transferable[] = [];
  const add = (b: MeshBuffers | null) => {
    if (b) transfer.push(b.pos.buffer, b.tex.buffer, b.light.buffer, b.index.buffer);
  };
  add(out.opaque);
  add(out.translucent);
  return { res: out, transfer };
});
