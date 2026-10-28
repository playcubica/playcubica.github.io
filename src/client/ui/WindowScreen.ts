import { HOTBAR_SIZE, INVENTORY_SIZE, InvAction, type Inventory, type Slot } from '../../shared/items/Inventory';
import { CREATIVE_ITEMS, itemName } from '../../shared/items/registry';
import { WINDOW_LAYOUT, type WindowKind } from '../../shared/items/Window';
import { renderSlot } from './Hud';

export interface OpenWindowState {
  id: number;
  kind: WindowKind;
  slots: Slot[];
  progress?: [number, number];
}

export interface WindowHost {
  readonly inventory: Inventory;
  readonly creative: boolean;
  /** The window shown: the player's own (id 0) or a container. */
  readonly currentWindow: OpenWindowState;
  /** Click on window slot `slot` (container slots first, then the 36 inventory slots). */
  windowAction(action: number, slot: number, button: number, item?: number): void;
}

const TITLES: Record<WindowKind, string> = {
  inventory: 'יצירה',
  workbench: 'שולחן מלאכה',
  furnace: 'כבשן',
  chest: 'תיבה',
};

/** The screen shown with E or when a container is opened. */
export class WindowScreen {
  readonly root: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly cursor: HTMLDivElement;
  private readonly tooltip: HTMLDivElement;
  private slotEls: HTMLDivElement[] = [];
  private flame: HTMLDivElement | null = null;
  private arrow: HTMLDivElement | null = null;
  private builtFor = '';
  open = false;

  constructor(parent: HTMLElement, private readonly host: WindowHost) {
    this.root = document.createElement('div');
    this.root.className = 'inv-screen';
    this.root.style.display = 'none';
    this.panel = document.createElement('div');
    this.panel.className = 'inv-panel';
    this.cursor = document.createElement('div');
    this.cursor.className = 'slot inv-cursor';
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'inv-tooltip';
    this.root.append(this.panel, this.cursor, this.tooltip);
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.root.addEventListener('mousemove', (e) => {
      this.cursor.style.left = `${e.clientX}px`;
      this.cursor.style.top = `${e.clientY}px`;
      const el = (e.target as HTMLElement).closest<HTMLElement>('.slot');
      let text = el?.dataset.tip ?? '';
      if (!text && el?.dataset.slot) {
        const s = this.getSlot(Number(el.dataset.slot));
        text = s ? itemName(s.id) : '';
      }
      this.tooltip.textContent = text;
      this.tooltip.style.display = text && !host.inventory.cursor ? '' : 'none';
      this.tooltip.style.left = `${e.clientX + 14}px`;
      this.tooltip.style.top = `${e.clientY - 28}px`;
    });
    parent.appendChild(this.root);
  }

  private getSlot(i: number): Slot {
    const w = this.host.currentWindow;
    return i < w.slots.length ? w.slots[i] : this.host.inventory.slots[i - w.slots.length];
  }

