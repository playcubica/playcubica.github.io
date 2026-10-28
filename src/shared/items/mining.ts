import { B, blockDef, DOOR_UPPER, RENDER } from '../blocks/registry';
import { I, type ItemDef, type ItemStack } from './registry';

/** True if breaking this block with the held item yields its drop. */
export function canHarvest(blockId: number, held: ItemDef | undefined): boolean {
  const def = blockDef(blockId);
  if (!def || def.harvest === 0) return true;
  return held?.tool?.kind === 'pickaxe' && held.tool.level >= def.harvest;
}

/**
 * Seconds needed to break a block in survival with the given held item.
 * Blocks that can't be harvested with the held item take 10/3 as long; the right
 * tool divides the time by its speed. Negative hardness = unbreakable (except in creative).
 */
export function breakTime(blockId: number, held: ItemDef | undefined, creative: boolean, swiftness = 0): number {
  if (creative) return 0;
  const def = blockDef(blockId);
  if (!def || def.hardness < 0) return Infinity;
  let t = def.hardness * 1.5;
  if (!canHarvest(blockId, held)) return t * (10 / 3);
  if (held?.tool && (held.tool.kind === def.tool || (held.tool.kind === 'sword' && (blockId === B.ASHWOOD_LEAVES || blockId === B.FROSTPINE_NEEDLES || blockId === B.CACTUS)))) {
    t /= held.tool.speed * (1 + 0.3 * swiftness);
  }
  return t;
}

/** What breaking a block yields. `rnd` supplies randomness (server side). */
export function blockDrops(raw: number, held: ItemDef | undefined, rnd: () => number): ItemStack[] {
  const id = raw & 0xfff;
  if (!canHarvest(id, held)) return [];
  const one = (item: number, count = 1): ItemStack[] => (count > 0 ? [{ id: item, count }] : []);
  switch (id) {
    case B.GRASS:
    case B.FROST_TURF:
      return one(B.DIRT);
    case B.STONE:
      return one(B.RUBBLESTONE);
    case B.COAL_ORE:
      return one(I.COAL);
    case B.IRON_ORE:
      return one(I.RAW_IRON);
    case B.GOLD_ORE:
      return one(I.RAW_GOLD);
    case B.DIAMOND_ORE:
      return one(I.DIAMOND);
    case B.ASHWOOD_LEAVES: {
      const out: ItemStack[] = [];
      if (rnd() < 0.06) out.push({ id: B.ASHWOOD_SAPLING, count: 1 });
      if (rnd() < 0.06) out.push({ id: I.ASHFRUIT, count: 1 });
      return out;
    }
    case B.FROSTPINE_NEEDLES: {
      const out: ItemStack[] = [];
      if (rnd() < 0.06) out.push({ id: B.FROSTPINE_SAPLING, count: 1 });
      if (rnd() < 0.05) out.push({ id: I.FROSTBERRIES, count: 1 });
      return out;
    }
    case B.DRY_SCRUB:
      return one(I.STICK, Math.floor(rnd() * 3));
    case B.LUMEN_CRYSTAL:
      return one(I.LUMEN_DUST, 2 + Math.floor(rnd() * 3));
    case B.GLOWWIRE:
      return one(I.LUMEN_DUST);
    case B.FARMLAND:
      return one(B.DIRT);
    case B.LAMP_ON:
      return one(B.LAMP);
    case B.EMBER_ORE:
      return one(I.EMBER_SHARD, 1 + Math.floor(rnd() * 2));
    case B.SUNWHEAT:
      return (raw >>> 12) >= 7
        ? [{ id: I.SUNWHEAT, count: 1 }, { id: I.SEEDS, count: 1 + Math.floor(rnd() * 3) }]
        : one(I.SEEDS);
    case B.TALL_GRASS:
      return rnd() < 0.12 ? one(I.SEEDS) : [];
    case B.PUSHER_HEAD:
    case B.RIFT:
    case B.MAGMA:
      return [];
    case B.FURNACE_LIT:
      return one(B.FURNACE);
    case B.ASHWOOD_DOOR:
      return (raw >>> 12) & DOOR_UPPER ? [] : one(B.ASHWOOD_DOOR);
    case B.ICE:
    case B.GLASS:
    case B.WATER:
    case B.AIR:
      return [];
    default:
      return RENDER[id] === 0 ? [] : one(id);
  }
}

/** Cooldown between breaks in creative, so holding the button doesn't erase everything. */
export const CREATIVE_BREAK_DELAY = 0.2;
/** Maximum distance from the eye to a block the player interacts with. */
export const REACH = 5;
/** Seconds of holding right-click to eat. */
export const EAT_TIME = 1.6;
