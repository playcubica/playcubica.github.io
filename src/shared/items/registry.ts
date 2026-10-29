import { B, BLOCKS, RENDER, type ToolKind } from '../blocks/registry';

// Items. Block items share their block's id (0..4095); other items use ids from 4096.
// Tools are made in two steps: a head (or blade) from the material, then head + 2 sticks.

export interface ToolInfo {
  kind: ToolKind;
  /** Pickaxe tier for harvesting (see BlockDef.harvest). */
  level: number;
  speed: number;
  durability: number;
  /** Melee damage (used from stage 5). */
  damage: number;
}

export interface ItemDef {
  id: number;
  key: string;
  /** Hebrew display name (the game UI is Hebrew). */
  name: string;
  maxStack: number;
  /** Block placed by this item, if any. */
  block?: number;
  tool?: ToolInfo;
  food?: { hunger: number; saturation: number };
  /** Furnace burn time in ticks. */
  fuel?: number;
  /** Icon drawn flat (sprite) instead of as a cube. */
  flat: boolean;
}

export interface ItemStack {
  id: number;
  count: number;
  /** Damage taken (tools). */
  dmg?: number;
  /** Rune levels [swiftness, keenness, endurance, bounty] (tools, from the rune table). */
  runes?: number[];
}

export const I = {
  STICK: 4096,
  COAL: 4097,
  RAW_IRON: 4098,
  RAW_GOLD: 4099,
  IRON_INGOT: 4100,
  GOLD_INGOT: 4101,
  DIAMOND: 4102,
  ASHFRUIT: 4103,
  BAKED_ASHFRUIT: 4104,
  FROSTBERRIES: 4105,
  RAW_MEAT: 4106,
  COOKED_MEAT: 4107,
  FLEECE: 4108,
  HIDE: 4109,
  SILK: 4110,
  GLOOM_ASH: 4111,
  SPORE_POWDER: 4112,
  SEEDS: 4113,
  SUNWHEAT: 4114,
  BREAD: 4115,
  LUMEN_DUST: 4116,
  EMBER_SHARD: 4117,
  RUNE_SWIFT: 4118,
  RUNE_KEEN: 4119,
  RUNE_ENDURE: 4120,
  RUNE_BOUNTY: 4121,
  RAW_FOWL: 4122,
  COOKED_FOWL: 4123,
  EGG: 4124,
  FRIED_EGG: 4125,
  FEATHER: 4126,
  BUCKET: 4127,
  MILK_BUCKET: 4128,
  SADDLE: 4129,
  SHEARS: 4130,
} as const;

/** Rune item ids in the order of ItemStack.runes. */
export const RUNE_ITEMS = [I.RUNE_SWIFT, I.RUNE_KEEN, I.RUNE_ENDURE, I.RUNE_BOUNTY];
export const RUNE_NAMES = ['מהירות', 'חדות', 'עמידות', 'שפע'];
export const MAX_RUNE_LEVEL = 3;

export const TIERS = ['wood', 'stone', 'iron', 'gold', 'diamond'] as const;
export type Tier = (typeof TIERS)[number];
export const TOOL_KINDS: readonly ToolKind[] = ['pickaxe', 'axe', 'shovel', 'sword'];

const TOOL_BASE = 4200;
/** Head/blade item id for a tier and tool kind. */
export const headId = (tier: number, kind: number): number => TOOL_BASE + tier * 8 + kind;
/** Finished tool item id for a tier and tool kind. */
export const toolId = (tier: number, kind: number): number => TOOL_BASE + tier * 8 + 4 + kind;

const TIER_STATS: Record<Tier, { level: number; speed: number; durability: number; damage: number; he: string }> = {
  wood: { level: 1, speed: 2, durability: 64, damage: 4, he: 'עץ' },
  stone: { level: 2, speed: 4, durability: 140, damage: 5, he: 'אבן' },
  iron: { level: 3, speed: 6, durability: 260, damage: 6, he: 'ברזל' },
  gold: { level: 1, speed: 12, durability: 40, damage: 4, he: 'זהב' },
  diamond: { level: 4, speed: 8, durability: 1500, damage: 7, he: 'יהלום' },
};
const KIND_HE: Record<ToolKind, { tool: string; head: string }> = {
  pickaxe: { tool: 'מכוש', head: 'ראש מכוש' },
  axe: { tool: 'גרזן', head: 'ראש גרזן' },
  shovel: { tool: 'את חפירה', head: 'ראש את' },
  sword: { tool: 'חרב', head: 'להב חרב' },
};

