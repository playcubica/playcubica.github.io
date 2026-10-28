import type { Slot } from './Inventory';
import { I, itemDef, MAX_RUNE_LEVEL, RUNE_ITEMS, RUNE_NAMES, type ItemStack } from './registry';

// Runes: tool upgrades made at the rune table, paid for in lumen dust.
//   0 swiftness: mine faster (+30% per level)        — any tool
//   1 keenness:  +1 melee damage per level            — swords and axes
//   2 endurance: each use has a 1/(level+1) chance to wear the tool — any tool
//   3 bounty:    ores and crops may drop up to +level extra — pickaxes, axes, shovels

export const RUNE_SWIFT = 0;
export const RUNE_KEEN = 1;
export const RUNE_ENDURE = 2;
export const RUNE_BOUNTY = 3;

const ROMAN = ['', 'I', 'II', 'III'];

export function runeLevel(stack: Slot | undefined, rune: number): number {
  return stack?.runes?.[rune] ?? 0;
}

/** Lumen dust needed to raise a rune to `level`. */
export const runeCost = (level: number): number => 4 * level;

/** The upgraded tool the rune table offers, or null if this combination doesn't work. */
export function runeUpgrade(tool: Slot, rune: Slot, dust: Slot): { result: ItemStack; cost: number } | null {
  const info = tool ? itemDef(tool.id)?.tool : undefined;
  if (!tool || !info || !rune) return null;
  const r = RUNE_ITEMS.indexOf(rune.id as (typeof RUNE_ITEMS)[number]);
  if (r < 0) return null;
  if (r === RUNE_KEEN && info.kind !== 'sword' && info.kind !== 'axe') return null;
  if (r === RUNE_BOUNTY && info.kind === 'sword') return null;
  const level = runeLevel(tool, r) + 1;
  if (level > MAX_RUNE_LEVEL) return null;
  const cost = runeCost(level);
  if (!dust || dust.id !== I.LUMEN_DUST || dust.count < cost) return null;
  const runes = tool.runes ? [...tool.runes] : [0, 0, 0, 0];
  runes[r] = level;
  const result: ItemStack = { id: tool.id, count: 1, runes };
  if (tool.dmg) result.dmg = tool.dmg;
  return { result, cost };
}

/** "מהירות II · חדות I" for tooltips. */
export function runeLabel(stack: Slot): string {
  if (!stack?.runes) return '';
  return stack.runes.map((l, i) => (l > 0 ? `${RUNE_NAMES[i]} ${ROMAN[l]}` : '')).filter(Boolean).join(' · ');
}
