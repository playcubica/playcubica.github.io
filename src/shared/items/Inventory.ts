import { maxStack, type ItemStack } from './registry';

// Player inventory: slots 0..8 are the hotbar, 9..35 the main grid, plus the stack
// held on the mouse cursor while the inventory screen is open. The same code runs
// on the client (prediction) and the host (authority), so results always match.

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
  /** Creative only: put `item` × full stack into `slot`. */
  CREATIVE_SLOT: 3,
  /** Inventory screen closed: the cursor stack goes back into the inventory. */
  CLOSE: 4,
} as const;

const copy = (s: Slot): Slot => (s ? { id: s.id, count: s.count } : null);

export class Inventory {
  slots: Slot[] = new Array<Slot>(INVENTORY_SIZE).fill(null);
  cursor: Slot = null;
  selected = 0;

  get held(): Slot {
    return this.slots[this.selected];
  }

  snapshot(): InventoryState {
    return { slots: this.slots.map(copy), cursor: copy(this.cursor), selected: this.selected };
  }

  load(state: InventoryState): void {
    this.slots = Array.from({ length: INVENTORY_SIZE }, (_, i) => sanitize(state.slots?.[i] ?? null));
    this.cursor = sanitize(state.cursor ?? null);
    this.selected = clampSlot(state.selected);
  }

  /** Adds items (hotbar first, merging before using empty slots). Returns what did not fit. */
  add(id: number, count: number): number {
    const max = maxStack(id);
    for (let i = 0; i < INVENTORY_SIZE && count > 0; i++) {
      const s = this.slots[i];
      if (s && s.id === id && s.count < max) {
        const n = Math.min(count, max - s.count);
        s.count += n;
        count -= n;
      }
    }
    for (let i = 0; i < INVENTORY_SIZE && count > 0; i++) {
      if (!this.slots[i]) {
        const n = Math.min(count, max);
        this.slots[i] = { id, count: n };
        count -= n;
      }
    }
    return count;
  }

  /** Removes up to n items from a slot. */
  take(slot: number, n = 1): void {
    const s = this.slots[slot];
    if (!s) return;
    s.count -= n;
    if (s.count <= 0) this.slots[slot] = null;
  }

  /** Applies a UI action. Returns false if it was invalid (nothing changed). */
  apply(action: number, slot: number, button: number, item: number | undefined, creative: boolean): boolean {
    switch (action) {
      case InvAction.CLICK:
        if (!validSlot(slot)) return false;
        this.click(slot, button);
        return true;
      case InvAction.SHIFT_CLICK:
        if (!validSlot(slot)) return false;
        this.shiftClick(slot);
        return true;
      case InvAction.CREATIVE_CURSOR:
        if (!creative) return false;
        this.cursor = item ? { id: item, count: button === 2 ? 1 : maxStack(item) } : null;
        return true;
      case InvAction.CREATIVE_SLOT:
        if (!creative || !validSlot(slot)) return false;
        this.slots[slot] = item ? { id: item, count: maxStack(item) } : null;
        return true;
      case InvAction.CLOSE:
        if (this.cursor) {
          this.add(this.cursor.id, this.cursor.count);
          this.cursor = null;
        }
        return true;
      default:
        return false;
    }
  }

  private click(i: number, button: number): void {
    const s = this.slots[i];
    const c = this.cursor;
    if (button === 2) {
      if (!c && s) {
        // Take half (rounded up).
        const half = Math.ceil(s.count / 2);
        this.cursor = { id: s.id, count: half };
        this.take(i, half);
      } else if (c && (!s || (s.id === c.id && s.count < maxStack(s.id)))) {
        // Drop one.
        if (s) s.count++;
        else this.slots[i] = { id: c.id, count: 1 };
        c.count--;
        if (c.count <= 0) this.cursor = null;
      }
      return;
    }
    if (c && s && c.id === s.id) {
      const n = Math.min(c.count, maxStack(s.id) - s.count);
      s.count += n;
      c.count -= n;
      if (c.count <= 0) this.cursor = null;
      return;
    }
    // Pick up, put down or swap.
    this.slots[i] = c;
    this.cursor = s;
  }

  private shiftClick(i: number): void {
    const s = this.slots[i];
    if (!s) return;
    const [from, to] = i < HOTBAR_SIZE ? [HOTBAR_SIZE, INVENTORY_SIZE] : [0, HOTBAR_SIZE];
    const max = maxStack(s.id);
    for (let j = from; j < to && s.count > 0; j++) {
      const t = this.slots[j];
      if (t && t.id === s.id && t.count < max) {
        const n = Math.min(s.count, max - t.count);
        t.count += n;
        s.count -= n;
      }
    }
    for (let j = from; j < to && s.count > 0; j++) {
      if (!this.slots[j]) {
        this.slots[j] = { id: s.id, count: s.count };
        s.count = 0;
      }
    }
    if (s.count <= 0) this.slots[i] = null;
  }
}

function validSlot(i: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < INVENTORY_SIZE;
}

function clampSlot(i: number): number {
  return Number.isInteger(i) && i >= 0 && i < HOTBAR_SIZE ? i : 0;
}

function sanitize(s: Slot): Slot {
  if (!s || !Number.isInteger(s.id) || !Number.isInteger(s.count) || s.count <= 0) return null;
  return { id: s.id, count: Math.min(s.count, maxStack(s.id)) };
}
