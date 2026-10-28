import { B } from '../blocks/registry';
import { headId, I, toolId, TIERS, type ItemStack } from './registry';

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
const LEAVES = [B.ASHWOOD_LEAVES, B.FROSTPINE_NEEDLES];
const TIER_MATERIAL: Ingredient[] = [PLANKS, B.RUBBLESTONE, I.IRON_INGOT, I.GOLD_INGOT, I.DIAMOND];

/** Head/blade shapes by tool kind: pickaxe, axe, shovel, sword. */
const HEAD_PATTERNS = [['MMM'], ['MM', 'M '], ['MM'], ['M', 'M']];

const shaped: Shaped[] = [
  { pattern: ['PP', 'PP'], keys: { P: PLANKS }, result: { id: B.WORKBENCH, count: 1 } },
  { pattern: ['RRR', 'R R', 'RRR'], keys: { R: B.RUBBLESTONE }, result: { id: B.FURNACE, count: 1 } },
  { pattern: ['PPP', 'P P', 'PPP'], keys: { P: PLANKS }, result: { id: B.CHEST, count: 1 } },
  { pattern: ['C', 'S'], keys: { C: I.COAL, S: I.STICK }, result: { id: B.TORCH, count: 4 } },
  { pattern: ['LLL', 'PPP'], keys: { L: LEAVES, P: PLANKS }, result: { id: B.BEDROLL, count: 1 } },
  { pattern: ['PP', 'PP', 'PP'], keys: { P: PLANKS }, result: { id: B.ASHWOOD_DOOR, count: 3 } },
  { pattern: ['SS', 'SS'], keys: { S: B.STONE }, result: { id: B.CUT_STONE, count: 4 } },
];

const shapeless: Shapeless[] = [
  { ingredients: [B.ASHWOOD_LOG], result: { id: B.ASHWOOD_PLANKS, count: 4 } },
  { ingredients: [B.FROSTPINE_LOG], result: { id: B.FROSTPINE_PLANKS, count: 4 } },
  { ingredients: [PLANKS], result: { id: I.STICK, count: 2 } },
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
  ...LOGS.map((l) => [l, I.COAL] as [number, number]),
]);

/** Ticks to smelt one item. */
export const SMELT_TICKS = 200;

/** All recipes, for a recipe book or tests. */
export const RECIPE_COUNT = { shaped: shaped.length, shapeless: shapeless.length };
