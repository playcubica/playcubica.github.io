import { craftingResult, SMELTING } from './crafting';
import { canMerge, copyStack, INVENTORY_SIZE, HOTBAR_SIZE, InvAction, type Inventory, type Slot } from './Inventory';
import { I, itemDef, maxStack, RUNE_ITEMS, type ItemStack } from './registry';
import { runeUpgrade } from './runes';

// A "window" is what the player sees with a container open: the container's own
// slots first, then the 36 inventory slots. Window 0 is the player's own inventory,
// which has a 2×2 crafting grid. Click logic is shared by client (prediction) and host.

export type WindowKind = 'inventory' | 'workbench' | 'furnace' | 'chest' | 'runetable';

export const WINDOW_LAYOUT: Record<WindowKind, { size: number; grid?: number; output?: number }> = {
  inventory: { size: 5, grid: 2, output: 4 },
  workbench: { size: 10, grid: 3, output: 9 },
  furnace: { size: 3, output: 2 },
  chest: { size: 27 },
  runetable: { size: 4, output: 3 },
};

/** Rune table slots: tool, rune, lumen dust, (upgraded tool). */
export const RUNE_TOOL = 0;
export const RUNE_STONE = 1;
export const RUNE_DUST = 2;

export const FURNACE_INPUT = 0;
export const FURNACE_FUEL = 1;
export const FURNACE_OUTPUT = 2;

export class ContainerWindow {
  private readonly layout: { size: number; grid?: number; output?: number };

  /** `slots` is the container's own slot array; it is mutated in place (shared with chests/furnaces). */
  constructor(readonly kind: WindowKind, readonly inv: Inventory, readonly slots: Slot[]) {
    this.layout = WINDOW_LAYOUT[kind];
  }

  get size(): number {
    return this.slots.length + INVENTORY_SIZE;
  }

  get(i: number): Slot {
    return i < this.slots.length ? this.slots[i] : this.inv.slots[i - this.slots.length];
  }

  private set(i: number, s: Slot): void {
    if (i < this.slots.length) this.slots[i] = s;
    else this.inv.slots[i - this.slots.length] = s;
  }

  private isOutput(i: number): boolean {
    return i === this.layout.output;
  }

  private canPlace(i: number, s: ItemStack): boolean {
    if (this.isOutput(i)) return false;
    if (this.kind === 'furnace' && i === FURNACE_FUEL) return !!itemDef(s.id)?.fuel;
    if (this.kind === 'runetable') {
      if (i === RUNE_TOOL) return !!itemDef(s.id)?.tool;
      if (i === RUNE_STONE) return (RUNE_ITEMS as readonly number[]).includes(s.id);
      if (i === RUNE_DUST) return s.id === I.LUMEN_DUST;
    }
    return true;
  }

