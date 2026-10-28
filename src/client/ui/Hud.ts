import { HOTBAR_SIZE, type Inventory, type Slot } from '../../shared/items/Inventory';
import { itemDef, itemName } from '../../shared/items/registry';
import { itemIcon } from './icons';

/** Fills a slot element with an item icon, count and durability bar. */
export function renderSlot(el: HTMLElement, s: Slot): void {
  const key = s ? `${s.id}:${s.count}:${s.dmg ?? 0}` : '';
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
  const tool = itemDef(s.id)?.tool;
  if (tool && s.dmg) {
    const left = 1 - s.dmg / tool.durability;
    const bar = document.createElement('div');
    bar.className = 'durability';
    const fill = document.createElement('div');
    fill.style.width = `${Math.max(0, left) * 100}%`;
    fill.style.background = `hsl(${Math.round(left * 120)}, 90%, 50%)`;
    bar.appendChild(fill);
    el.appendChild(bar);
  }
}

type IconKind = 'heart' | 'food' | 'bubble';

/** Tiny pixel icons for the status bars (full / half / empty). */
function statIcon(kind: IconKind, fill: 'full' | 'half' | 'empty'): string {
  const c = document.createElement('canvas');
  c.width = c.height = 9;
  const g = c.getContext('2d')!;
  const shapes: Record<IconKind, string[]> = {
    heart: ['.##...##.', '#oo#.#oo#', '#ooo#ooo#', '#ooooooo#', '.#ooooo#.', '..#ooo#..', '...#o#...', '....#....', '.........'],
    food: ['....##...', '...#oo#..', '..#oooo#.', '.#oooooo#', '#oooooo#.', '#ooooo#..', '.#ooo#...', '..###....', '.........'],
    bubble: ['..###....', '.#ooo#...', '#oo.oo#..', '#ooooo#..', '#ooooo#..', '.#ooo#...', '..###....', '.........', '.........'],
  };
  const colors: Record<IconKind, [string, string]> = {
    heart: ['#e0303a', '#ff8a8a'],
    food: ['#c9822e', '#f2c066'],
    bubble: ['#6aa8ff', '#d4e8ff'],
  };
  shapes[kind].forEach((row, y) => {
    for (let x = 0; x < 9; x++) {
      const ch = row[x];
      if (ch === '#') g.fillStyle = '#1a1a1a';
      else if (ch === 'o') {
        const filled = fill === 'full' || (fill === 'half' && x < 5);
        g.fillStyle = filled ? (y < 3 && x < 4 ? colors[kind][1] : colors[kind][0]) : '#3a3a3a';
      } else continue;
      g.fillRect(x, y, 1, 1);
    }
  });
  return c.toDataURL();
}

class StatBar {
  readonly el: HTMLDivElement;
  private readonly icons: HTMLImageElement[] = [];
  private last = -1;
  private readonly urls: Record<'full' | 'half' | 'empty', string>;

  constructor(kind: IconKind, className: string) {
    this.el = document.createElement('div');
    this.el.className = `stat-bar ${className}`;
    this.urls = { full: statIcon(kind, 'full'), half: statIcon(kind, 'half'), empty: statIcon(kind, 'empty') };
    for (let i = 0; i < 10; i++) {
      const img = document.createElement('img');
      this.icons.push(img);
      this.el.appendChild(img);
    }
  }

  /** value 0..20 (two points per icon). */
  set(value: number, hideEmpty = false): void {
    if (value === this.last) return;
    this.last = value;
    this.icons.forEach((img, i) => {
      const v = value - i * 2;
      const state = v >= 2 ? 'full' : v === 1 ? 'half' : 'empty';
      img.src = this.urls[state];
      img.style.visibility = hideEmpty && state === 'empty' ? 'hidden' : '';
    });
  }
}

/** In-game overlay: hotbar, status bars, messages, damage flash, underwater tint. */
export class Hud {
  readonly root: HTMLDivElement;
  private readonly slots: HTMLDivElement[] = [];
  private readonly toast: HTMLDivElement;
  private readonly water: HTMLDivElement;
  private readonly hurt: HTMLDivElement;
  private readonly stats: HTMLDivElement;
  private readonly hearts = new StatBar('heart', 'hearts');
  private readonly food = new StatBar('food', 'food');
  private readonly air = new StatBar('bubble', 'air');
  private readonly messages: HTMLDivElement;
  private readonly eatBar: HTMLDivElement;
  private toastTimer = 0;
  private hurtTimer = 0;
  private lastSelected = -1;
  private lastHeldId = -1;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.water = document.createElement('div');
    this.water.className = 'underwater';
    this.hurt = document.createElement('div');
    this.hurt.className = 'hurt-flash';
    this.toast = document.createElement('div');
    this.toast.className = 'item-toast';
    this.messages = document.createElement('div');
    this.messages.className = 'messages';
    this.messages.dir = 'rtl';
    this.eatBar = document.createElement('div');
    this.eatBar.className = 'eat-bar';
    this.eatBar.appendChild(document.createElement('div'));

    const bottom = document.createElement('div');
    bottom.className = 'hud-bottom';
    this.stats = document.createElement('div');
    this.stats.className = 'stats';
    this.stats.dir = 'ltr';
    const left = document.createElement('div');
    left.className = 'stats-left';
    left.append(this.air.el, this.hearts.el);
    const right = document.createElement('div');
    right.className = 'stats-right';
    right.append(this.food.el);
    this.stats.append(left, right);
    const bar = document.createElement('div');
    bar.className = 'hotbar';
    bar.dir = 'ltr';
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const s = document.createElement('div');
      s.className = 'slot';
      bar.appendChild(s);
      this.slots.push(s);
    }
    bottom.append(this.toast, this.eatBar, this.stats, bar);

    const crosshair = document.createElement('div');
    crosshair.className = 'crosshair';
    this.root.append(this.water, this.hurt, crosshair, this.messages, bottom);
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
    this.hurtTimer = Math.max(0, this.hurtTimer - dt);
    this.hurt.style.opacity = String(this.hurtTimer * 1.6);
  }

  setStats(health: number, food: number, air: number, survival: boolean): void {
    this.stats.style.visibility = survival ? '' : 'hidden';
    this.hearts.set(health);
    this.food.set(food);
    const bubbles = Math.ceil((Math.max(0, air) / 300) * 20);
    this.air.el.style.visibility = air < 300 ? '' : 'hidden';
    this.air.set(bubbles, true);
  }

  /** 0..1 while eating, or null. */
  setEating(progress: number | null): void {
    this.eatBar.style.display = progress === null ? 'none' : '';
    if (progress !== null) (this.eatBar.firstChild as HTMLDivElement).style.width = `${progress * 100}%`;
  }

  flashHurt(): void {
    this.hurtTimer = 0.45;
  }

  message(text: string): void {
    const m = document.createElement('div');
    m.textContent = text;
    this.messages.appendChild(m);
    while (this.messages.children.length > 6) this.messages.firstChild!.remove();
    setTimeout(() => m.classList.add('fade'), 7000);
    setTimeout(() => m.remove(), 9000);
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
  }

  dispose(): void {
    this.root.remove();
  }
}