const HEBREW: Record<string, string> = {
  stone: 'אבן', dirt: 'אדמה', grass: 'דשא', sand: 'חול', gravel: 'חצץ', clay: 'חימר', dunestone: 'אבן חולית',
  snow: 'שלג דחוס', frost_turf: 'אדמת כפור', ice: 'קרח', corerock: 'סלע ליבה', water: 'מים',
  ashwood_log: 'בול עץ אפר', ashwood_leaves: 'עלי עץ אפר', frostpine_log: 'בול אורן כפור',
  frostpine_needles: 'מחטי אורן כפור', cactus: 'קקטוס', coal_ore: 'עפרת פחם', iron_ore: 'עפרת ברזל',
  gold_ore: 'עפרת זהב', diamond_ore: 'עפרת יהלום', lumen_crystal: 'גביש לומן', tall_grass: 'עשב גבוה',
  sunbloom: 'פרח שמש', bluebell: 'פעמונית', dry_scrub: 'שיח יבש', ashwood_planks: 'קרשי עץ אפר',
  frostpine_planks: 'קרשי אורן כפור', rubblestone: 'אבן גוויל', glass: 'זכוכית', cut_stone: 'אבן מסותתת',
  lever: 'ידית', pressure_plate: 'לוחית לחץ', power_crystal: 'גביש כוח', relay: 'ממסר', inverter: 'מהפך',
  lamp: 'מנורת זוהר', pusher: 'דוחף', rift_stone: 'אבן בקע', ashstone: 'אבן אפר', emberstone: 'אבן גחלים',
  ember_ore: 'עפרת גחלת', rune_table: 'שולחן רונות',
  workbench: 'שולחן מלאכה', furnace: 'כבשן', furnace_lit: 'כבשן בוער', chest: 'תיבה', bedroll: 'שק שינה',
  torch: 'לפיד', ashwood_door: 'דלת עץ', ashwood_sapling: 'שתיל עץ אפר', frostpine_sapling: 'שתיל אורן כפור',
};

const FUEL: Partial<Record<number, number>> = {
  [B.ASHWOOD_LOG]: 300, [B.FROSTPINE_LOG]: 300, [B.ASHWOOD_PLANKS]: 300, [B.FROSTPINE_PLANKS]: 300,
  [B.WORKBENCH]: 300, [B.CHEST]: 300, [B.ASHWOOD_DOOR]: 200, [B.ASHWOOD_SAPLING]: 100, [B.FROSTPINE_SAPLING]: 100,
  [B.DRY_SCRUB]: 100,
};

const NOT_ITEMS = new Set<number>([B.AIR, B.FURNACE_LIT, B.FARMLAND, B.SUNWHEAT, B.GLOWWIRE, B.LAMP_ON, B.PUSHER_HEAD, B.RIFT, B.MAGMA]);
const FLAT_BLOCKS = new Set<number>([B.TORCH, B.ASHWOOD_DOOR, B.LEVER, B.PRESSURE_PLATE, B.RELAY, B.INVERTER]);

const items: ItemDef[] = [];

for (const b of BLOCKS) {
  // Blocks that only exist in the world (their item is something else, or nothing).
  if (!b || NOT_ITEMS.has(b.id)) continue;
  const flat = RENDER[b.id] === 2 || FLAT_BLOCKS.has(b.id);
  items[b.id] = {
    id: b.id, key: b.key, name: HEBREW[b.key] ?? b.name, maxStack: b.id === B.ASHWOOD_DOOR ? 16 : 64,
    block: b.id, fuel: FUEL[b.id], flat,
  };
}

function item(id: number, key: string, name: string, extra: Partial<ItemDef> = {}): void {
  items[id] = { id, key, name, maxStack: 64, flat: true, ...extra };
}

item(I.STICK, 'stick', 'מקל', { fuel: 100 });
item(I.COAL, 'coal', 'פחם', { fuel: 1600 });
item(I.RAW_IRON, 'raw_iron', 'ברזל גולמי');
item(I.RAW_GOLD, 'raw_gold', 'זהב גולמי');
item(I.IRON_INGOT, 'iron_ingot', 'מטיל ברזל');
item(I.GOLD_INGOT, 'gold_ingot', 'מטיל זהב');
item(I.DIAMOND, 'diamond', 'יהלום');
item(I.ASHFRUIT, 'ashfruit', 'פרי אפר', { food: { hunger: 4, saturation: 2.4 } });
item(I.BAKED_ASHFRUIT, 'baked_ashfruit', 'פרי אפר אפוי', { food: { hunger: 7, saturation: 8 } });
item(I.FROSTBERRIES, 'frostberries', 'פירות כפור', { food: { hunger: 2, saturation: 0.6 } });
item(I.RAW_MEAT, 'raw_meat', 'בשר נא', { food: { hunger: 3, saturation: 1.8 } });
item(I.COOKED_MEAT, 'cooked_meat', 'בשר צלוי', { food: { hunger: 8, saturation: 12.8 } });
item(I.FLEECE, 'fleece', 'צמר');
item(I.RAW_FOWL, 'raw_fowl', 'עוף נא', { food: { hunger: 2, saturation: 1.2 } });
item(I.COOKED_FOWL, 'cooked_fowl', 'עוף צלוי', { food: { hunger: 6, saturation: 7.2 } });
item(I.EGG, 'egg', 'ביצה', { maxStack: 16 });
item(I.FRIED_EGG, 'fried_egg', 'ביצה מטוגנת', { food: { hunger: 4, saturation: 5 } });
item(I.FEATHER, 'feather', 'נוצה');
item(I.BUCKET, 'bucket', 'דלי', { maxStack: 16 });
// Drinking it is like eating; the empty bucket comes back.
item(I.MILK_BUCKET, 'milk_bucket', 'דלי חלב', { maxStack: 1, food: { hunger: 3, saturation: 4 } });
item(I.SADDLE, 'saddle', 'אוכף', { maxStack: 1 });
item(I.SHEARS, 'shears', 'מזמרה', { maxStack: 1 });
item(I.HIDE, 'hide', 'עור');
item(I.SILK, 'silk', 'חוט משי');
item(I.GLOOM_ASH, 'gloom_ash', 'אפר אפלה', { fuel: 800 });
item(I.SPORE_POWDER, 'spore_powder', 'אבקת נבגים (דשן)');
item(I.SEEDS, 'seeds', 'זרעי שיבולת שמש', { block: B.SUNWHEAT });
item(I.SUNWHEAT, 'sunwheat', 'שיבולת שמש');
item(I.BREAD, 'bread', 'לחם', { food: { hunger: 5, saturation: 6 } });
item(I.LUMEN_DUST, 'lumen_dust', 'אבקת זוהר', { block: B.GLOWWIRE });
item(I.EMBER_SHARD, 'ember_shard', 'רסיס גחלת');
RUNE_ITEMS.forEach((id, i) => item(id, `rune_${i}`, `רונת ${RUNE_NAMES[i]}`, { maxStack: 16 }));

