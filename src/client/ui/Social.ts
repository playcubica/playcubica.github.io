import type { PlayerListEntry } from '../../shared/protocol/messages';

/** The T chat line. */
export class ChatInput {
  readonly el: HTMLDivElement;
  private readonly input: HTMLInputElement;
  open = false;
  onSend: ((text: string) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'chat-input';
    this.el.style.display = 'none';
    this.input = document.createElement('input');
    this.input.maxLength = 200;
    this.input.dir = 'auto';
    this.input.placeholder = 'הודעה לכולם… (Enter לשליחה, Esc לביטול, /help לפקודות)';
    this.el.appendChild(this.input);
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const text = this.input.value.trim();
        if (text) this.onSend?.(text);
        this.hide();
      } else if (e.key === 'Escape') {
        this.hide();
      }
    });
    parent.appendChild(this.el);
  }

  show(prefix = ''): void {
    this.open = true;
    this.el.style.display = '';
    this.input.value = prefix;
    // Focus after the key that opened the chat has been handled, so it isn't typed in.
    setTimeout(() => this.input.focus(), 0);
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.el.style.display = 'none';
    this.input.blur();
    this.onClose?.();
  }

  dispose(): void {
    this.el.remove();
  }
}

/** The Tab player list. */
export class PlayerListView {
  readonly el: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'player-list';
    this.el.dir = 'rtl';
    this.el.style.display = 'none';
    parent.appendChild(this.el);
  }

  set(players: PlayerListEntry[], selfId: number): void {
    this.el.replaceChildren();
    const title = document.createElement('div');
    title.className = 'pl-title';
    title.textContent = `שחקנים (${players.length}/8)`;
    this.el.appendChild(title);
    for (const p of players) {
      const row = document.createElement('div');
      row.className = 'pl-row';
      const name = document.createElement('span');
      name.textContent = `${p.name}${p.host ? ' ★' : ''}${p.id === selfId ? ' (את/ה)' : ''}`;
      const ping = document.createElement('span');
      ping.className = 'pl-ping';
      ping.textContent = p.host && p.id === selfId ? '' : p.ping >= 0 ? `${p.ping}ms` : '…';
      ping.style.color = p.ping < 0 ? '#aaa' : p.ping < 120 ? '#7ddc6a' : p.ping < 300 ? '#ffd166' : '#ff6b6b';
      row.append(name, ping);
      this.el.appendChild(row);
    }
  }

  show(v: boolean): void {
    this.el.style.display = v ? '' : 'none';
  }

  dispose(): void {
    this.el.remove();
  }
}
