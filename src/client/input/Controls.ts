// Keyboard + mouse input with Pointer Lock. Key bindings follow the usual
// block-sandbox PC layout (KeyboardEvent.code, so they work on any keyboard language).

export const KEYS = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  sneak: 'ShiftLeft',
  sprint: 'ControlLeft',
  inventory: 'KeyE',
  chat: 'KeyT',
  playerList: 'Tab',
  debug: 'F3',
} as const;

export class Controls {
  yaw = 0;
  pitch = 0;
  sensitivity = 0.0022;
  locked = false;
  onLockChange: ((locked: boolean) => void) | null = null;
  onKeyPress: ((code: string) => void) | null = null;
  private readonly down = new Set<string>();

  constructor(private readonly element: HTMLElement) {
    element.addEventListener('click', () => this.lock());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === element;
      if (!this.locked) this.down.clear();
      this.onLockChange?.(this.locked);
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch -= e.movementY * this.sensitivity;
      const lim = Math.PI / 2 - 0.001;
      this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === KEYS.debug || e.code === KEYS.playerList || (this.locked && e.ctrlKey)) e.preventDefault();
      if (!e.repeat) this.onKeyPress?.(e.code);
      if (this.locked) this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
  }

  lock(): void {
    if (!this.locked) {
      // Safari returns undefined, Chrome a Promise that may reject if called too soon after unlock.
      const r = this.element.requestPointerLock() as unknown as Promise<void> | undefined;
      r?.catch?.(() => undefined);
    }
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }
}
