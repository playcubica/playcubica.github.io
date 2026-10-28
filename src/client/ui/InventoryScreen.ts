import { HOTBAR_SIZE, INVENTORY_SIZE, InvAction, type Inventory } from '../../shared/items/Inventory';
import { CREATIVE_ITEMS, itemName } from '../../shared/items/registry';
import { renderSlot } from './Hud';

export interface InventoryHost {
  readonly inventory: Inventory;
  readonly creative: boolean;
  invAction(action: number, slot: number, button: number, item?: number): void;
}

/** The E screen: player inventory, plus the full block palette in creative. */
export class InventoryScreen {
  readonly root: HTMLDivElement;
  private readonly slotEls: HTMLDivElement[] = [];
  private readonly palette: HTMLDivElement;
  private readonly paletteTitle: HTMLDivElement;
  private readonly cursor: HTMLDivElement;
  private readonly tooltip: HTMLDivElement;
  open = false;

  constructor(parent: HTMLElement, private readonly host: InventoryHost) {
    this.root = document.createElement('div');
    this.root.className = 'inv-screen';
    this.root.style.display = 'none';
    const panel = document.createElement('div');
    panel.className = 'inv-panel';

    this.paletteTitle = document.createElement('div');
    this.paletteTitle.className = 'inv-title';
    this.paletteTitle.textContent = 'כל הבלוקים (יצירתי)';
    this.palette = document.createElement('div');
    this.palette.className = 'inv-grid inv-palette';
    this.palette.dir = 'ltr';
    for (const id of CREATIVE_ITEMS) {
      const s = this.makeSlot();
      renderSlot(s, { id, count: 1 });
      s.dataset.tip = itemName(id);
      s.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (e.shiftKey) host.invAction(InvAction.CREATIVE_SLOT, host.inventory.selected, 0, id);
        else if (host.inventory.cursor) host.invAction(InvAction.CREATIVE_CURSOR, 0, 0, undefined); // drop = delete
        else host.invAction(InvAction.CREATIVE_CURSOR, 0, e.button, id);
        this.render();
      });
      this.palette.appendChild(s);
    }

    const invTitle = document.createElement('div');
    invTitle.className = 'inv-title';
    invTitle.textContent = 'מלאי';
    const main = document.createElement('div');
    main.className = 'inv-grid';
    main.dir = 'ltr';
    const hotbar = document.createElement('div');
    hotbar.className = 'inv-grid inv-hotbar';
    hotbar.dir = 'ltr';
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const s = this.makeSlot();
      s.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (e.shiftKey) host.invAction(InvAction.SHIFT_CLICK, i, 0);
        else host.invAction(InvAction.CLICK, i, e.button === 2 ? 2 : 0);
        this.render();
      });
      this.slotEls[i] = s;
    }
    for (let i = HOTBAR_SIZE; i < INVENTORY_SIZE; i++) main.appendChild(this.slotEls[i]);
    for (let i = 0; i < HOTBAR_SIZE; i++) hotbar.appendChild(this.slotEls[i]);

    const hint = document.createElement('div');
    hint.className = 'inv-hint';
    hint.textContent = 'קליק שמאלי: הרם/הנח · קליק ימני: חצי/אחד · Shift+קליק: העברה מהירה · E: סגירה';

    panel.append(this.paletteTitle, this.palette, invTitle, main, hotbar, hint);
    this.cursor = document.createElement('div');
    this.cursor.className = 'slot inv-cursor';
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'inv-tooltip';
    this.root.append(panel, this.cursor, this.tooltip);
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.root.addEventListener('mousemove', (e) => {
      this.cursor.style.left = `${e.clientX}px`;
      this.cursor.style.top = `${e.clientY}px`;
      const tip = (e.target as HTMLElement).closest<HTMLElement>('.slot');
      const text = tip?.dataset.tip ?? (tip?.dataset.slot ? this.slotTip(Number(tip.dataset.slot)) : '');
      this.tooltip.textContent = text;
      this.tooltip.style.display = text && !host.inventory.cursor ? '' : 'none';
      this.tooltip.style.left = `${e.clientX + 14}px`;
      this.tooltip.style.top = `${e.clientY - 28}px`;
    });
    this.slotEls.forEach((el, i) => (el.dataset.slot = String(i)));
    parent.appendChild(this.root);
  }

  private slotTip(i: number): string {
    const s = this.host.inventory.slots[i];
    return s ? itemName(s.id) : '';
  }

  private makeSlot(): HTMLDivElement {
    const s = document.createElement('div');
    s.className = 'slot';
    return s;
  }

  show(): void {
    this.open = true;
    this.root.style.display = '';
    this.render();
  }

  hide(): void {
    this.open = false;
    this.root.style.display = 'none';
  }

  render(): void {
    if (!this.open) return;
    const inv = this.host.inventory;
    const creative = this.host.creative;
    this.palette.style.display = creative ? '' : 'none';
    this.paletteTitle.style.display = creative ? '' : 'none';
    for (let i = 0; i < INVENTORY_SIZE; i++) renderSlot(this.slotEls[i], inv.slots[i]);
    renderSlot(this.cursor, inv.cursor);
    this.cursor.style.display = inv.cursor ? '' : 'none';
    if (inv.cursor) this.tooltip.style.display = 'none';
  }

  dispose(): void {
    this.root.remove();
  }
}
