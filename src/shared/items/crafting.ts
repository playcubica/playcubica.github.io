import { B } from '../blocks/registry';
import { headId, I, RUNE_ITEMS, toolId, TIERS, type ItemStack } from './registry';

// Crafting and smelting recipes (Cubica's own). Shaped patterns may be placed
// anywhere in the grid and may be mirrored left-right.

type Ingredient = number | readonly number[];

interface Shaped {
  pattern: string[];
  keys: Record<string, Ingredient>;
  result: ItemStack;
}

interface Shapeless {
  ingredients: Ingredient[];
  result: ItemStack;
}

const PLANKS = [B.ASHWOOD_PLANKS, B.FROSTPINE_PLANKS];
const LOGS = [B.ASHWOOD_LOG, B.FROSTPINE_LOG];
/** Soft materials for a bedroll. */
const SOFT = [B.ASHWOOD_LEAVES, B.FROSTPINE_NEEDLES, I.FLEECE, I.HIDE, I.SILK, I.DUSK_MEMBRANE];
const TIER_MATERIAL: Ingredient[] = [PLANKS, B.RUBBLESTONE, I.IRON_INGOT, I.GOLD_INGOT, I.DIAMOND];

/** Head/blade shapes by tool kind: pickaxe, axe, shovel, sword. */
const HEAD_PATTERNS = [['MMM'], ['MM', 'M '], ['MM'], ['M', 'M']];

const shaped: Shaped[] = [
  { pattern: ['PP', 'PP'], keys: { P: PLANKS }, result: { id: B.WORKBENCH, count: 1 } },
  { pattern: ['RRR', 'R R', 'RRR'], keys: { R: B.RUBBLESTONE }, result: { id: B.FURNACE, count: 1 } },
  { pattern: ['PPP', 'P P', 'PPP'], keys: { P: PLANKS }, result: { id: B.CHEST, count: 1 } },
  { pattern: ['C', 'S'], keys: { C: I.COAL, S: I.STICK }, result: { id: B.TORCH, count: 4 } },
  { pattern: ['LLL', 'PPP'], keys: { L: SOFT, P: PLANKS }, result: { id: B.BEDROLL, count: 1 } },
  { pattern: ['DD', 'DD'], keys: { D: I.LUMEN_DUST }, result: { id: B.LUMEN_CRYSTAL, count: 1 } },
  { pattern: ['WWW'], keys: { W: I.SUNWHEAT }, result: { id: I.BREAD, count: 1 } },
  // Glow power (signals).
  { pattern: ['S', 'R'], keys: { S: I.STICK, R: B.RUBBLESTONE }, result: { id: B.LEVER, count: 1 } },
  { pattern: ['CC'], keys: { C: B.CUT_STONE }, result: { id: B.PRESSURE_PLATE, count: 1 } },
  { pattern: ['DDD', 'DDD', 'DDD'], keys: { D: I.LUMEN_DUST }, result: { id: B.POWER_CRYSTAL, count: 1 } },
  { pattern: ['DSD', 'CCC'], keys: { D: I.LUMEN_DUST, S: I.STICK, C: B.CUT_STONE }, result: { id: B.RELAY, count: 1 } },
  { pattern: [' D ', 'CCC'], keys: { D: I.LUMEN_DUST, C: B.CUT_STONE }, result: { id: B.INVERTER, count: 1 } },
  { pattern: [' D ', 'DGD', ' D '], keys: { D: I.LUMEN_DUST, G: B.GLASS }, result: { id: B.LAMP, count: 1 } },
  { pattern: ['PPP', 'RIR', 'RDR'], keys: { P: PLANKS, R: B.RUBBLESTONE, I: I.IRON_INGOT, D: I.LUMEN_DUST }, result: { id: B.PUSHER, count: 1 } },
  // Runes and the rift.
  { pattern: [' L ', 'DCD', 'CCC'], keys: { L: B.LUMEN_CRYSTAL, D: I.DIAMOND, C: B.CUT_STONE }, result: { id: B.RUNE_TABLE, count: 1 } },
  { pattern: ['CLC', 'LDL', 'CLC'], keys: { C: B.CUT_STONE, L: B.LUMEN_CRYSTAL, D: I.DIAMOND }, result: { id: B.RIFT_STONE, count: 1 } },
  { pattern: ['PP', 'PP', 'PP'], keys: { P: PLANKS }, result: { id: B.ASHWOOD_DOOR, count: 3 } },
  { pattern: ['SS', 'SS'], keys: { S: B.STONE }, result: { id: B.CUT_STONE, count: 4 } },
  // Animals.
  { pattern: ['I I', ' I '], keys: { I: I.IRON_INGOT }, result: { id: I.BUCKET, count: 1 } },
  { pattern: ['HHH', 'HIH'], keys: { H: I.HIDE, I: I.IRON_INGOT }, result: { id: I.SADDLE, count: 1 } },
  { pattern: [' I', 'I '], keys: { I: I.IRON_INGOT }, result: { id: I.SHEARS, count: 1 } },
  // Leads (silk or fleece) and name tags (hide over silk).
  { pattern: [' SS', ' SS', 'S  '], keys: { S: [I.SILK, I.FLEECE] }, result: { id: I.LEAD, count: 2 } },
  { pattern: ['H', 'S'], keys: { H: I.HIDE, S: I.SILK }, result: { id: I.NAME_TAG, count: 1 } },
  // The ember altar wakes the Ember Deep's matriarch (right-click it there with lumen dust).
  { pattern: ['EEE', 'ELE', 'AAA'], keys: { E: I.EMBER_SHARD, L: B.LUMEN_CRYSTAL, A: B.ASHSTONE }, result: { id: B.EMBER_ALTAR, count: 1 } },
];

