import type { BlockEntity } from '../shared/world/blockEntities';

export interface GenRequest {
  seed: number;
  cx: number;
  cz: number;
}

export interface GenResult {
  cx: number;
  cz: number;
  blocks: Uint16Array;
  light: Uint8Array;
  heightmap: Uint8Array;
  biomes: Uint8Array;
  maxY: number;
  blockEntities: Array<[number, BlockEntity]>;
}

export interface MeshRequest {
  blocks: Uint16Array;
  light: Uint8Array;
  height: number;
}
