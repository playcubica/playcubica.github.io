import * as THREE from 'three';
import { TEXTURE_NAMES } from '../../shared/blocks/registry';
import { paintTexture, TEX_SIZE } from './procedural';

export interface BlockTextures {
  /** Every texture tiled into one canvas (for UI icons and debugging). */
  atlas: HTMLCanvasElement;
  /** The same tiles as WebGL2 array layers, so greedy-meshed quads can repeat a tile. */
  array: THREE.DataArrayTexture;
}

const ATLAS_COLUMNS = 8;

/** Top-left pixel of a texture layer inside the atlas canvas. */
export function atlasTile(layer: number): [number, number] {
  return [(layer % ATLAS_COLUMNS) * TEX_SIZE, Math.floor(layer / ATLAS_COLUMNS) * TEX_SIZE];
}

export function buildBlockTextures(): BlockTextures {
  const count = TEXTURE_NAMES.length;
  const rows = Math.ceil(count / ATLAS_COLUMNS);
  const atlas = document.createElement('canvas');
  atlas.width = ATLAS_COLUMNS * TEX_SIZE;
  atlas.height = rows * TEX_SIZE;
  const ctx = atlas.getContext('2d')!;

  const layerBytes = TEX_SIZE * TEX_SIZE * 4;
  const data = new Uint8Array(layerBytes * count);
  TEXTURE_NAMES.forEach((name, layer) => {
    const pix = paintTexture(name);
    const [sx, sy] = atlasTile(layer);
    ctx.putImageData(new ImageData(pix.data, TEX_SIZE, TEX_SIZE), sx, sy);
    // Layers are read back from the atlas, so the atlas is the single source of truth.
    const tile = ctx.getImageData(sx, sy, TEX_SIZE, TEX_SIZE);
    data.set(tile.data, layer * layerBytes);
  });

  const array = new THREE.DataArrayTexture(data, TEX_SIZE, TEX_SIZE, count);
  array.format = THREE.RGBAFormat;
  array.type = THREE.UnsignedByteType;
  array.magFilter = THREE.NearestFilter;
  array.minFilter = THREE.NearestMipmapLinearFilter;
  array.generateMipmaps = true;
  array.wrapS = THREE.RepeatWrapping;
  array.wrapT = THREE.RepeatWrapping;
  array.needsUpdate = true;
  return { atlas, array };
}
