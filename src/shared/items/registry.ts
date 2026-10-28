import { B, BLOCKS, RENDER, type ToolKind } from '../blocks/registry';

// Items. Block items share their block's id (0..4095); non-block items (tools,
// food, … from stage 3) will use ids from 4096 up.

export interface ItemDef {
  id: number;
  key: string;
  /** Hebrew display name (the game UI is Hebrew). */
  name: string;
  maxStack: number;
  /** Block placed by this item, if any. */
  block?: number;
  tool?: { kind: ToolKind; speed: number };
}

export interface ItemStack {
  id: number;
  count: number;
}

const HEBREW: Record<string, string> = {
  stone: 'אבן',
  dirt: 'אדמה',
  grass: 'דשא',
  sand: 'חול',
  gravel: 'חצץ',
  clay: 'חימר',
  dunestone: 'אבן חולית',
  snow: 'שלג דחוס',
  frost_turf: 'אדמת כפור',
  ice: 'קרח',
  corerock: 'סלע ליבה',
  water: 'מים',
  ashwood_log: 'בול עץ אפר',
  ashwood_leaves: 'עלי עץ אפר',
  frostpine_log: 'בול אורן כפור',
  frostpine_needles: 'מחטי אורן כפור',
  cactus: 'קקטוס',
  coal_ore: 'עפרת פחם',
  iron_ore: 'עפרת ברזל',
  gold_ore: 'עפרת זהב',
  diamond_ore: 'עפרת יהלום',
  lumen_crystal: 'גביש לומן',
  tall_grass: 'עשב גבוה',
  sunbloom: 'פרח שמש',
  bluebell: 'פעמונית',
  dry_scrub: 'שיח יבש',
  ashwood_planks: 'קרשי עץ אפר',
  frostpine_planks: 'קרשי אורן כפור',
  rubblestone: 'אבן גוויל',
  glass: 'זכוכית',
  cut_stone: 'אבן מסותתת',
};

const items: ItemDef[] = [];
for (const b of BLOCKS) {
  if (!b || b.id === B.AIR) continue;
  items[b.id] = { id: b.id, key: b.key, name: HEBREW[b.key] ?? b.name, maxStack: 64, block: b.id };
}

export function itemDef(id: number): ItemDef | undefined {
  return items[id];
}

export function itemName(id: number): string {
  return items[id]?.name ?? `#${id}`;
}

export function maxStack(id: number): number {
  return items[id]?.maxStack ?? 64;
}

/** Everything shown in the creative inventory, in display order. */
export const CREATIVE_ITEMS: number[] = [
  B.GRASS, B.DIRT, B.STONE, B.RUBBLESTONE, B.CUT_STONE, B.COREROCK, B.SAND, B.DUNESTONE, B.GRAVEL, B.CLAY,
  B.SNOW, B.FROST_TURF, B.ICE, B.ASHWOOD_LOG, B.ASHWOOD_PLANKS, B.ASHWOOD_LEAVES, B.FROSTPINE_LOG,
  B.FROSTPINE_PLANKS, B.FROSTPINE_NEEDLES, B.GLASS, B.CACTUS, B.COAL_ORE, B.IRON_ORE, B.GOLD_ORE,
  B.DIAMOND_ORE, B.LUMEN_CRYSTAL, B.TALL_GRASS, B.SUNBLOOM, B.BLUEBELL, B.DRY_SCRUB, B.WATER,
].filter((id) => items[id]);

/** What breaking a block yields in survival. Stage 3 replaces this with full drop tables. */
export function blockDrop(blockId: number): number {
  switch (blockId) {
    case B.GRASS:
    case B.FROST_TURF:
      return B.DIRT;
    case B.STONE:
      return B.RUBBLESTONE;
    case B.ASHWOOD_LEAVES:
    case B.FROSTPINE_NEEDLES:
    case B.TALL_GRASS:
    case B.ICE:
    case B.GLASS:
    case B.WATER:
    case B.AIR:
      return 0;
    default:
      return RENDER[blockId] === 0 ? 0 : blockId;
  }
}