  /** Applies a click/shift-click. Returns false if invalid. */
  apply(action: number, slot: number, button: number): boolean {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.size) return false;
    if (action === InvAction.CLICK) this.click(slot, button === 2 ? 2 : 0);
    else if (action === InvAction.SHIFT_CLICK) this.shiftClick(slot);
    else return false;
    this.refreshCrafting();
    return true;
  }

  private click(i: number, button: number): void {
    const inv = this.inv;
    const s = this.get(i);
    const c = inv.cursor;

    if (this.isOutput(i)) {
      if (!s) return;
      if (!c) inv.cursor = copyStack(s);
      else if (canMerge(c, s) && c.count + s.count <= maxStack(c.id)) c.count += s.count;
      else return;
      this.consumeOutput();
      return;
    }

    if (button === 2) {
      if (!c && s) {
        const half = Math.ceil(s.count / 2);
        inv.cursor = { ...s, count: half };
        s.count -= half;
        if (s.count <= 0) this.set(i, null);
      } else if (c && this.canPlace(i, c) && (!s || (canMerge(s, c) && s.count < maxStack(s.id)))) {
        if (s) s.count++;
        else this.set(i, { ...c, count: 1 });
        c.count--;
        if (c.count <= 0) inv.cursor = null;
      }
      return;
    }
    if (c && s && canMerge(c, s)) {
      if (!this.canPlace(i, c)) return;
      const n = Math.min(c.count, maxStack(s.id) - s.count);
      s.count += n;
      c.count -= n;
      if (c.count <= 0) inv.cursor = null;
      return;
    }
    if (c && !this.canPlace(i, c)) return;
    this.set(i, c);
    inv.cursor = s;
  }

  /** Takes one craft (or one furnace output) out of the output slot. */
  private consumeOutput(): void {
    const out = this.layout.output!;
    if (this.kind === 'furnace') {
      this.slots[out] = null;
      return;
    }
    if (this.kind === 'runetable') {
      const up = runeUpgrade(this.slots[RUNE_TOOL], this.slots[RUNE_STONE], this.slots[RUNE_DUST]);
      if (!up) return;
      this.slots[RUNE_TOOL] = null;
      this.take(RUNE_STONE, 1);
      this.take(RUNE_DUST, up.cost);
      this.refreshCrafting();
      return;
    }
    for (let g = 0; g < out; g++) {
      const s = this.slots[g];
      if (!s) continue;
      s.count--;
      if (s.count <= 0) this.slots[g] = null;
    }
    this.refreshCrafting();
  }

  private shiftClick(i: number): void {
    const n = this.slots.length;
    const s = this.get(i);
    if (!s) return;

    if (this.isOutput(i)) {
      // Craft as many as fit.
      for (let k = 0; k < 64; k++) {
        const r = this.get(i);
        if (!r || !this.inv.fits(r)) break;
        this.inv.addStack(r);
        this.consumeOutput();
        if (this.kind === 'furnace') break;
      }
      return;
    }

    if (i < n) {
      // Container -> inventory.
      const left = this.inv.addStack(s);
      if (left === 0) this.set(i, null);
      else s.count = left;
      return;
    }

    // Inventory -> container (chest / furnace), or hotbar <-> main grid.
    let targets: number[];
    if (this.kind === 'chest') targets = range(0, n);
    else if (this.kind === 'runetable') {
      targets = itemDef(s.id)?.tool ? [RUNE_TOOL] : (RUNE_ITEMS as readonly number[]).includes(s.id) ? [RUNE_STONE] : s.id === I.LUMEN_DUST ? [RUNE_DUST] : [];
    } else if (this.kind === 'furnace') {
      targets = SMELTING.has(s.id) ? [0] : itemDef(s.id)?.fuel ? [1] : [];
    } else targets = [];
    if (targets.length === 0) {
      const inv = i - n;
      targets = inv < HOTBAR_SIZE ? range(n + HOTBAR_SIZE, n + INVENTORY_SIZE) : range(n, n + HOTBAR_SIZE);
    }
    this.moveInto(i, targets);
  }

  private moveInto(from: number, targets: number[]): void {
    const s = this.get(from)!;
    for (const t of targets) {
      const d = this.get(t);
      if (d && canMerge(d, s) && d.count < maxStack(d.id) && this.canPlace(t, s)) {
        const k = Math.min(s.count, maxStack(d.id) - d.count);
        d.count += k;
        s.count -= k;
      }
      if (s.count <= 0) break;
    }
    for (const t of targets) {
      if (s.count <= 0) break;
      if (!this.get(t) && this.canPlace(t, s)) {
        this.set(t, { ...s });
        s.count = 0;
      }
    }
    if (s.count <= 0) this.set(from, null);
  }

  private take(i: number, n: number): void {
    const s = this.slots[i];
    if (!s) return;
    s.count -= n;
    if (s.count <= 0) this.slots[i] = null;
  }

  /** Recomputes the crafting (or rune table) output. */
  refreshCrafting(): void {
    if (this.kind === 'runetable') {
      this.slots[3] = runeUpgrade(this.slots[RUNE_TOOL], this.slots[RUNE_STONE], this.slots[RUNE_DUST])?.result ?? null;
      return;
    }
    const { grid, output } = this.layout;
    if (!grid || output === undefined) return;
    const ids: number[] = [];
    for (let g = 0; g < grid * grid; g++) ids.push(this.slots[g]?.id ?? 0);
    this.slots[output] = craftingResult(ids, grid);
  }

  /** Empties the crafting grid (or rune table) into the inventory. Returns stacks that did not fit. */
  returnGrid(): ItemStack[] {
    const { grid, output } = this.layout;
    const spill: ItemStack[] = [];
    if (this.kind === 'runetable') {
      for (const i of [RUNE_TOOL, RUNE_STONE, RUNE_DUST]) {
        const s = this.slots[i];
        if (!s) continue;
        const left = this.inv.addStack(s);
        if (left > 0) spill.push({ ...s, count: left });
        this.slots[i] = null;
      }
      this.slots[3] = null;
      return spill;
    }
    if (!grid || output === undefined) return spill;
    for (let g = 0; g < grid * grid; g++) {
      const s = this.slots[g];
      if (!s) continue;
      const left = this.inv.addStack(s);
      if (left > 0) spill.push({ ...s, count: left });
      this.slots[g] = null;
    }
    this.slots[output] = null;
    return spill;
  }
}

function range(a: number, b: number): number[] {
  return Array.from({ length: b - a }, (_, k) => a + k);
}

export function emptySlots(kind: WindowKind): Slot[] {
  return new Array<Slot>(WINDOW_LAYOUT[kind].size).fill(null);
}