const shapeless: Shapeless[] = [
  { ingredients: [B.ASHWOOD_LOG], result: { id: B.ASHWOOD_PLANKS, count: 4 } },
  { ingredients: [B.FROSTPINE_LOG], result: { id: B.FROSTPINE_PLANKS, count: 4 } },
  { ingredients: [PLANKS], result: { id: I.STICK, count: 2 } },
  { ingredients: [I.SUNWHEAT], result: { id: I.SEEDS, count: 2 } },
  // Rune stones: cut stone + ember shard + lumen dust + the rune's own ingredient.
  ...[I.GOLD_INGOT, I.IRON_INGOT, I.DIAMOND, I.SPORE_POWDER].map((x, i) => ({
    ingredients: [B.CUT_STONE, I.EMBER_SHARD, I.LUMEN_DUST, x],
    result: { id: RUNE_ITEMS[i], count: 1 },
  })),
];

TIERS.forEach((_, t) => {
  HEAD_PATTERNS.forEach((pattern, k) => {
    shaped.push({ pattern, keys: { M: TIER_MATERIAL[t] }, result: { id: headId(t, k), count: 1 } });
    shapeless.push({ ingredients: [headId(t, k), I.STICK, I.STICK], result: { id: toolId(t, k), count: 1 } });
  });
});

const matches = (ing: Ingredient, id: number): boolean => (typeof ing === 'number' ? ing === id : ing.includes(id));

/**
 * Finds the result for a square crafting grid (row-major, `size`×`size`).
 * Entries are item ids (0 = empty).
 */
export function craftingResult(grid: readonly number[], size: number): ItemStack | null {
  let minX = size;
  let minY = size;
  let maxX = -1;
  let maxY = -1;
  const present: number[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const id = grid[y * size + x];
      if (!id) continue;
      present.push(id);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (present.length === 0) return null;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const at = (x: number, y: number) => grid[(minY + y) * size + minX + x];

  for (const r of shaped) {
    if (r.pattern.length !== h || r.pattern[0].length !== w) continue;
    for (const mirror of [false, true]) {
      let ok = true;
      for (let y = 0; y < h && ok; y++) {
        for (let x = 0; x < w && ok; x++) {
          const ch = r.pattern[y][mirror ? w - 1 - x : x];
          const id = at(x, y);
          ok = ch === ' ' ? !id : !!id && matches(r.keys[ch], id);
        }
      }
      if (ok) return { ...r.result };
    }
  }

  for (const r of shapeless) {
    if (r.ingredients.length !== present.length) continue;
    const left = [...present];
    const ok = r.ingredients.every((ing) => {
      const i = left.findIndex((id) => matches(ing, id));
      if (i < 0) return false;
      left.splice(i, 1);
      return true;
    });
    if (ok) return { ...r.result };
  }
  return null;
}

/** Furnace recipes: input item -> output item. */
export const SMELTING: ReadonlyMap<number, number> = new Map([
  [I.RAW_IRON, I.IRON_INGOT],
  [I.RAW_GOLD, I.GOLD_INGOT],
  [B.SAND, B.GLASS],
  [B.RUBBLESTONE, B.STONE],
  [I.ASHFRUIT, I.BAKED_ASHFRUIT],
  [I.RAW_MEAT, I.COOKED_MEAT],
  [I.RAW_FOWL, I.COOKED_FOWL],
  [I.EGG, I.FRIED_EGG],
  [I.RAW_FISH, I.COOKED_FISH],
  ...LOGS.map((l) => [l, I.COAL] as [number, number]),
]);

/** Ticks to smelt one item. */
export const SMELT_TICKS = 200;

/** All recipes, for a recipe book or tests. */
export const RECIPE_COUNT = { shaped: shaped.length, shapeless: shapeless.length };
