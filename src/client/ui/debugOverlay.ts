/** F3 overlay: performance and world info. */
export class DebugOverlay {
  readonly el: HTMLDivElement;
  visible = true;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'debug-overlay';
    parent.appendChild(this.el);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? '' : 'none';
  }

  set(lines: string[]): void {
    if (this.visible) this.el.textContent = lines.join('\n');
  }
}
