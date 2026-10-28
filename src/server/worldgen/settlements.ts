import { B, withState } from '../../shared/blocks/registry';
import { SEA_LEVEL } from '../../shared/constants';
import { I, type ItemStack } from '../../shared/items/registry';
import { emptySlots } from '../../shared/items/Window';
import { hash01, hash3i, mulberry32 } from '../../shared/rng';
import { Biome } from '../../shared/world/biomes';
import type { BlockEntity } from '../../shared/world/blockEntities';

// Settlements: a well, a small field and 3–5 houses with loot chests, joined by gravel
// paths. Everything is a pure function of the seed, so each chunk builds only its own
// part (like trees) and the host can find settlement centres without loading anything.

const CELL = 192;
const RADIUS = 13;
/** How far a settlement's blocks reach from its centre. */
export const SETTLEMENT_REACH = 24;

export interface ColumnSource {
  readonly seed: number;
  column(x: number, z: number): { height: number; biome: number };
}

export interface House {
  x0: number;
  z0: number;
  y: number;
  /** Door side as facing (0 +z, 1 -x, 2 -z, 3 +x). */
  door: number;
}

export interface Settlement {
  x: number;
  z: number;
  y: number;
  style: 'wood' | 'sand' | 'snow';
  houses: House[];
  id: number;
}

export function settlementInCell(gen: ColumnSource, gx: number, gz: number): Settlement | null {
  const h = hash3i(gen.seed ^ 0x5e77, gx, 0, gz);
  if (h / 4294967296 > 0.5) return null;
  const r = mulberry32(h);
  const x = gx * CELL + 40 + Math.floor(r() * (CELL - 80));
  const z = gz * CELL + 40 + Math.floor(r() * (CELL - 80));
  const c = gen.column(x, z);
  if (c.height <= SEA_LEVEL + 1 || c.height > 100) return null;
  const style = c.biome === Biome.DESERT ? 'sand' : c.biome === Biome.SNOW ? 'snow' : c.biome === Biome.PLAINS || c.biome === Biome.FOREST ? 'wood' : null;
  if (!style) return null;
  const count = 3 + Math.floor(r() * 3);
  const start = r() * Math.PI * 2;
  const houses: House[] = [];
  for (let i = 0; i < count; i++) {
    const a = start + (i / count) * Math.PI * 2;
    const hx = Math.round(x + Math.cos(a) * RADIUS);
    const hz = Math.round(z + Math.sin(a) * RADIUS);
    const hy = gen.column(hx, hz).height;
    if (Math.abs(hy - c.height) > 4 || hy <= SEA_LEVEL) continue;
    // Door on the side facing the centre.
    const dx = x - hx;
    const dz = z - hz;
    const door = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 3 : 1) : dz > 0 ? 0 : 2;
    houses.push({ x0: hx - 3, z0: hz - 3, y: hy, door });
  }
  if (houses.length < 2) return null;
  return { x, z, y: c.height, style, houses, id: h };
}

export function settlementsTouching(gen: ColumnSource, minX: number, minZ: number, maxX: number, maxZ: number): Settlement[] {
  const out: Settlement[] = [];
  for (let gz = Math.floor((minZ - SETTLEMENT_REACH) / CELL); gz <= Math.floor((maxZ + SETTLEMENT_REACH) / CELL); gz++) {
    for (let gx = Math.floor((minX - SETTLEMENT_REACH) / CELL); gx <= Math.floor((maxX + SETTLEMENT_REACH) / CELL); gx++) {
      const s = settlementInCell(gen, gx, gz);
      if (s && s.x + SETTLEMENT_REACH >= minX && s.x - SETTLEMENT_REACH <= maxX && s.z + SETTLEMENT_REACH >= minZ && s.z - SETTLEMENT_REACH <= maxZ) out.push(s);
    }
  }
  return out;
}

function loot(seed: number): (ItemStack | null)[] {
  const r = mulberry32(seed);
  const slots = emptySlots('chest');
  const put = (id: number, min: number, max: number) => {
    let i = Math.floor(r() * slots.length);
    while (slots[i]) i = (i + 1) % slots.length;
    slots[i] = { id, count: min + Math.floor(r() * (max - min + 1)) };
  };
  put(I.BREAD, 1, 4);
  put(I.LUMEN_DUST, 2, 6);
  if (r() < 0.7) put(I.SEEDS, 2, 6);
  if (r() < 0.5) put(I.IRON_INGOT, 1, 3);
  if (r() < 0.5) put(I.COAL, 2, 8);
  if (r() < 0.3) put(B.TORCH, 2, 8);
  if (r() < 0.15) put(I.GOLD_INGOT, 1, 2);
  if (r() < 0.08) put(I.DIAMOND, 1, 1);
  if (r() < 0.06) put(I.EMBER_SHARD, 1, 2);
  return slots;
}

export type Setter = (x: number, y: number, z: number, raw: number) => void;

