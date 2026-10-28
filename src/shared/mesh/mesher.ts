import { OPAQUE, RENDER, TEX_BOTTOM, TEX_SIDE, TEX_TOP, TRANSLUCENT } from '../blocks/registry';

// Greedy mesher for one chunk. Input is a padded volume: the chunk plus a one-block
// ring of its neighbours, so faces and smooth lighting at the edges are correct.
//   padded index = (x+1) + (z+1)*18 + y*324, x/z in [-1, 16], y in [0, height)
//
// Vertex format (16 bytes):
//   position Int16×3 in 1/16 block units (the mesh is scaled by 1/16)
//   tex      Uint8×4 (u, v in blocks, texture layer, face shade 0..255)
//   light    Uint8×4 (sky 0..15, block 0..15, ambient occlusion 0..3, unused)

export const PAD = 18;
const LAYER = PAD * PAD;

export interface MeshInput {
  blocks: Uint16Array;
  light: Uint8Array;
  /** Number of padded y layers. The top layer is only used as neighbour data. */
  height: number;
}

export interface MeshBuffers {
  pos: Int16Array;
  tex: Uint8Array;
  light: Uint8Array;
  index: Uint32Array | Uint16Array;
}

export interface MeshOutput {
  opaque: MeshBuffers | null;
  translucent: MeshBuffers | null;
  minY: number;
  maxY: number;
}

export function paddedIndex(x: number, y: number, z: number): number {
  return x + 1 + (z + 1) * PAD + y * LAYER;
}

class Builder {
  private pos = new Int16Array(4096 * 3);
  private tex = new Uint8Array(4096 * 4);
  private light = new Uint8Array(4096 * 4);
  private index = new Uint32Array(4096 * 6 / 4);
  verts = 0;
  private indices = 0;

  private grow(): void {
    const g = <T extends Int16Array | Uint8Array | Uint32Array>(a: T): T => {
      const n = new (a.constructor as new (len: number) => T)(a.length * 2);
      n.set(a);
      return n;
    };
    this.pos = g(this.pos);
    this.tex = g(this.tex);
    this.light = g(this.light);
    this.index = g(this.index);
  }

  vertex(x: number, y: number, z: number, u: number, v: number, layer: number, shade: number, sky: number, blk: number, ao: number): void {
    if ((this.verts + 1) * 3 > this.pos.length) this.grow();
    const p = this.verts * 3;
    this.pos[p] = x;
    this.pos[p + 1] = y;
    this.pos[p + 2] = z;
    const t = this.verts * 4;
    this.tex[t] = u;
    this.tex[t + 1] = v;
    this.tex[t + 2] = layer;
    this.tex[t + 3] = shade;
    this.light[t] = sky;
    this.light[t + 1] = blk;
    this.light[t + 2] = ao;
    this.verts++;
  }

  tri(a: number, b: number, c: number): void {
    if (this.indices + 3 > this.index.length) this.grow();
    this.index[this.indices++] = a;
    this.index[this.indices++] = b;
    this.index[this.indices++] = c;
  }

  finish(): MeshBuffers | null {
    if (this.verts === 0) return null;
    const index = this.index.slice(0, this.indices);
    return {
      pos: this.pos.slice(0, this.verts * 3),
      tex: this.tex.slice(0, this.verts * 4),
      light: this.light.slice(0, this.verts * 4),
      index: this.verts <= 65535 ? Uint16Array.from(index) : index,
    };
  }
}

// Face directions: +x, -x, +y, -y, +z, -z. (u, v) are the in-plane axes.
const AXIS = [0, 0, 1, 1, 2, 2];
const SIGN = [1, -1, 1, -1, 1, -1];
const U_AXIS = [2, 2, 0, 0, 0, 0];
const V_AXIS = [1, 1, 2, 2, 1, 1];
const SHADE = [204, 204, 255, 140, 166, 166];
// Sign of (u × v)·axis; together with SIGN it decides triangle winding.
const CROSS = [-1, -1, -1, -1, 1, 1];
const WATER_DROP = 2; // water surface sits 2/16 below the block top

