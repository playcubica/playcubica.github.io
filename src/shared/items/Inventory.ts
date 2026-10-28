import { maxStack, type ItemStack } from './registry';

// Player inventory: slots 0..8 are the hotbar, 9..35 the main grid, plus the stack
// held on the mouse cursor while a window is open. The same code runs on the client
// (prediction) and the host (authority), so results always match.

export const HOTBAR_SIZE = 9;
export const INVENTORY_SIZE = 36;

export type Slot = ItemStack | null;

export interface InventoryState {
  slots: Slot[];
  cursor: Slot;
  selected: number;
}

export const InvAction = {
  /** button 0 = left (pick/place/swap all), 2 = right (half / one). */
  CLICK: 0,
  SHIFT_CLICK: 1,
  /** Creative only: put `item` (or nothing) on the cursor. */
  CREATIVE_CURSOR: 2,
  /** Creative only: put `item` × full stack into inventory slot `slot`. */
  CREATIVE_SLOT: 3,
} as const;

export const copyStack = (s: Slot): Slot => {
  if (!s) return null;
  const out: ItemStack = { id: s.id, count: s.count };
  if (s.dmg) out.dmg = s.dmg;
  if (s.runes) out.runes = [...s.runes];
  return out;
};

/** Two stacks can merge when they are the same plain item (no damage, no runes). */
export const canMerge = (a: ItemStack, b: ItemStack): boolean =>
  a.id === b.id && !a.dmg && !b.dmg && !a.runes && !b.runes && maxStack(a.id) > 1;

export class Inventory {
  slots: Slot[] = new Array<Slot>(INVENTORY_SIZE).fill(null);
  cursor: Slot = null;
  selected = 0;

  get held(): Slot {
    return this.slots[this.selected];
  }

  snapshot(): InventoryState {
    return { slots: this.slots.map(copyStack), cursor: copyStack(this.cursor), selected: this.selected };
  }

  load(state: InventoryState): void {
    this.slots = Array.from({ length: INVENTORY_SIZE }, (_, i) => sanitize(state.slots?.[i] ?? null));
    this.cursor = sanitize(state.cursor ?? null);
    this.selected = Number.isInteger(state.selected) && state.selected >= 0 && state.selected < HOTBAR_SIZE ? state.selected : 0;
  }

  /** Adds items (hotbar first, merging before using empty slots). Returns how many did not fit. */
  add(id: number, count: number): number {
    return this.addStack({ id, count });
  }

  addStack(stack: ItemStack): number {
    let count = stack.count;
    const max = maxStack(stack.id);
    if (!stack.dmg && !stack.runes) {
      for (let i = 0; i < INVENTORY_SIZE && count > 0; i++) {
        const s = this.slots[i];
        if (s && canMerge(s, stack) && s.count < max) {
          const n = Math.min(count, max - s.count);
          s.count += n;
          count -= n;
        }
      }
    }
    for (let i = 0; i < INVENTORY_SIZE && count > 0; i++) {
      if (!this.slots[i]) {
        const n = Math.min(count, max);
        this.slots[i] = { ...copyStack(stack)!, count: n };
        count -= n;
      }
    }
    return count;
  }

  /** True if the whole stack would fit. */
  fits(stack: ItemStack): boolean {
    const max = maxStack(stack.id);
    let room = 0;
    for (const s of this.slots) {
      if (!s) room += max;
      else if (canMerge(s, stack)) room += max - s.count;
      if (room >= stack.count) return true;
    }
    return false;
  }

  /** Removes up to n items from a slot. */
  take(slot: number, n = 1): void {
    const s = this.slots[slot];
    if (!s) return;
    s.count -= n;
    if (s.count <= 0) this.slots[slot] = null;
  }

  /** Empties the inventory and cursor, returning everything (e.g. on death). */
  takeAll(): ItemStack[] {
    const all = [...this.slots, this.cursor].filter((s): s is ItemStack => !!s);
    this.slots.fill(null);
    this.cursor = null;
    return all;
  }

  /** Creative-mode actions. Returns false if invalid. */
  applyCreative(action: number, slot: number, button: number, item: number | undefined): boolean {
    if (action === InvAction.CREATIVE_CURSOR) {
      this.cursor = item ? { id: item, count: button === 2 ? 1 : maxStack(item) } : null;
      return true;
    }
    if (action === InvAction.CREATIVE_SLOT && Number.isInteger(slot) && slot >= 0 && slot < INVENTORY_SIZE) {
      this.slots[slot] = item ? { id: item, count: maxStack(item) } : null;
      return true;
    }
    return false;
  }
}

export function sanitize(s: Slot): Slot {
  if (!s || !Number.isInteger(s.id) || !Number.isInteger(s.count) || s.count <= 0) return null;
  const out: ItemStack = { id: s.id, count: Math.min(s.count, maxStack(s.id)) };
  if (s.dmg && Number.isInteger(s.dmg) && s.dmg > 0) out.dmg = s.dmg;
  if (Array.isArray(s.runes) && s.runes.length === 4 && s.runes.every((l) => Number.isInteger(l) && l >= 0 && l <= 3)) {
    if (s.runes.some((l) => l > 0)) out.runes = [...s.runes];
  }
  return out;
}
