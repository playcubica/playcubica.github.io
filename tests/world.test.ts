import { describe, expect, it } from 'vitest';
import { B } from '../src/shared/blocks/registry';
import { SEA_LEVEL } from '../src/shared/constants';
import { Simplex } from '../src/shared/noise/simplex';
import { Biome } from '../src/shared/world/biomes';
import { Chunk, chunkKey, idx } from '../src/shared/world/Chunk';
import { decodeChunk, encodeChunk } from '../src/shared/world/chunkCodec';
import { computeChunkLight, mergeChunkBorders, updateLightAt, type ChunkSource } from '../src/shared/world/lighting';
import { WorldGenerator } from '../src/server/worldgen/WorldGenerator';

describe('simplex noise', () => {
  it('is deterministic per seed and bounded', () => {
    const a = new Simplex(42);
    const b = new Simplex(42);
    const c = new Simplex(43);
    let differs = false;
    for (let i = 0; i < 500; i++) {
      const x = i * 0.37;
      const y = i * 0.11;
      const z = i * 0.53;
      expect(a.noise2(x, y)).toBe(b.noise2(x, y));
      expect(a.noise3(x, y, z)).toBe(b.noise3(x, y, z));
      expect(Math.abs(a.noise3(x, y, z))).toBeLessThanOrEqual(1.01);
      if (a.noise2(x, y) !== c.noise2(x, y)) differs = true;
    }
    expect(differs).toBe(true);
  });
});

describe('world generation', () => {
  const gen = new WorldGenerator(1234);

  it('produces identical chunks for the same seed', () => {
    const a = new WorldGenerator(1234).generate(3, -2);
    const b = gen.generate(3, -2);
    expect(a.blocks).toEqual(b.blocks);
    expect(a.biomes).toEqual(b.biomes);
  });

  it('has corerock at y=0 and fills oceans up to sea level', () => {
    for (let cx = -4; cx <= 4; cx++) {
      const c = gen.generate(cx, cx * 2);
      for (let col = 0; col < 256; col++) expect(c.blocks[col]).toBe(B.COREROCK);
      for (let col = 0; col < 256; col++) {
        if (c.biomes[col] !== Biome.OCEAN) continue;
        const top = c.blocks[idx(col & 15, SEA_LEVEL, col >> 4)];
        expect(top).toBe(B.WATER);
      }
    }
  });

  it('generates several biomes across a wide area', () => {
    const seen = new Set<number>();
    for (let x = -6000; x <= 6000; x += 250) {
      for (let z = -6000; z <= 6000; z += 250) seen.add(gen.column(x, z).biome);
    }
    for (const b of [Biome.OCEAN, Biome.PLAINS, Biome.FOREST, Biome.DESERT, Biome.SNOW, Biome.MOUNTAINS]) {
      expect(seen.has(b), `biome ${b}`).toBe(true);
    }
  });

  it('places ores and caves underground', () => {
    const counts = new Map<number, number>();
    let air = 0;
    for (let cx = 0; cx < 6; cx++) {
      for (let cz = 0; cz < 6; cz++) {
        const c = gen.generate(cx, cz);
        for (let i = 0; i < 40 * 256; i++) {
          const id = c.blocks[i];
          counts.set(id, (counts.get(id) ?? 0) + 1);
          if (id === B.AIR && i >= 5 * 256) air++;
        }
      }
    }
    expect(counts.get(B.COAL_ORE) ?? 0).toBeGreaterThan(0);
    expect(counts.get(B.IRON_ORE) ?? 0).toBeGreaterThan(0);
    expect(counts.get(B.GOLD_ORE) ?? 0).toBeGreaterThan(0);
    expect(air).toBeGreaterThan(0);
  });

  it('finds a dry spawn point', () => {
    const [x, y, z] = gen.findSpawn();
    expect(y).toBeGreaterThan(SEA_LEVEL);
    expect(gen.column(Math.floor(x), Math.floor(z)).height).toBe(y - 1);
  });
});