/** Builds the mesh for the chunk in the middle of the padded volume. */
export function buildChunkMesh(input: MeshInput): MeshOutput {
  const { blocks, light, height } = input;
  const meshH = height - 1; // last padded layer is neighbour-only
  const builders = [new Builder(), new Builder()]; // opaque(+cutout), translucent
  const dims = [16, meshH, 16];
  let minY = 255;
  let maxY = 0;

  const blockAt = (x: number, y: number, z: number): number =>
    y < 0 ? 1 : y >= height ? 0 : blocks[paddedIndex(x, y, z)] & 0xfff;
  const lightAt = (x: number, y: number, z: number): number =>
    y < 0 ? 0 : y >= height ? 0xf0 : light[paddedIndex(x, y, z)];

  // Per-corner light: sky, block, ao for 4 corners
  const cSky = [0, 0, 0, 0];
  const cBlk = [0, 0, 0, 0];
  const cAo = [0, 0, 0, 0];
  const CU = [-1, 1, 1, -1];
  const CV = [-1, -1, 1, 1];

  const pos = [0, 0, 0];
  const n = [0, 0, 0];

  const mask = new Int32Array(16 * Math.max(16, meshH));

  const emitQuad = (
    dir: number, w: number, u0: number, v0: number, u1: number, v1: number,
    layer: number, mesh: number, waterTop: boolean,
  ): void => {
    const b = builders[mesh];
    const axis = AXIS[dir];
    const ua = U_AXIS[dir];
    const va = V_AXIS[dir];
    const plane = (w + (SIGN[dir] > 0 ? 1 : 0)) * 16;
    const base = b.verts;
    for (let k = 0; k < 4; k++) {
      const uc = k === 0 || k === 3 ? u0 : u1;
      const vc = k === 0 || k === 1 ? v0 : v1;
      const p = [0, 0, 0];
      p[axis] = plane;
      p[ua] = uc * 16;
      p[va] = vc * 16;
      if (waterTop) {
        if (axis === 1) p[1] -= WATER_DROP;
        else if (vc === v1) p[1] -= WATER_DROP;
      }
      b.vertex(p[0], p[1], p[2], uc - u0, vc - v0, layer, SHADE[dir], cSky[k], cBlk[k], cAo[k]);
    }
    const front = CROSS[dir] * SIGN[dir] > 0;
    // Split along the diagonal whose corners are brighter, to avoid AO artefacts.
    const d02 = cAo[0] + cAo[2] + (cSky[0] + cSky[2]) / 16;
    const d13 = cAo[1] + cAo[3] + (cSky[1] + cSky[3]) / 16;
    const [a, bb, c, d] = d02 >= d13 ? [0, 1, 2, 3] : [1, 2, 3, 0];
    if (front) {
      b.tri(base + a, base + bb, base + c);
      b.tri(base + a, base + c, base + d);
    } else {
      b.tri(base + a, base + c, base + bb);
      b.tri(base + a, base + d, base + c);
    }
  };

  for (let dir = 0; dir < 6; dir++) {
    const axis = AXIS[dir];
    const ua = U_AXIS[dir];
    const va = V_AXIS[dir];
    const du = dims[ua];
    const dv = dims[va];
    const dw = dims[axis];
    const sign = SIGN[dir];

    for (let w = 0; w < dw; w++) {
      mask.fill(0, 0, du * dv);
      pos[axis] = w;
      for (let v = 0; v < dv; v++) {
        pos[va] = v;
        for (let u = 0; u < du; u++) {
          pos[ua] = u;
          const x = pos[0];
          const y = pos[1];
          const z = pos[2];
          const id = blocks[paddedIndex(x, y, z)] & 0xfff;
          const r = RENDER[id];
          if (r !== 1 && r !== 3) continue;
          n[0] = x; n[1] = y; n[2] = z;
          n[axis] += sign;
          const nid = blockAt(n[0], n[1], n[2]);
          if (OPAQUE[nid]) continue;
          const translucent = TRANSLUCENT[id];
          // Translucent faces don't write depth, so hidden inner faces (ice over water)
          // would draw over the visible ones: skip faces between translucent blocks.
          if (translucent && TRANSLUCENT[nid]) continue;
          const mesh = translucent ? 1 : 0;
          const layer = axis === 1 ? (sign > 0 ? TEX_TOP[id] : TEX_BOTTOM[id]) : TEX_SIDE[id];
          const waterTop = r === 3 && blockAt(x, y + 1, z) !== id;

          let uniform: boolean;
          if (translucent) {
            const l = lightAt(n[0], n[1], n[2]);
            for (let k = 0; k < 4; k++) { cSky[k] = l >> 4; cBlk[k] = l & 15; cAo[k] = 3; }
            uniform = true;
          } else {
            // Smooth lighting + ambient occlusion from the 3 cells around each corner.
            const l0 = lightAt(n[0], n[1], n[2]);
            for (let k = 0; k < 4; k++) {
              const s1 = [n[0], n[1], n[2]];
              s1[ua] += CU[k];
              const s2 = [n[0], n[1], n[2]];
              s2[va] += CV[k];
              const sc = [s1[0], s1[1], s1[2]];
              sc[va] += CV[k];
              const o1 = OPAQUE[blockAt(s1[0], s1[1], s1[2])];
              const o2 = OPAQUE[blockAt(s2[0], s2[1], s2[2])];
              const oc = o1 && o2 ? 1 : OPAQUE[blockAt(sc[0], sc[1], sc[2])];
              cAo[k] = o1 && o2 ? 0 : 3 - (o1 + o2 + oc);
              let sky = l0 >> 4;
              let blk = l0 & 15;
              let cnt = 1;
              if (!o1) { const l = lightAt(s1[0], s1[1], s1[2]); sky += l >> 4; blk += l & 15; cnt++; }
              if (!o2) { const l = lightAt(s2[0], s2[1], s2[2]); sky += l >> 4; blk += l & 15; cnt++; }
              if (!oc) { const l = lightAt(sc[0], sc[1], sc[2]); sky += l >> 4; blk += l & 15; cnt++; }
              cSky[k] = Math.round(sky / cnt);
              cBlk[k] = Math.round(blk / cnt);
            }
            uniform =
              cSky[0] === cSky[1] && cSky[1] === cSky[2] && cSky[2] === cSky[3] &&
              cBlk[0] === cBlk[1] && cBlk[1] === cBlk[2] && cBlk[2] === cBlk[3] &&
              cAo[0] === cAo[1] && cAo[1] === cAo[2] && cAo[2] === cAo[3];
          }

          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          if (uniform) {
            mask[u + v * du] =
              1 + layer + (cSky[0] << 8) + (cBlk[0] << 12) + (cAo[0] << 16) + (mesh << 18) + ((waterTop ? 1 : 0) << 19);
          } else {
            emitQuad(dir, w, u, v, u + 1, v + 1, layer, mesh, waterTop);
          }
        }
      }

      // Greedy merge of identical uniform faces in this slice.
      for (let v = 0; v < dv; v++) {
        for (let u = 0; u < du; ) {
          const key = mask[u + v * du];
          if (key === 0) { u++; continue; }
          let width = 1;
          while (u + width < du && width < 255 && mask[u + width + v * du] === key) width++;
          let h = 1;
          grow: while (v + h < dv && h < 255) {
            for (let k = 0; k < width; k++) if (mask[u + k + (v + h) * du] !== key) break grow;
            h++;
          }
          for (let hh = 0; hh < h; hh++) mask.fill(0, u + (v + hh) * du, u + width + (v + hh) * du);
          const packed = key - 1;
          const layer = packed & 0xff;
          const sky = (packed >> 8) & 15;
          const blk = (packed >> 12) & 15;
          const ao = (packed >> 16) & 3;
          for (let k = 0; k < 4; k++) { cSky[k] = sky; cBlk[k] = blk; cAo[k] = ao; }
          emitQuad(dir, w, u, v, u + width, v + h, layer, (packed >> 18) & 1, ((packed >> 19) & 1) === 1);
          u += width;
        }
      }
    }
  }

  // Cross-shaped plants: two double-sided diagonal quads.
  const ob = builders[0];
  for (let y = 0; y < meshH; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const id = blocks[paddedIndex(x, y, z)] & 0xfff;
        if (RENDER[id] !== 2) continue;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        const l = lightAt(x, y, z);
        const layer = TEX_SIDE[id];
        const x0 = x * 16 + 2;
        const x1 = x * 16 + 14;
        const z0 = z * 16 + 2;
        const z1 = z * 16 + 14;
        const y0 = y * 16;
        const y1 = y * 16 + 16;
        const diagonals = [[x0, z0, x1, z1], [x1, z0, x0, z1]];
        for (const [ax, az, bx, bz] of diagonals) {
          const base = ob.verts;
          ob.vertex(ax, y0, az, 0, 0, layer, 230, l >> 4, l & 15, 3);
          ob.vertex(bx, y0, bz, 1, 0, layer, 230, l >> 4, l & 15, 3);
          ob.vertex(bx, y1, bz, 1, 1, layer, 230, l >> 4, l & 15, 3);
          ob.vertex(ax, y1, az, 0, 1, layer, 230, l >> 4, l & 15, 3);
          ob.tri(base, base + 1, base + 2);
          ob.tri(base, base + 2, base + 3);
          ob.tri(base, base + 2, base + 1);
          ob.tri(base, base + 3, base + 2);
        }
      }
    }
  }

  if (minY > maxY) { minY = 0; maxY = 0; }
  return { opaque: builders[0].finish(), translucent: builders[1].finish(), minY, maxY };
}
