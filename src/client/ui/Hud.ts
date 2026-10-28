import { HOTBAR_SIZE, type Inventory, type Slot } from '../../shared/items/Inventory';
import { itemName } from '../../shared/items/registry';
import { itemIcon } from './icons';

/** Fills a slot element with an item icon and count. */
export function renderSlot(el: HTMLElement, s: Slot): void {
  const key = s ? `${s.id}:${s.count}` : '';
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.replaceChildren();
  if (!s) return;
  const img = document.createElement('img');
  img.src = itemIcon(s.id);
  img.draggable = false;
  el.appendChild(img);
  if (s.count > 1) {
    const n = document.createElement('span');
    n.className = 'count';
    n.textContent = String(s.count);
    el.appendChild(n);
  }
}

/** In-game overlay: hotbar, selected item name, underwater tint. */
export class Hud {
  readonly root: HTMLDivElement;
  private readonly slots: HTMLDivElement[] = [];
  private readonly toast: HTMLDivElement;
  private readonly water: HTMLDivElement;
  private toastTimer = 0;
  private lastSelected = -1;
  private lastHeldId = -1;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.water = document.createElement('div');
    this.water.className = 'underwater';
    this.toast = document.createElement('div');
    this.toast.className = 'item-toast';
    const bar = document.createElement('div');
    bar.className = 'hotbar';
    bar.dir = 'ltr';
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const s = document.createElement('div');
      s.className = 'slot';
      bar.appendChild(s);
      this.slots.push(s);
    }
    const crosshair = document.createElement('div');
    crosshair.className = 'crosshair';
    this.root.append(this.water, crosshair, this.toast, bar);
    parent.appendChild(this.root);
  }

  update(inv: Inventory, underwater: boolean, dt: number): void {
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      renderSlot(this.slots[i], inv.slots[i]);
      this.slots[i].classList.toggle('selected', i === inv.selected);
    }
    const held = inv.held;
    const heldId = held?.id ?? 0;
    if (inv.selected !== this.lastSelected || heldId !== this.lastHeldId) {
      if (this.lastSelected !== -1 && held) {
        this.toast.textContent = itemName(held.id);
        this.toastTimer = 1.6;
      }
      this.lastSelected = inv.selected;
      this.lastHeldId = heldId;
    }
    this.toastTimer = Math.max(0, this.toastTimer - dt);
    this.toast.style.opacity = String(Math.min(1, this.toastTimer * 2));
    this.water.style.display = underwater ? '' : 'none';
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
  }

  dispose(): void {
    this.root.remove();
  }
}
