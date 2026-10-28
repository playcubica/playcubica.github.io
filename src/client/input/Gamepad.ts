// Game controllers through the browser's Gamepad API. Bluetooth (and USB) controllers that are
// paired with the computer show up here once a button is pressed on the page. Buttons use the
// "standard" layout (Xbox names; PlayStation: A=✕, B=○, X=□, Y=△).

export const Pad = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  BACK: 8,
  START: 9,
  L3: 10,
  R3: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
} as const;

const BUTTONS = 17;
const DEADZONE = 0.18;

/** Stick value with a radial deadzone, rescaled to 0..1 beyond it. */
function stick(x: number, y: number): [number, number] {
  const m = Math.hypot(x, y);
  if (m < DEADZONE) return [0, 0];
  const k = Math.min(1, (m - DEADZONE) / (1 - DEADZONE)) / m;
  return [x * k, y * k];
}

export interface PadFrame {
  /** Seconds since the previous frame. */
  dt: number;
  held(b: number): boolean;
  /** Went down this frame. */
  pressed(b: number): boolean;
  /** Went up this frame. */
  released(b: number): boolean;
  /** Left / right stick, x right, y down, deadzone applied. */
  left: [number, number];
  right: [number, number];
  /**
   * Menu-style direction with key repeat (from the D-pad or the left stick):
   * fires once on push, then repeats while held.
   */
  nav: { x: number; y: number };
}

type Listener = (f: PadFrame) => void;

/** Polls the first connected controller once per animation frame and hands frames to listeners. */
export class GamepadInput {
  private readonly listeners = new Set<Listener>();
  private prev = new Array<boolean>(BUTTONS).fill(false);
  private last = 0;
  private running = false;
  private navHeld = { x: 0, y: 0, next: 0 };
  /** performance.now() of the last controller input (any button or stick). */
  lastUsed = -Infinity;
  /** Name of the connected controller, or null. */
  connectedName: string | null = null;
  onConnectChange: ((name: string | null) => void) | null = null;

  /** True if the controller was used in the last couple of seconds (vs. mouse/keyboard). */
  get active(): boolean {
    return performance.now() - this.lastUsed < 2000;
  }

  start(): void {
    if (this.running || typeof navigator === 'undefined' || !('getGamepads' in navigator)) return;
    this.running = true;
    window.addEventListener('gamepadconnected', () => this.checkConnected());
    window.addEventListener('gamepaddisconnected', () => this.checkConnected());
    const loop = (t: number) => {
      this.poll(t);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  listen(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private find(): Gamepad | null {
    for (const g of navigator.getGamepads()) if (g && g.connected) return g;
    return null;
  }

  private checkConnected(): void {
    const g = this.find();
    const name = g ? g.id.replace(/\s*\(.*?\)\s*/g, ' ').trim() || 'שלט' : null;
    if (name === this.connectedName) return;
    this.connectedName = name;
    this.onConnectChange?.(name);
  }

  private poll(t: number): void {
    const dt = Math.min(0.1, this.last ? (t - this.last) / 1000 : 0);
    this.last = t;
    const g = this.find();
    if (!g) {
      if (this.connectedName) this.checkConnected();
      this.prev.fill(false);
      return;
    }
    if (!this.connectedName) this.checkConnected();
    const now = new Array<boolean>(BUTTONS).fill(false);
    for (let i = 0; i < BUTTONS && i < g.buttons.length; i++) {
      const b = g.buttons[i];
      now[i] = b.pressed || b.value > 0.5;
    }
    const left = stick(g.axes[0] ?? 0, g.axes[1] ?? 0);
    const right = stick(g.axes[2] ?? 0, g.axes[3] ?? 0);
    if (now.some(Boolean) || left[0] || left[1] || right[0] || right[1]) this.lastUsed = performance.now();

    // Menu navigation with repeat: first step at once, then after 0.4 s every 0.12 s.
    const dx = now[Pad.RIGHT] || left[0] > 0.6 ? 1 : now[Pad.LEFT] || left[0] < -0.6 ? -1 : 0;
    const dy = now[Pad.DOWN] || left[1] > 0.6 ? 1 : now[Pad.UP] || left[1] < -0.6 ? -1 : 0;
    const nav = { x: 0, y: 0 };
    if (dx !== this.navHeld.x || dy !== this.navHeld.y) {
      this.navHeld = { x: dx, y: dy, next: t + 400 };
      nav.x = dx;
      nav.y = dy;
    } else if ((dx || dy) && t >= this.navHeld.next) {
      this.navHeld.next = t + 120;
      nav.x = dx;
      nav.y = dy;
    }

    const prev = this.prev;
    const frame: PadFrame = {
      dt,
      held: (b) => now[b],
      pressed: (b) => now[b] && !prev[b],
      released: (b) => !now[b] && prev[b],
      left,
      right,
      nav,
    };
    for (const fn of [...this.listeners]) fn(frame);
    this.prev = now;
  }
}

/** The one controller input for the page (menus and game share it). */
export const gamepad = new GamepadInput();
