import { B } from '../../shared/blocks/registry';
import { SEA_LEVEL } from '../../shared/constants';
import { fbm2, Simplex } from '../../shared/noise/simplex';
import { hash01, hash3i, mulberry32 } from '../../shared/rng';
import { Biome } from '../../shared/world/biomes';
import { Chunk, idx } from '../../shared/world/Chunk';
import { ashwoodTree, frostpineTree, type BlockSetter } from './trees';
import { DEEP_CEILING, isDeep } from '../../shared/world/dimensions';
import { buildSettlement, settlementsTouching } from './settlements';

// Deterministic terrain generator: the same seed always yields the same chunk,
// and every chunk can be generated independently (trees that cross chunk borders
// are re-derived from neighbouring columns instead of being queued).

export interface ColumnInfo {
  height: number;
  biome: number;
}

/** Piecewise-linear curve mapping continentalness to base terrain height. */
const CONTINENT_SPLINE: Array<[number, number]> = [
  [-1, 30], [-0.5, 38], [-0.25, 50], [-0.12, 59], [-0.04, 63], [0.1, 66], [0.4, 74], [1, 92],
];

function spline(points: Array<[number, number]>, t: number): number {
  if (t <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (t <= x1) {
      const [x0, y0] = points[i - 1];
      return y0 + ((t - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return points[points.length - 1][1];
}

function smoothstep(a: number, b: number, t: number): number {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
}

const ORES = [
  { id: B.COAL_ORE, tries: 22, minY: 5, maxY: 128, size: 9 },
  { id: B.IRON_ORE, tries: 16, minY: 5, maxY: 64, size: 7 },
  { id: B.GOLD_ORE, tries: 5, minY: 5, maxY: 32, size: 6 },
  { id: B.DIAMOND_ORE, tries: 2, minY: 5, maxY: 16, size: 5 },
];

/** Columns sampled around the chunk so trees from neighbours can reach in. */
const MARGIN = 3;
const REGION = 16 + MARGIN * 2;

export class WorldGenerator {
  private readonly continent: Simplex;
  private readonly mountain: Simplex;
  private readonly ridge: Simplex;
  private readonly detail: Simplex;
  private readonly temperature: Simplex;
  private readonly humidity: Simplex;
  private readonly caveA: Simplex;
  private readonly caveB: Simplex;
  private readonly caveC: Simplex;

  constructor(readonly seed: number) {
    const s = (k: number) => hash3i(seed, k, 0x51, 0x7a);
    this.continent = new Simplex(s(1));
    this.mountain = new Simplex(s(2));
    this.ridge = new Simplex(s(3));
    this.detail = new Simplex(s(4));
    this.temperature = new Simplex(s(5));
    this.humidity = new Simplex(s(6));
    this.caveA = new Simplex(s(7));
    this.caveB = new Simplex(s(8));
    this.caveC = new Simplex(s(9));
  }

  /** Surface height and biome of a world column. Pure function of (seed, x, z). */
  column(x: number, z: number): ColumnInfo {
    const c = fbm2(this.continent, x / 900, z / 900, 4) * 1.4;
    let h = spline(CONTINENT_SPLINE, c);
    const land = smoothstep(-0.1, 0.06, c);
    const mf = smoothstep(0.15, 0.55, fbm2(this.mountain, x / 520, z / 520, 3)) * land;
    const r = 1 - Math.abs(this.ridge.noise2(x / 170, z / 170));
    h += mf * (28 + r * r * 75);
    h += fbm2(this.detail, x / 48, z / 48, 3) * (2.5 + mf * 7);
    const height = Math.max(8, Math.min(240, Math.floor(h)));

    let temp = fbm2(this.temperature, x / 1100, z / 1100, 2) * 1.3;
    const hum = fbm2(this.humidity, x / 900 + 300, z / 900 - 300, 2) * 1.3;
    temp -= Math.max(0, height - 90) / 110;

    let biome: number;
    if (height < SEA_LEVEL - 1) biome = temp < -0.35 ? Biome.FROZEN_OCEAN : Biome.OCEAN;
    else if (mf > 0.45 && height > 92) biome = Biome.MOUNTAINS;
    else if (temp < -0.3) biome = Biome.SNOW;
    else if (temp > 0.28 && hum < 0.1) biome = Biome.DESERT;
    else if (height <= SEA_LEVEL + 1) biome = Biome.BEACH;
    else if (hum > 0.05) biome = Biome.FOREST;
    else biome = Biome.PLAINS;
    return { height, biome };
  }

  /** True where caves carve the terrain. */
  isCave(x: number, y: number, z: number, surface: number): boolean {
    if (y < 5) return false;
    // Keep a seal under oceans and low beaches so water never floods into floating holes.
    if (surface <= SEA_LEVEL + 2 && y > surface - 5) return false;
    const sx = x / 45;
    const sy = y / 28;
    const sz = z / 45;
    const a = this.caveA.noise3(sx, sy, sz);
    if (Math.abs(a) < 0.085 && Math.abs(this.caveB.noise3(sx, sy, sz)) < 0.085) return true; // tunnels
    if (y < surface - 10 && this.caveC.noise3(x / 70, y / 38, z / 70) > 0.62) return true; // caverns
    return false;
  }

  generate(cx: number, cz: number): Chunk {
    if (isDeep(cx * 16)) return this.generateDeep(cx, cz);
    const chunk = new Chunk(cx, cz);
    const bx = cx * 16;
    const bz = cz * 16;
    const seed = this.seed;

    // Column info for the chunk plus margin.
    const heights = new Int16Array(REGION * REGION);
    const biomes = new Uint8Array(REGION * REGION);
    for (let rz = 0; rz < REGION; rz++) {
      for (let rx = 0; rx < REGION; rx++) {
        const info = this.column(bx + rx - MARGIN, bz + rz - MARGIN);
        heights[rx + rz * REGION] = info.height;
        biomes[rx + rz * REGION] = info.biome;
      }
    }
    const hAt = (lx: number, lz: number) => heights[lx + MARGIN + (lz + MARGIN) * REGION];
    const bAt = (lx: number, lz: number) => biomes[lx + MARGIN + (lz + MARGIN) * REGION];

    const set = (lx: number, y: number, lz: number, id: number, onlyAir: boolean): void => {
      if (lx < 0 || lx > 15 || lz < 0 || lz > 15 || y < 0 || y > 255) return;
      const i = idx(lx, y, lz);
      if (onlyAir && chunk.blocks[i] !== B.AIR) return;
      chunk.blocks[i] = id;
    };

    // --- Terrain, caves and water ---
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const wx = bx + lx;
        const wz = bz + lz;
        const h = hAt(lx, lz);
        const biome = bAt(lx, lz);
        chunk.biomes[lx | (lz << 4)] = biome;
        const slope = Math.max(
          Math.abs(hAt(lx + 1, lz) - h), Math.abs(hAt(lx - 1, lz) - h),
          Math.abs(hAt(lx, lz + 1) - h), Math.abs(hAt(lx, lz - 1) - h),
        );

        let top: number = B.GRASS;
        let filler: number = B.DIRT;
        let depth = 3;
        switch (biome) {
          case Biome.OCEAN:
          case Biome.FROZEN_OCEAN: {
            const f = hash01(seed ^ 0x0cea, wx >> 2, 0, wz >> 2);
            top = filler = f < 0.6 ? B.SAND : f < 0.85 ? B.GRAVEL : B.CLAY;
            break;
          }
          case Biome.BEACH:
            top = filler = B.SAND;
            depth = 4;
            break;
          case Biome.DESERT:
            top = filler = B.SAND;
            depth = 4;
            break;
          case Biome.SNOW:
            top = B.FROST_TURF;
            break;
          case Biome.MOUNTAINS:
            if (h > 150) { top = B.SNOW; filler = B.SNOW; depth = 2; }
            else if (h > 118 || slope > 3) { top = B.STONE; filler = B.STONE; }
            break;
          default:
            if (slope > 4) { top = B.STONE; filler = B.STONE; }
        }

        for (let y = 0; y <= Math.max(h, SEA_LEVEL); y++) {
          let id: number;
          if (y === 0 || (y <= 4 && hash01(seed ^ 0xbed, wx, y, wz) < (5 - y) * 0.2)) {
            id = B.COREROCK;
          } else if (y <= h) {
            if (this.isCave(wx, y, wz, h)) id = B.AIR;
            else {
              const d = h - y;
              id = d === 0 ? top : d <= depth ? filler : B.STONE;
              if (biome === Biome.DESERT && d > depth && d <= depth + 3) id = B.DUNESTONE;
            }
          } else {
            id = biome === Biome.FROZEN_OCEAN && y === SEA_LEVEL ? B.ICE : B.WATER;
          }
          chunk.blocks[idx(lx, y, lz)] = id;
        }
      }
    }

    // --- Ores (veins clipped to this chunk) ---
    for (let k = 0; k < ORES.length; k++) {
      const ore = ORES[k];
      const rnd = mulberry32(hash3i(seed ^ 0x0e5, cx, k, cz));
      for (let t = 0; t < ore.tries; t++) {
        let x = Math.floor(rnd() * 16);
        let y = ore.minY + Math.floor(rnd() * (ore.maxY - ore.minY));
        let z = Math.floor(rnd() * 16);
        for (let s = 0; s < ore.size; s++) {
          if (x >= 0 && x < 16 && z >= 0 && z < 16 && y > 0 && chunk.blocks[idx(x, y, z)] === B.STONE) {
            chunk.blocks[idx(x, y, z)] = ore.id;
          }
          const r = rnd();
          if (r < 0.33) x += rnd() < 0.5 ? -1 : 1;
          else if (r < 0.66) y += rnd() < 0.5 ? -1 : 1;
          else z += rnd() < 0.5 ? -1 : 1;
        }
      }
    }

    // --- Lumen crystals: rare glowing clusters hanging from cave ceilings ---
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const top = Math.min(hAt(lx, lz) - 6, 60);
        for (let y = 6; y < top; y++) {
          const i = idx(lx, y, lz);
          if (chunk.blocks[i] !== B.AIR || chunk.blocks[i + 256] !== B.STONE) continue;
          if (hash01(seed ^ 0x1c3, bx + lx, y, bz + lz) < 0.006) chunk.blocks[i + 256] = B.LUMEN_CRYSTAL;
        }
      }
    }

    // --- Ground plants (this chunk only) ---
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const h = hAt(lx, lz);
        if (h <= SEA_LEVEL || h >= 255) continue;
        const ground = chunk.blocks[idx(lx, h, lz)];
        if (chunk.blocks[idx(lx, h + 1, lz)] !== B.AIR) continue;
        const r = hash01(seed ^ 0x9a55, bx + lx, h, bz + lz);
        const biome = bAt(lx, lz);
        let plant = 0;
        if (ground === B.GRASS) {
          const grassChance = biome === Biome.PLAINS ? 0.2 : 0.08;
          if (r < 0.02) plant = r < 0.012 ? B.SUNBLOOM : B.BLUEBELL;
          else if (r < 0.02 + grassChance) plant = B.TALL_GRASS;
        } else if (ground === B.SAND && biome === Biome.DESERT && r < 0.01) {
          plant = B.DRY_SCRUB;
        }
        if (plant) chunk.blocks[idx(lx, h + 1, lz)] = plant;
      }
    }

    // --- Trees, including ones rooted in neighbouring columns ---
    for (let lz = -MARGIN; lz < 16 + MARGIN; lz++) {
      for (let lx = -MARGIN; lx < 16 + MARGIN; lx++) {
        const wx = bx + lx;
        const wz = bz + lz;
        const biome = bAt(lx, lz);
        const h = hAt(lx, lz);
        if (h <= SEA_LEVEL || h > 200) continue;
        let chance = 0;
        if (biome === Biome.FOREST) chance = 0.045;
        else if (biome === Biome.PLAINS) chance = 0.005;
        else if (biome === Biome.SNOW) chance = 0.022;
        else if (biome === Biome.MOUNTAINS && h < 118) chance = 0.012;
        else if (biome === Biome.DESERT) chance = 0.006;
        if (chance === 0) continue;
        const r = hash01(seed ^ 0x7ee5, wx, 0, wz);
        if (r >= chance) continue;
        if (this.isCave(wx, h, wz, h)) continue;
        const variant = hash3i(seed ^ 0x7ee6, wx, 0, wz);
        const inside = lx >= 0 && lx < 16 && lz >= 0 && lz < 16;

        if (biome === Biome.DESERT) {
          if (!inside) continue;
          const tall = 1 + (variant % 3);
          for (let y = 1; y <= tall; y++) set(lx, h + y, lz, B.CACTUS, false);
          continue;
        }

        const pine = biome === Biome.SNOW || (biome === Biome.MOUNTAINS && (variant & 1) === 0);
        const worldSet: BlockSetter = (x, y, z, id, onlyAir) => set(x - bx, y, z - bz, id, onlyAir);
        if (pine) frostpineTree(worldSet, wx, h, wz, variant);
        else ashwoodTree(worldSet, wx, h, wz, variant, seed);
        if (inside) set(lx, h, lz, B.DIRT, false);
      }
    }

    // --- Settlements (only the part inside this chunk) ---
    for (const st of settlementsTouching(this, bx, bz, bx + 15, bz + 15)) {
      buildSettlement(st, this, (x, y, z, raw) => {
        const lx = x - bx;
        const lz = z - bz;
        if (lx >= 0 && lx < 16 && lz >= 0 && lz < 16 && y >= 0 && y < 256) chunk.blocks[idx(lx, y, lz)] = raw;
      }, (x, y, z, be) => {
        const lx = x - bx;
        const lz = z - bz;
        if (lx >= 0 && lx < 16 && lz >= 0 && lz < 16) chunk.blockEntities.set(idx(lx, y, lz), be);
      });
    }

    chunk.recomputeHeights();
    return chunk;
  }

  /** The Ember Deep: caverns of ashstone between corerock floor and ceiling, magma lakes below. */
  generateDeep(cx: number, cz: number): Chunk {
    const chunk = new Chunk(cx, cz);
    const bx = cx * 16;
    const bz = cz * 16;
    const seed = this.seed;
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const wx = bx + lx;
        const wz = bz + lz;
        chunk.biomes[lx | (lz << 4)] = Biome.EMBER_DEEP;
        for (let y = 0; y <= DEEP_CEILING; y++) {
          const shell = y === 0 || y === DEEP_CEILING ||
            (y < 4 && hash01(seed ^ 0xbed, wx, y, wz) < (4 - y) * 0.25) ||
            (y > DEEP_CEILING - 4 && hash01(seed ^ 0xbee, wx, y, wz) < (y - DEEP_CEILING + 4) * 0.25);
          let id: number;
          if (shell) id = B.COREROCK;
          else {
            const n = this.caveA.noise3(wx / 52, y / 30, wz / 52) + 0.4 * this.caveB.noise3(wx / 18, y / 14, wz / 18);
            const bias = y < 26 ? (26 - y) * 0.03 : y > 100 ? (y - 100) * 0.04 : 0;
            if (n - bias > 0.08) id = y <= 24 ? B.MAGMA : B.AIR;
            else id = this.caveC.noise3(wx / 13, y / 13, wz / 13) > 0.5 ? B.EMBERSTONE : B.ASHSTONE;
          }
          chunk.blocks[idx(lx, y, lz)] = id;
        }
      }
    }
    // Ember ore veins, and lumen crystals hanging from cavern ceilings.
    const rnd = mulberry32(hash3i(seed ^ 0xe3b, cx, 7, cz));
    for (let t = 0; t < 12; t++) {
      let x = Math.floor(rnd() * 16);
      let y = 8 + Math.floor(rnd() * 110);
      let z = Math.floor(rnd() * 16);
      for (let k = 0; k < 5; k++) {
        if (x >= 0 && x < 16 && z >= 0 && z < 16 && chunk.blocks[idx(x, y, z)] === B.ASHSTONE) chunk.blocks[idx(x, y, z)] = B.EMBER_ORE;
        const r = rnd();
        if (r < 0.33) x += rnd() < 0.5 ? -1 : 1;
        else if (r < 0.66) y += rnd() < 0.5 ? -1 : 1;
        else z += rnd() < 0.5 ? -1 : 1;
      }
    }
    for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) for (let y = 30; y < DEEP_CEILING - 4; y++) {
      const i = idx(lx, y, lz);
      if (chunk.blocks[i] === B.AIR && chunk.blocks[i + 256] === B.ASHSTONE && hash01(seed ^ 0x1c4, bx + lx, y, bz + lz) < 0.01) {
        chunk.blocks[i + 256] = B.LUMEN_CRYSTAL;
      }
    }
    chunk.recomputeHeights();
    return chunk;
  }

  /** Finds a dry, non-mountain spawn column near the origin. */
  findSpawn(): [number, number, number] {
    for (let r = 0; r < 4096; r += 16) {
      for (let a = 0; a < Math.max(1, r / 4); a++) {
        const ang = (a / Math.max(1, r / 4)) * Math.PI * 2;
        const x = Math.round(Math.cos(ang) * r);
        const z = Math.round(Math.sin(ang) * r);
        const { height, biome } = this.column(x, z);
        if (biome === Biome.PLAINS || biome === Biome.FOREST || biome === Biome.DESERT || biome === Biome.SNOW) {
          return [x + 0.5, height + 1, z + 0.5];
        }
      }
    }
    return [0.5, this.column(0, 0).height + 1, 0.5];
  }
}
