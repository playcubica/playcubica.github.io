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

export const MouseButton = { LEFT: 0, MIDDLE: 1, RIGHT: 2 } as const;

export class Controls {
  yaw = 0;
  pitch = 0;
  sensitivity = 0.0022;
  locked = false;
  onLockChange: ((locked: boolean) => void) | null = null;
  /** Pointer lock was refused (e.g. requested without a user gesture). */
  onLockError: (() => void) | null = null;
  onKeyPress: ((code: string, e: KeyboardEvent) => void) | null = null;
  onKeyRelease: ((code: string) => void) | null = null;
  onMouseDown: ((button: number) => void) | null = null;
  onWheel: ((steps: number) => void) | null = null;
  private readonly down = new Set<string>();
  private readonly buttons = new Set<number>();
  private readonly abort = new AbortController();

  constructor(private readonly element: HTMLElement) {
    const opt = { signal: this.abort.signal };
    element.addEventListener('click', () => this.lock(), opt);
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === element;
      if (!this.locked) {
        this.down.clear();
        this.buttons.clear();
      }
      this.onLockChange?.(this.locked);
    }, opt);
    document.addEventListener('pointerlockerror', () => this.onLockError?.(), opt);
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch -= e.movementY * this.sensitivity;
      const lim = Math.PI / 2 - 0.001;
      this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    }, opt);
    document.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      e.preventDefault();
      this.buttons.add(e.button);
      this.onMouseDown?.(e.button);
    }, opt);
    document.addEventListener('mouseup', (e) => this.buttons.delete(e.button), opt);
    document.addEventListener('contextmenu', (e) => { if (this.locked) e.preventDefault(); }, opt);
    window.addEventListener('wheel', (e) => {
      if (this.locked && e.deltaY !== 0) this.onWheel?.(Math.sign(e.deltaY));
    }, { ...opt, passive: true });
    window.addEventListener('keydown', (e) => {
      if (e.code === KEYS.debug || e.code === KEYS.playerList || (this.locked && (e.ctrlKey || e.code === 'Space'))) e.preventDefault();
      if (!e.repeat) this.onKeyPress?.(e.code, e);
      if (this.locked) this.down.add(e.code);
    }, opt);
    window.addEventListener('keyup', (e) => {
      this.down.delete(e.code);
      this.onKeyRelease?.(e.code);
    }, opt);
    window.addEventListener('blur', () => { this.down.clear(); this.buttons.clear(); }, opt);
  }

  lock(): void {
    if (this.locked) return;
    // Safari returns undefined, Chrome a Promise that rejects if called too soon after unlocking.
    const r = this.element.requestPointerLock() as unknown as Promise<void> | undefined;
    r?.catch?.(() => this.onLockError?.());
  }

  unlock(): void {
    if (document.pointerLockElement === this.element) document.exitPointerLock();
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  isButtonDown(button: number): boolean {
    return this.buttons.has(button);
  }

  dispose(): void {
    this.unlock();
    this.abort.abort();
  }
}