TIERS.forEach((tier, t) => {
  const st = TIER_STATS[tier];
  TOOL_KINDS.forEach((kind, k) => {
    const wood = tier === 'wood' ? { fuel: 200 } : {};
    item(headId(t, k), `${tier}_${kind}_head`, `${KIND_HE[kind].head} מ${st.he}`, wood);
    item(toolId(t, k), `${tier}_${kind}`, `${KIND_HE[kind].tool} ${st.he}`, {
      maxStack: 1,
      tool: { kind, level: kind === 'pickaxe' ? st.level : 0, speed: kind === 'sword' ? 1.5 : st.speed, durability: st.durability, damage: st.damage },
      ...wood,
    });
  });
});

export const ITEMS: readonly ItemDef[] = items;

export function itemDef(id: number): ItemDef | undefined {
  return items[id];
}

export function itemName(id: number): string {
  return items[id]?.name ?? `#${id}`;
}

export function maxStack(id: number): number {
  return items[id]?.maxStack ?? 64;
}

/** Tier index (0..4) and kind index (0..3) of a tool or head id, or null. */
export function toolParts(id: number): { tier: number; kind: number; head: boolean } | null {
  const o = id - TOOL_BASE;
  if (o < 0 || o >= TIERS.length * 8) return null;
  return { tier: Math.floor(o / 8), kind: o % 4, head: o % 8 < 4 };
}

/** Everything shown in the creative inventory, in display order. */
export const CREATIVE_ITEMS: number[] = [
  B.GRASS, B.DIRT, B.STONE, B.RUBBLESTONE, B.CUT_STONE, B.COREROCK, B.SAND, B.DUNESTONE, B.GRAVEL, B.CLAY,
  B.SNOW, B.FROST_TURF, B.ICE, B.ASHWOOD_LOG, B.ASHWOOD_PLANKS, B.ASHWOOD_LEAVES, B.FROSTPINE_LOG,
  B.FROSTPINE_PLANKS, B.FROSTPINE_NEEDLES, B.GLASS, B.CACTUS, B.COAL_ORE, B.IRON_ORE, B.GOLD_ORE,
  B.DIAMOND_ORE, B.LUMEN_CRYSTAL, B.WORKBENCH, B.FURNACE, B.CHEST, B.BEDROLL, B.TORCH, B.ASHWOOD_DOOR,
  B.TALL_GRASS, B.SUNBLOOM, B.BLUEBELL, B.DRY_SCRUB, B.ASHWOOD_SAPLING, B.FROSTPINE_SAPLING, B.WATER,
  I.STICK, I.COAL, I.RAW_IRON, I.RAW_GOLD, I.IRON_INGOT, I.GOLD_INGOT, I.DIAMOND,
  I.ASHFRUIT, I.BAKED_ASHFRUIT, I.FROSTBERRIES, I.RAW_MEAT, I.COOKED_MEAT,
  I.FLEECE, I.HIDE, I.SILK, I.GLOOM_ASH, I.SPORE_POWDER, I.SEEDS, I.SUNWHEAT, I.BREAD,
  I.LUMEN_DUST, B.LEVER, B.PRESSURE_PLATE, B.POWER_CRYSTAL, B.RELAY, B.INVERTER, B.LAMP, B.PUSHER,
  B.RUNE_TABLE, B.RIFT_STONE, B.ASHSTONE, B.EMBERSTONE, B.EMBER_ORE, I.EMBER_SHARD, ...RUNE_ITEMS,
  ...TIERS.flatMap((_, t) => TOOL_KINDS.map((__, k) => toolId(t, k))),
].filter((id) => items[id]);
