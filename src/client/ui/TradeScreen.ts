import type { Trade } from '../../shared/entities/trades';
import { PROFESSIONS } from '../../shared/entities/trades';
import type { Inventory } from '../../shared/items/Inventory';
import { itemName } from '../../shared/items/registry';
import { renderSlot } from './Hud';

/** A trader's offers. Clicking an offer you can afford sends the trade to the host. */
export class TradeScreen {
  readonly root: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private offers: Trade[] = [];
  entityId = -1;
  open = false;
  onTrade: ((entityId: number, offer: number) => void) | null = null;

  constructor(parent: HTMLElement, private readonly inventory: Inventory) {
    this.root = document.createElement('div');
    this.root.className = 'inv-screen';
    this.root.style.display = 'none';
    const panel = document.createElement('div');
    panel.className = 'inv-panel';
    this.title = document.createElement('div');
    this.title.className = 'inv-title';
    this.list = document.createElement('div');
    this.list.className = 'trade-list';
    const hint = document.createElement('div');
    hint.className = 'inv-hint';
    hint.textContent = 'לחצו על הצעה כדי לסחור · המטבע: אבקת זוהר · E: סגירה';
    panel.append(this.title, this.list, hint);
    this.root.appendChild(panel);
    parent.appendChild(this.root);
  }

  show(entityId: number, profession: number, offers: Trade[]): void {
    this.entityId = entityId;
    this.offers = offers;
    this.title.textContent = `סוחר: ${PROFESSIONS[profession] ?? ''}`;
    this.open = true;
    this.root.style.display = '';
    this.render();
  }

  hide(): void {
    this.open = false;
    this.root.style.display = 'none';
  }

  private have(id: number): number {
    return this.inventory.slots.reduce((n, s) => n + (s && s.id === id && !s.dmg && !s.runes ? s.count : 0), 0);
  }

  render(): void {
    if (!this.open) return;
    this.list.replaceChildren();
    this.offers.forEach((o, i) => {
      const row = document.createElement('div');
      const ok = o.give.every((g) => this.have(g.id) >= g.count);
      row.className = `trade-row${ok ? '' : ' disabled'}`;
      row.title = `${o.give.map((g) => `${g.count} ${itemName(g.id)}`).join(' + ')} ← ${o.get.count} ${itemName(o.get.id)}`;
      for (const g of o.give) {
        const slot = document.createElement('div');
        slot.className = 'slot';
        renderSlot(slot, g);
        row.appendChild(slot);
      }
      const arrow = document.createElement('div');
      arrow.className = 'inv-arrow';
      arrow.textContent = '⬅';
      const out = document.createElement('div');
      out.className = 'slot';
      renderSlot(out, o.get);
      const label = document.createElement('div');
      label.textContent = itemName(o.get.id);
      row.append(arrow, out, label);
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (ok) this.onTrade?.(this.entityId, i);
      });
      this.list.appendChild(row);
    });
  }

  dispose(): void {
    this.root.remove();
  }
}
