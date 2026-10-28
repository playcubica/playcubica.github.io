import { blockDef } from '../blocks/registry';
import type { ItemDef } from './registry';

/**
 * Seconds needed to break a block in survival with the given held item.
 * Blocks that want a pickaxe are slow without one; the right tool divides the time
 * by its speed. Negative hardness = unbreakable (except in creative).
 */
export function breakTime(blockId: number, held: ItemDef | undefined, creative: boolean): number {
  if (creative) return 0;
  const def = blockDef(blockId);
  if (!def || def.hardness < 0) return Infinity;
  let t = def.hardness * 1.5;
  if (def.tool && held?.tool?.kind === def.tool) t /= held.tool.speed;
  else if (def.tool === 'pickaxe') t *= 10 / 3;
  return t;
}

/** Cooldown between breaks in creative, so holding the button doesn't erase everything. */
export const CREATIVE_BREAK_DELAY = 0.2;
/** Maximum distance from the eye to a block the player interacts with. */
export const REACH = 5;
