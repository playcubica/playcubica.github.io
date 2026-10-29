import { boxIntersectsSolid } from '../../shared/physics/collision';
import { PlayerBody, type MoveInput } from '../../shared/physics/PlayerBody';
import type { ClientWorld } from '../ClientWorld';
import { KEYS, type Controls } from '../input/Controls';

const STEP = 1 / 60;
const DOUBLE_TAP_MS = 300;

/** Sitting on a creature: the body takes its size, speed and jump; `steer` = the rider controls it. */
export interface Mount {
  id: number;
  speed: number;
  jump: number;
  steer: boolean;
  width: number;
  height: number;
}

/** The player this client controls: input → fixed-step physics. */
export class LocalPlayer {
  readonly body = new PlayerBody();
  canFly = false;
  canSprint = true;
  /** Physics stays frozen until the chunk under the player has arrived. */
  private ready = false;
  private acc = 0;
  private lastJumpTap = 0;
  riding: Mount | null = null;
  /** Sneak while riding = get off (the host decides). */
  onDismount: (() => void) | null = null;
  private dismountAsked = false;

  constructor(private readonly world: ClientWorld, private readonly controls: Controls) {}

  teleport(x: number, y: number, z: number): void {
    this.body.x = x;
    this.body.y = y;
    this.body.z = z;
    this.body.vx = this.body.vy = this.body.vz = 0;
    this.ready = false;
  }

  mount(m: Mount): void {
    const b = this.body;
    this.riding = m;
    this.dismountAsked = false;
    b.flying = false;
    b.width = m.width;
    b.height = m.height;
    b.walkSpeed = m.speed;
    b.jumpVelocity = m.jump;
    b.eyeOverride = m.height - 0.2;
  }

  unmount(): void {
    const b = this.body;
    const fresh = new PlayerBody();
    this.riding = null;
    b.width = fresh.width;
    b.height = fresh.height;
    b.walkSpeed = fresh.walkSpeed;
    b.jumpVelocity = fresh.jumpVelocity;
    b.eyeOverride = null;
    b.y += 0.1;
  }

  /** Called on every key press (for double-tap detection). */
  keyPressed(code: string): void {
    if (code !== KEYS.jump || !this.canFly) return;
    const now = performance.now();
    if (now - this.lastJumpTap < DOUBLE_TAP_MS) {
      this.body.flying = !this.body.flying;
      this.body.vy = 0;
      this.lastJumpTap = 0;
    } else {
      this.lastJumpTap = now;
    }
  }

  update(dt: number): void {
    const b = this.body;
    if (!this.ready) {
      if (!this.world.has(Math.floor(b.x) >> 4, Math.floor(b.z) >> 4)) return;
      // Spawned inside terrain (e.g. a tree trunk): move up until free.
      for (let i = 0; i < 256; i++) {
        const { min, max } = b.box();
        if (!boxIntersectsSolid(this.world, min, max)) break;
        b.y = Math.floor(b.y) + 1;
      }
      this.ready = true;
    }
    if (!this.canFly || this.riding) b.flying = false;

    const c = this.controls;
    const input: MoveInput = {
      forward: Math.max(-1, Math.min(1, (c.isDown(KEYS.forward) ? 1 : 0) - (c.isDown(KEYS.back) ? 1 : 0) + c.padMove.forward)),
      strafe: Math.max(-1, Math.min(1, (c.isDown(KEYS.right) ? 1 : 0) - (c.isDown(KEYS.left) ? 1 : 0) + c.padMove.strafe)),
      jump: c.isDown(KEYS.jump),
      sneak: c.isDown(KEYS.sneak),
      sprint: this.canSprint && (c.isDown(KEYS.sprint) || (b.sprinting && (c.isDown(KEYS.forward) || c.padMove.forward > 0.3))),
      yaw: c.yaw,
    };
    const r = this.riding;
    if (r) {
      if (input.sneak && !this.dismountAsked) {
        this.dismountAsked = true;
        this.onDismount?.();
      }
      input.sneak = false;
      input.sprint = false;
      if (!r.steer) {
        input.forward = input.strafe = 0;
        input.jump = false;
      } else if (b.horizontalCollision && b.onGround && input.forward > 0) {
        // A horse takes single steps by itself.
        input.jump = true;
      }
    }
    this.acc = Math.min(this.acc + dt, 0.25);
    while (this.acc >= STEP) {
      b.step(this.world, input, STEP);
      this.acc -= STEP;
    }
  }

  get eyeY(): number {
    return this.body.y + this.body.eyeHeight;
  }
}
