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
  /** Input goes to the game: the pointer is captured, or the free-mouse fallback is on. */
  locked = false;
  /** Pointer Lock was refused, so the game runs with a visible, free mouse. */
  freeMouse = false;
  private lockTimer: ReturnType<typeof setTimeout> | undefined;
  onLockChange: ((locked: boolean) => void) | null = null;
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
      if (document.pointerLockElement === element) {
        this.freeMouse = false;
        this.setLocked(true);
      } else if (!this.freeMouse) {
        this.setLocked(false);
      }
    }, opt);
    document.addEventListener('pointerlockerror', () => this.fallBack(), opt);
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch -= e.movementY * this.sensitivity;
      this.clampPitch();
    }, opt);
    document.addEventListener('mousedown', (e) => {
      // With the free-mouse fallback, only clicks on the game itself count (not on menus).
      if (!this.locked || (this.freeMouse && e.target !== element)) return;
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
      if (e.code === KEYS.debug || e.code === KEYS.playerList || (this.locked && (e.ctrlKey || e.code === 'Space' || e.code.startsWith('Arrow')))) e.preventDefault();
      if (!e.repeat) this.onKeyPress?.(e.code, e);
      // Without pointer lock the browser doesn't release the mouse on Esc by itself.
      if (e.code === 'Escape' && this.freeMouse) this.unlock();
      if (this.locked) this.down.add(e.code);
    }, opt);
    window.addEventListener('keyup', (e) => {
      this.down.delete(e.code);
      this.onKeyRelease?.(e.code);
    }, opt);
    window.addEventListener('blur', () => { this.down.clear(); this.buttons.clear(); }, opt);
  }

  /** Captures the mouse for the game; if the browser refuses, plays on with a free mouse. */
  lock(): void {
    if (this.locked) return;
    if (typeof this.element.requestPointerLock !== 'function') {
      this.fallBack();
      return;
    }
    // Safari returns undefined, Chrome a Promise that may reject (e.g. right after leaving it,
    // or in embedded browsers that don't allow it). Some browsers never answer at all.
    try {
      const r = this.element.requestPointerLock() as unknown as Promise<void> | undefined;
      r?.catch?.(() => this.fallBack());
    } catch {
      this.fallBack();
      return;
    }
    clearTimeout(this.lockTimer);
    this.lockTimer = setTimeout(() => {
      if (!this.locked) this.fallBack();
    }, 800);
  }

  /** Free-mouse mode: input still goes to the game, the cursor stays visible. */
  private fallBack(): void {
    if (this.locked) return;
    this.freeMouse = true;
    this.element.style.cursor = 'crosshair';
    this.setLocked(true);
  }

  unlock(): void {
    if (document.pointerLockElement === this.element) document.exitPointerLock();
    else if (this.freeMouse) {
      this.freeMouse = false;
      this.element.style.cursor = '';
      this.setLocked(false);
    }
  }

  private setLocked(v: boolean): void {
    if (this.locked === v) return;
    this.locked = v;
    if (!v) {
      this.down.clear();
      this.buttons.clear();
    }
    this.onLockChange?.(v);
  }

  /** Arrow keys turn the view too (handy without mouse capture). */
  turn(dt: number): void {
    if (!this.locked) return;
    this.yaw += ((this.isDown('ArrowLeft') ? 1 : 0) - (this.isDown('ArrowRight') ? 1 : 0)) * 2.4 * dt;
    this.pitch += ((this.isDown('ArrowUp') ? 1 : 0) - (this.isDown('ArrowDown') ? 1 : 0)) * 1.8 * dt;
    this.clampPitch();
  }

  private clampPitch(): void {
    const lim = Math.PI / 2 - 0.001;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  isButtonDown(button: number): boolean {
    return this.buttons.has(button);
  }

  dispose(): void {
    clearTimeout(this.lockTimer);
    this.unlock();
    this.abort.abort();
  }
}
