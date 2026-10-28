import * as THREE from 'three';
import { chunkKey, idx } from '../../shared/world/Chunk';
import { PAD, type MeshBuffers, type MeshOutput } from '../../shared/mesh/mesher';
import type { MeshRequest } from '../../workers/types';
import { defaultWorkerCount, WorkerPool } from '../../workers/WorkerPool';
import type { ClientWorld } from '../ClientWorld';
import type { ChunkMaterials } from './chunkMaterial';

interface ChunkMeshes {
  opaque: THREE.Mesh | null;
  translucent: THREE.Mesh | null;
}

/** Max milliseconds per frame spent uploading finished meshes to the GPU. */
const UPLOAD_BUDGET_MS = 3;

/**
 * Keeps one opaque and one translucent mesh per chunk in sync with ClientWorld.
 * Meshing runs on worker threads, nearest chunks first; uploads are time-budgeted.
 */
export class ChunkMeshManager {
  private readonly pool: WorkerPool<MeshRequest, MeshOutput>;
  private readonly dirty = new Map<string, [number, number]>();
  private readonly inflight = new Set<string>();
  private readonly meshes = new Map<string, ChunkMeshes>();
  private readonly ready: Array<{ key: string; cx: number; cz: number; out: MeshOutput }> = [];

  constructor(
    private readonly world: ClientWorld,
    private readonly scene: THREE.Scene,
    private readonly materials: ChunkMaterials,
  ) {
    this.pool = new WorkerPool(
      () => new Worker(new URL('../../workers/mesher.worker.ts', import.meta.url), { type: 'module' }),
      defaultWorkerCount(),
    );
  }

  get meshedCount(): number {
    return this.meshes.size;
  }

  get pendingCount(): number {
    return this.dirty.size + this.inflight.size;
  }

  markDirty(cx: number, cz: number): void {
    if (this.world.has(cx, cz)) this.dirty.set(chunkKey(cx, cz), [cx, cz]);
  }

  /** Marks a chunk and its 8 neighbours (their meshes sample its border). */
  markAround(cx: number, cz: number): void {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) this.markDirty(cx + dx, cz + dz);
  }

  remove(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    this.dirty.delete(key);
    this.disposeMeshes(key);
  }

  update(playerX: number, playerZ: number): void {
    const pcx = Math.floor(playerX / 16);
    const pcz = Math.floor(playerZ / 16);

    // Dispatch nearest dirty chunks that have all their neighbours.
    while (this.inflight.size < this.pool.size * 2) {
      let best: string | null = null;
      let bestD = Infinity;
      for (const [key, [cx, cz]] of this.dirty) {
        if (this.inflight.has(key)) continue;
        if (!this.world.has(cx, cz)) {
          this.dirty.delete(key);
          continue;
        }
        const d = (cx - pcx) ** 2 + (cz - pcz) ** 2;
        if (d < bestD && this.world.hasNeighbourhood(cx, cz)) {
          bestD = d;
          best = key;
        }
      }
      if (best === null) break;
      const [cx, cz] = this.dirty.get(best)!;
      this.dirty.delete(best);
      this.dispatch(best, cx, cz);
    }

    // Upload finished meshes within the frame budget.
    const start = performance.now();
    while (this.ready.length > 0 && performance.now() - start < UPLOAD_BUDGET_MS) {
      const { key, cx, cz, out } = this.ready.shift()!;
      if (!this.world.has(cx, cz)) continue;
      this.disposeMeshes(key);
      const meshes: ChunkMeshes = {
        opaque: this.createMesh(out.opaque, this.materials.opaque, cx, cz, out),
        translucent: this.createMesh(out.translucent, this.materials.translucent, cx, cz, out),
      };
      this.meshes.set(key, meshes);
    }
  }

  private dispatch(key: string, cx: number, cz: number): void {
    const req = this.buildPadded(cx, cz);
    this.inflight.add(key);
    this.pool.run(req, [req.blocks.buffer, req.light.buffer]).then(
      (out) => {
        this.inflight.delete(key);
        this.ready.push({ key, cx, cz, out });
      },
      (err) => {
        this.inflight.delete(key);
        console.error('meshing failed', key, err);
      },
    );
  }

  /** Copies the chunk plus a 1-block ring of neighbours into a padded volume. */
  private buildPadded(cx: number, cz: number): MeshRequest {
    let maxY = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) maxY = Math.max(maxY, this.world.getChunk(cx + dx, cz + dz)!.maxY);
    }
    const height = Math.min(256, maxY + 2);
    const layer = PAD * PAD;
    const blocks = new Uint16Array(layer * height);
    const light = new Uint8Array(layer * height);
    for (let pz = 0; pz < PAD; pz++) {
      const lz = pz - 1;
      const ncz = lz < 0 ? -1 : lz > 15 ? 1 : 0;
      for (let px = 0; px < PAD; px++) {
        const lx = px - 1;
        const ncx = lx < 0 ? -1 : lx > 15 ? 1 : 0;
        const c = this.world.getChunk(cx + ncx, cz + ncz)!;
        const col = idx(lx & 15, 0, lz & 15);
        let o = px + pz * PAD;
        for (let y = 0; y < height; y++, o += layer) {
          blocks[o] = c.blocks[col + (y << 8)];
          light[o] = c.light[col + (y << 8)];
        }
      }
    }
    return { blocks, light, height };
  }

  private createMesh(buf: MeshBuffers | null, material: THREE.Material, cx: number, cz: number, out: MeshOutput): THREE.Mesh | null {
    if (!buf) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Int16BufferAttribute(buf.pos, 3));
    geo.setAttribute('aTex', new THREE.Uint8BufferAttribute(buf.tex, 4));
    geo.setAttribute('aLight', new THREE.Uint8BufferAttribute(buf.light, 4));
    geo.setIndex(new THREE.BufferAttribute(buf.index, 1));
    // Geometry is in 1/16-block units; bounds must match for frustum culling.
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(0, out.minY * 16, 0), new THREE.Vector3(256, (out.maxY + 1) * 16, 256));
    geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(cx * 16, 0, cz * 16);
    mesh.scale.setScalar(1 / 16);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.scene.add(mesh);
    return mesh;
  }

  private disposeMeshes(key: string): void {
    const m = this.meshes.get(key);
    if (!m) return;
    for (const mesh of [m.opaque, m.translucent]) {
      if (!mesh) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.meshes.delete(key);
  }

  dispose(): void {
    for (const key of [...this.meshes.keys()]) this.disposeMeshes(key);
    this.pool.terminate();
  }
}