/** Writes a settlement through `set` (which may ignore positions outside its chunk). */
export function buildSettlement(
  s: Settlement, gen: ColumnSource, set: Setter, setEntity: (x: number, y: number, z: number, be: BlockEntity) => void,
): void {
  const wall = s.style === 'sand' ? B.DUNESTONE : s.style === 'snow' ? B.FROSTPINE_PLANKS : B.ASHWOOD_PLANKS;
  const post = s.style === 'snow' ? B.FROSTPINE_LOG : s.style === 'sand' ? B.CUT_STONE : B.ASHWOOD_LOG;
  const ground = (x: number, z: number) => gen.column(x, z).height;

  // Paths from the centre to every door.
  for (const h of s.houses) {
    const [dx, dz] = [[0, 1], [-1, 0], [0, -1], [1, 0]][h.door];
    const tx = h.x0 + 3 + dx * 4;
    const tz = h.z0 + 3 + dz * 4;
    const steps = Math.max(Math.abs(tx - s.x), Math.abs(tz - s.z));
    for (let i = 0; i <= steps; i++) {
      const px = Math.round(s.x + ((tx - s.x) * i) / Math.max(1, steps));
      const pz = Math.round(s.z + ((tz - s.z) * i) / Math.max(1, steps));
      const py = ground(px, pz);
      if (py <= SEA_LEVEL) continue;
      set(px, py, pz, B.GRAVEL);
      set(px, py + 1, pz, B.AIR);
      set(px, py + 2, pz, B.AIR);
    }
  }

  // Well.
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    for (let dy = 1; dy <= 4; dy++) set(s.x + dx, s.y + dy, s.z + dz, B.AIR);
    if (dx === 0 && dz === 0) {
      set(s.x, s.y, s.z, B.WATER);
      set(s.x, s.y - 1, s.z, B.WATER);
      set(s.x, s.y - 2, s.z, B.CUT_STONE);
    } else {
      set(s.x + dx, s.y, s.z + dz, B.CUT_STONE);
      set(s.x + dx, s.y + 1, s.z + dz, B.CUT_STONE);
    }
  }

  // Field: 5×5 farmland with a water channel down the middle, opposite the first house.
  const f = s.houses[0];
  const fx = s.x - Math.sign(f.x0 + 3 - s.x) * 6 - 2;
  const fz = s.z - Math.sign(f.z0 + 3 - s.z) * 6 - 2;
  for (let dz = 0; dz < 5; dz++) for (let dx = 0; dx < 5; dx++) {
    const x = fx + dx;
    const z = fz + dz;
    for (let dy = 1; dy <= 3; dy++) set(x, s.y + dy, z, B.AIR);
    if (dx === 2) set(x, s.y, z, B.WATER);
    else {
      set(x, s.y, z, withState(B.FARMLAND, 1));
      set(x, s.y + 1, z, withState(B.SUNWHEAT, Math.floor(hash01(s.id, x, 0, z) * 8)));
    }
  }

  // Houses: 7×7, four blocks of wall, flat roof.
  for (const h of s.houses) {
    const { x0, z0, y } = h;
    for (let dz = -1; dz <= 7; dz++) for (let dx = -1; dx <= 7; dx++) {
      const x = x0 + dx;
      const z = z0 + dz;
      for (let dy = 1; dy <= 8; dy++) set(x, y + dy, z, B.AIR);
      if (dx < 0 || dx > 6 || dz < 0 || dz > 6) continue;
      // Foundation down to the ground.
      for (let fy = y - 1; fy > ground(x, z) - 1 && fy > y - 7; fy--) set(x, fy, z, B.RUBBLESTONE);
      set(x, y, z, dx === 0 || dx === 6 || dz === 0 || dz === 6 ? B.RUBBLESTONE : B.ASHWOOD_PLANKS);
      set(x, y + 5, z, wall);
      const edge = dx === 0 || dx === 6 || dz === 0 || dz === 6;
      if (!edge) continue;
      const corner = (dx === 0 || dx === 6) && (dz === 0 || dz === 6);
      for (let dy = 1; dy <= 4; dy++) set(x, y + dy, z, corner ? post : wall);
      // Windows in the middle of each wall.
      if (!corner && (dx === 3 || dz === 3)) set(x, y + 2, z, B.GLASS);
    }
    // Door in the middle of the wall facing the centre.
    const [ddx, ddz] = [[3, 6], [0, 3], [3, 0], [6, 3]][h.door];
    set(x0 + ddx, y + 1, z0 + ddz, withState(B.ASHWOOD_DOOR, h.door));
    set(x0 + ddx, y + 2, z0 + ddz, withState(B.ASHWOOD_DOOR, h.door | 8));
    // Furniture.
    set(x0 + 1, y + 1, z0 + 1, B.BEDROLL);
    set(x0 + 5, y + 1, z0 + 5, B.WORKBENCH);
    set(x0 + 1, y + 1, z0 + 5, B.TORCH);
    set(x0 + 5, y + 1, z0 + 1, B.CHEST);
    setEntity(x0 + 5, y + 1, z0 + 1, { kind: 'chest', slots: loot(hash3i(s.id, x0, y, z0)) });
  }
}
