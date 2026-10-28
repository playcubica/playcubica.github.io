/** F3 overlay: performance and world info. */
export class DebugOverlay {
  readonly el: HTMLDivElement;
  visible = false;

  constructor(parent: HTMLElement, visible: boolean) {
    this.el = document.createElement('div');
    this.el.className = 'debug-overlay';
    parent.appendChild(this.el);
    this.show(visible);
  }

  show(visible: boolean): void {
    this.visible = visible;
    this.el.style.display = visible ? '' : 'none';
  }

  set(lines: string[]): void {
    if (this.visible) this.el.textContent = lines.join('\n');
  }
}
