import { describe, expect, it } from 'vitest';
import { B } from '../src/shared/blocks/registry';
import { buildChunkMesh, PAD, paddedIndex } from '../src/shared/mesh/mesher';

function volume(height: number) {
  const blocks = new Uint16Array(PAD * PAD * height);
  const light = new Uint8Array(PAD * PAD * height).fill(0xf0);
  return { blocks, light, height };
}

const quads = (b: { index: ArrayLike<number> } | null) => (b ? b.index.length / 6 : 0);

describe('greedy mesher', () => {
  it('emits 6 faces for a single floating block', () => {
    const v = volume(4);
    v.blocks[paddedIndex(5, 1, 5)] = B.STONE;
    const out = buildChunkMesh(v);
    expect(quads(out.opaque)).toBe(6);
    expect(out.translucent).toBeNull();
    expect(out.minY).toBe(1);
    expect(out.maxY).toBe(1);
  });

  it('merges a uniformly lit 16×16 slab into 6 quads', () => {
    const v = volume(4);
    for (let z = -1; z <= 16; z++) for (let x = -1; x <= 16; x++) v.blocks[paddedIndex(x, 1, z)] = B.STONE;
    // Neighbours are solid too, so only top and bottom faces are visible.
    const out = buildChunkMesh(v);
    expect(quads(out.opaque)).toBe(2);
  });

  it('culls faces between blocks and keeps water separate', () => {
    const v = volume(4);
    v.blocks[paddedIndex(3, 1, 3)] = B.STONE;
    v.blocks[paddedIndex(4, 1, 3)] = B.STONE;
    v.blocks[paddedIndex(8, 1, 8)] = B.WATER;
    v.blocks[paddedIndex(9, 1, 8)] = B.WATER;
    const out = buildChunkMesh(v);
    // Two adjacent stones merge into one 2×1 box: 6 quads.
    expect(quads(out.opaque)).toBe(6);
    expect(quads(out.translucent)).toBe(6);
  });

  it('meshes plants as double-sided crosses', () => {
    const v = volume(4);
    v.blocks[paddedIndex(2, 1, 2)] = B.TALL_GRASS;
    const out = buildChunkMesh(v);
    expect(out.opaque!.index.length).toBe(2 * 4 * 3);
  });
});