describe('chunk codec', () => {
  it('round-trips generated chunks', () => {
    const c = new WorldGenerator(99).generate(-7, 11);
    computeChunkLight(c);
    const bytes = encodeChunk(c);
    expect(bytes.length).toBeLessThan(c.blocks.byteLength);
    const d = decodeChunk(bytes);
    expect(d.cx).toBe(-7);
    expect(d.cz).toBe(11);
    expect(d.blocks).toEqual(c.blocks);
    expect(d.light).toEqual(c.light);
    expect(d.biomes).toEqual(c.biomes);
    expect(d.maxY).toBe(c.maxY);
  });

  it('rejects truncated data', () => {
    const c = new WorldGenerator(1).generate(0, 0);
    const bytes = encodeChunk(c);
    expect(() => decodeChunk(bytes.subarray(0, bytes.length - 10))).toThrow();
  });
});

function flatChunk(cx: number, cz: number, groundY: number): Chunk {
  const c = new Chunk(cx, cz);
  for (let y = 0; y <= groundY; y++) for (let i = 0; i < 256; i++) c.blocks[(y << 8) | i] = B.STONE;
  c.recomputeHeights();
  return c;
}

function sourceOf(chunks: Chunk[]): ChunkSource {
  const m = new Map(chunks.map((c) => [chunkKey(c.cx, c.cz), c]));
  return { getChunk: (cx, cz) => m.get(chunkKey(cx, cz)) };
}

describe('lighting', () => {
  it('lights open sky at 15 and solid ground at 0', () => {
    const c = flatChunk(0, 0, 10);
    computeChunkLight(c);
    expect(c.skyLight(5, 11, 5)).toBe(15);
    expect(c.skyLight(5, 200, 5)).toBe(15);
    expect(c.skyLight(5, 10, 5)).toBe(0);
  });

  it('spreads block light with falloff', () => {
    const c = flatChunk(0, 0, 10);
    c.setBlock(8, 11, 8, B.LUMEN_CRYSTAL);
    computeChunkLight(c);
    expect(c.blockLight(8, 11, 8)).toBe(15);
    expect(c.blockLight(9, 11, 8)).toBe(14);
    expect(c.blockLight(12, 11, 8)).toBe(11);
    expect(c.blockLight(8, 13, 8)).toBe(13);
  });

  it('carries light across chunk borders when merged', () => {
    const a = flatChunk(0, 0, 10);
    const b = flatChunk(1, 0, 10);
    a.setBlock(15, 11, 4, B.LUMEN_CRYSTAL);
    computeChunkLight(a);
    computeChunkLight(b);
    expect(b.blockLight(0, 11, 4)).toBe(0);
    const touched = mergeChunkBorders(sourceOf([a, b]), b);
    expect(b.blockLight(0, 11, 4)).toBe(14);
    expect(b.blockLight(3, 11, 4)).toBe(11);
    expect(touched.has(b)).toBe(true);
  });

  it('updates incrementally when a light source is removed or a roof is placed', () => {
    const c = flatChunk(0, 0, 10);
    c.setBlock(8, 11, 8, B.LUMEN_CRYSTAL);
    computeChunkLight(c);
    const src = sourceOf([c]);
    c.setBlock(8, 11, 8, B.AIR);
    updateLightAt(src, 8, 11, 8);
    expect(c.blockLight(8, 11, 8)).toBe(0);
    expect(c.blockLight(10, 11, 8)).toBe(0);

    // A one-block roof shades the cell under it, but sideways light still leaks in.
    c.setBlock(4, 12, 4, B.STONE);
    updateLightAt(src, 4, 12, 4);
    expect(c.skyLight(4, 11, 4)).toBe(14);
    c.setBlock(4, 12, 4, B.AIR);
    updateLightAt(src, 4, 12, 4);
    expect(c.skyLight(4, 11, 4)).toBe(15);
  });
});