  private slot(index: number, extraClass = ''): HTMLDivElement {
    const s = document.createElement('div');
    s.className = `slot ${extraClass}`;
    s.dataset.slot = String(index);
    s.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (e.shiftKey) this.host.windowAction(InvAction.SHIFT_CLICK, index, 0);
      else this.host.windowAction(InvAction.CLICK, index, e.button === 2 ? 2 : 0);
      this.render();
    });
    this.slotEls[index] = s;
    return s;
  }

  private grid(cols: number, from: number, to: number, cls = ''): HTMLDivElement {
    const g = document.createElement('div');
    g.className = `inv-grid ${cls}`;
    g.style.gridTemplateColumns = `repeat(${cols}, 44px)`;
    g.dir = 'ltr';
    for (let i = from; i < to; i++) g.appendChild(this.slot(i));
    return g;
  }

  private title(text: string): HTMLDivElement {
    const t = document.createElement('div');
    t.className = 'inv-title';
    t.textContent = text;
    return t;
  }

  private build(): void {
    const w = this.host.currentWindow;
    const creative = this.host.creative;
    this.builtFor = `${w.id}:${w.kind}:${creative}`;
    this.slotEls = [];
    this.flame = this.arrow = null;
    this.panel.replaceChildren();
    const n = w.slots.length;
    const layout = WINDOW_LAYOUT[w.kind];

    if (w.kind === 'inventory' && creative) {
      this.panel.appendChild(this.title('כל הפריטים (יצירתי) — Shift+קליק: לסרגל'));
      const palette = document.createElement('div');
      palette.className = 'inv-grid inv-palette';
      palette.dir = 'ltr';
      for (const id of CREATIVE_ITEMS) {
        const s = document.createElement('div');
        s.className = 'slot';
        renderSlot(s, { id, count: 1 });
        s.dataset.tip = itemName(id);
        s.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const inv = this.host.inventory;
          if (e.shiftKey) this.host.windowAction(InvAction.CREATIVE_SLOT, inv.selected, 0, id);
          else if (inv.cursor) this.host.windowAction(InvAction.CREATIVE_CURSOR, 0, 0, undefined); // drop on palette = delete
          else this.host.windowAction(InvAction.CREATIVE_CURSOR, 0, e.button, id);
          this.render();
        });
        palette.appendChild(s);
      }
      this.panel.appendChild(palette);
    }

    this.panel.appendChild(this.title(TITLES[w.kind]));
    const top = document.createElement('div');
    top.className = 'inv-top';
    top.dir = 'ltr';
    if (layout.grid && layout.output !== undefined) {
      top.appendChild(this.grid(layout.grid, 0, layout.grid * layout.grid));
      const arrow = document.createElement('div');
      arrow.className = 'inv-arrow';
      arrow.textContent = '➜';
      top.appendChild(arrow);
      top.appendChild(this.slot(layout.output, 'output'));
    } else if (w.kind === 'furnace') {
      const col = document.createElement('div');
      col.className = 'furnace-col';
      this.flame = document.createElement('div');
      this.flame.className = 'flame';
      this.flame.appendChild(document.createElement('div'));
      col.append(this.slot(0), this.flame, this.slot(1));
      this.arrow = document.createElement('div');
      this.arrow.className = 'progress-arrow';
      this.arrow.appendChild(document.createElement('div'));
      top.append(col, this.arrow, this.slot(2, 'output'));
    } else {
      top.appendChild(this.grid(9, 0, n));
    }
    this.panel.appendChild(top);

    this.panel.appendChild(this.title('מלאי'));
    this.panel.appendChild(this.grid(9, n + HOTBAR_SIZE, n + INVENTORY_SIZE));
    this.panel.appendChild(this.grid(9, n, n + HOTBAR_SIZE, 'inv-hotbar'));
    const hint = document.createElement('div');
    hint.className = 'inv-hint';
    hint.textContent = 'קליק שמאלי: הרם/הנח · קליק ימני: חצי/אחד · Shift+קליק: העברה מהירה · E: סגירה';
    this.panel.appendChild(hint);
  }

  show(): void {
    this.open = true;
    this.root.style.display = '';
    this.render();
  }

  hide(): void {
    this.open = false;
    this.root.style.display = 'none';
    this.builtFor = '';
  }

  render(): void {
    if (!this.open) return;
    const w = this.host.currentWindow;
    if (this.builtFor !== `${w.id}:${w.kind}:${this.host.creative}`) this.build();
    this.slotEls.forEach((el, i) => renderSlot(el, this.getSlot(i)));
    const inv = this.host.inventory;
    renderSlot(this.cursor, inv.cursor);
    this.cursor.style.display = inv.cursor ? '' : 'none';
    if (inv.cursor) this.tooltip.style.display = 'none';
    if (this.flame && this.arrow) {
      const [burn, cook] = w.progress ?? [0, 0];
      (this.flame.firstChild as HTMLDivElement).style.height = `${burn * 100}%`;
      (this.arrow.firstChild as HTMLDivElement).style.width = `${cook * 100}%`;
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
