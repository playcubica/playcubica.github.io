import { B } from '../blocks/registry';
import { I, RUNE_ITEMS, toolId, type ItemStack } from '../items/registry';

// What settlement traders offer. The currency is lumen dust (אבקת זוהר).

export interface Trade {
  give: ItemStack[];
  get: ItemStack;
}

export const PROFESSIONS = ['חקלאית', 'נפח', 'מיסטיקן'] as const;

const s = (id: number, count = 1): ItemStack => ({ id, count });
const D = I.LUMEN_DUST;

export const TRADES: Trade[][] = [
  // Farmer
  [
    { give: [s(I.SUNWHEAT, 8)], get: s(D, 2) },
    { give: [s(I.RAW_MEAT, 4)], get: s(D, 1) },
    { give: [s(D, 1)], get: s(I.SEEDS, 4) },
    { give: [s(D, 2)], get: s(I.BREAD, 3) },
    { give: [s(D, 3)], get: s(I.COOKED_MEAT, 2) },
    { give: [s(D, 2)], get: s(B.ASHWOOD_SAPLING, 2) },
  ],
  // Smith
  [
    { give: [s(I.COAL, 8)], get: s(D, 2) },
    { give: [s(I.IRON_INGOT, 4)], get: s(D, 3) },
    { give: [s(D, 10)], get: s(toolId(2, 0)) },
    { give: [s(D, 12)], get: s(toolId(2, 3)) },
    { give: [s(D, 24), s(I.DIAMOND, 1)], get: s(toolId(4, 0)) },
    { give: [s(D, 4)], get: s(B.LAMP, 1) },
  ],
  // Mystic
  [
    { give: [s(I.SPORE_POWDER, 4)], get: s(D, 2) },
    { give: [s(I.GLOOM_ASH, 2)], get: s(D, 1) },
    { give: [s(D, 20)], get: s(I.EMBER_SHARD, 1) },
    ...RUNE_ITEMS.map((rune) => ({ give: [s(D, 8), s(I.EMBER_SHARD, 1)], get: s(rune) })),
  ],
];
