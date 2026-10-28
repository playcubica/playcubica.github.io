import { B } from '../blocks/registry';
import { waterFlow } from '../world/fluid';
import { sweepAxis, type SolidQuery } from './collision';

// Movement physics for players and creatures, in blocks and seconds. Players run it
// on their client at a fixed step; the host runs it for creatures.

export interface WorldQuery extends SolidQuery {
  isWater(x: number, y: number, z: number): boolean;
  /** Raw block values, for the water current and bouncing on beds (optional). */
  getRaw?(x: number, y: number, z: number): number;
}

export interface MoveInput {
  /** -1..1 along the view direction (flattened). */
  forward: number;
  /** -1..1, positive = right. */
  strafe: number;
  jump: boolean;
  sneak: boolean;
  sprint: boolean;
  yaw: number;
}

export const PLAYER_WIDTH = 0.6;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.62;
export const SNEAK_EYE_HEIGHT = 1.32;

const WALK = 4.3;
const SPRINT = 5.6;
const SNEAK = 1.3;
const FLY = 10.8;
const FLY_SPRINT = 21.6;
const GRAVITY = 28;
const TERMINAL = 60;
const JUMP_VELOCITY = 8.4; // ≈1.26 blocks high
const GROUND_ACCEL = 18;
const AIR_ACCEL = 3;
const WATER_ACCEL = 6;
const WATER_DRAG = 4;
const WATER_SINK = 2.2;
const SWIM_UP = 3.2;
/** Speed of a water current, blocks per second. */
const CURRENT = 1.4;
/** Landing on a bed throws you back up with this share of the impact speed. */
const BED_BOUNCE = 0.66;

export class PlayerBody {
  /** Feet position (centre of the bottom face). */
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  onGround = false;
  inWater = false;
  eyeInWater = false;
  flying = false;
  sneaking = false;
  sprinting = false;
  horizontalCollision = false;
  /** Largest downward speed since last touching ground or water. */
  fallSpeed = 0;
  width = PLAYER_WIDTH;
  height = PLAYER_HEIGHT;
  walkSpeed = WALK;
  /** Creatures that walk up walls (Skitterling). */
  climber = false;
  /** Set when the body bounced off a bed (cleared by whoever reports it). */
  bounced = false;

  box(x = this.x, y = this.y, z = this.z): { min: number[]; max: number[] } {
    const h = this.width / 2;
    return { min: [x - h, y, z - h], max: [x + h, y + this.height, z + h] };
  }

  /** Adds an outside push (hits, knockback). */
  push(vx: number, vy: number, vz: number): void {
    this.vx += vx;
    this.vy = Math.max(this.vy, vy);
    this.vz += vz;
    this.onGround = false;
  }

  get eyeHeight(): number {
    return this.sneaking && !this.flying ? SNEAK_EYE_HEIGHT : EYE_HEIGHT;
  }

  step(q: WorldQuery, input: MoveInput, dt: number): void {
    const fx = Math.floor(this.x);
    const fz = Math.floor(this.z);
    this.inWater = q.isWater(fx, Math.floor(this.y + 0.4), fz);
    this.eyeInWater = q.isWater(fx, Math.floor(this.y + this.eyeHeight), fz);
    this.sneaking = input.sneak && !this.flying;
    this.sprinting = input.sprint && input.forward > 0 && !this.sneaking;

    // Desired horizontal velocity from input.
    let ix = 0;
    let iz = 0;
    const sin = Math.sin(input.yaw);
    const cos = Math.cos(input.yaw);
    ix += -sin * input.forward + cos * input.strafe;
    iz += -cos * input.forward - sin * input.strafe;
    const len = Math.hypot(ix, iz);
    if (len > 1) { ix /= len; iz /= len; }

    let speed: number;
    let accel: number;
    if (this.flying) {
      speed = input.sprint ? FLY_SPRINT : FLY;
      accel = 10;
    } else if (this.inWater) {
      speed = this.walkSpeed * 0.5 * (this.sprinting ? 1.3 : 1);
      accel = WATER_ACCEL;
    } else {
      speed = this.sneaking ? SNEAK : this.sprinting ? this.walkSpeed * (SPRINT / WALK) : this.walkSpeed;
      accel = this.onGround ? GROUND_ACCEL : AIR_ACCEL;
    }
    // A water current carries you along.
    let cx = 0;
    let cy = 0;
    let cz = 0;
    if (this.inWater && !this.flying && q.getRaw) {
      const getRaw = q.getRaw.bind(q);
      const f = waterFlow(getRaw, fx, Math.floor(this.y + 0.4), fz);
      if (f) [cx, cy, cz] = f;
    }
    const k = 1 - Math.exp(-accel * dt);
    this.vx += (ix * speed + cx * CURRENT - this.vx) * k;
    this.vz += (iz * speed + cz * CURRENT - this.vz) * k;

    // Vertical.
    if (this.flying) {
      const target = (input.jump ? 1 : 0) - (input.sneak ? 1 : 0);
      this.vy += (target * speed * 0.75 - this.vy) * k;
    } else if (this.inWater) {
      // Water drag: vertical speed eases towards swimming up or slowly sinking.
      const kv = 1 - Math.exp(-WATER_DRAG * dt);
      this.vy += ((input.jump ? SWIM_UP : -WATER_SINK + cy * CURRENT) - this.vy) * kv;
      // Hop out onto a ledge.
      if (input.jump && this.horizontalCollision) this.vy = Math.max(this.vy, 5.5);
    } else if (this.climber && this.horizontalCollision && input.forward > 0) {
      this.vy = 3;
    } else {
      if (input.jump && this.onGround) this.vy = JUMP_VELOCITY;
      this.vy = Math.max(this.vy - GRAVITY * dt, -TERMINAL);
    }

    let dx = this.vx * dt;
    let dy = this.vy * dt;
    let dz = this.vz * dt;

    // Sneaking on the ground: never walk off an edge.
    if (this.sneaking && this.onGround) {
      const supported = (ox: number, oz: number) => {
        const { min, max } = this.box(this.x + ox, this.y, this.z + oz);
        return sweepAxis(q, min, max, 1, -0.6) > -0.6;
      };
      const stepBack = (v: number) => (Math.abs(v) < 0.02 ? 0 : v - Math.sign(v) * 0.02);
      while (dx !== 0 && !supported(dx, 0)) dx = stepBack(dx);
      while (dz !== 0 && !supported(0, dz)) dz = stepBack(dz);
      while (dx !== 0 && dz !== 0 && !supported(dx, dz)) { dx = stepBack(dx); dz = stepBack(dz); }
    }

    const { min, max } = this.box();
    const ry = sweepAxis(q, min, max, 1, dy);
    min[1] += ry; max[1] += ry;
    const rx = sweepAxis(q, min, max, 0, dx);
    min[0] += rx; max[0] += rx;
    const rz = sweepAxis(q, min, max, 2, dz);

    this.x += rx;
    this.y += ry;
    this.z += rz;
    this.horizontalCollision = rx !== dx || rz !== dz;
    if (rx !== dx) this.vx = 0;
    if (rz !== dz) this.vz = 0;
    const landed = dy < 0 && ry !== dy;
    const impact = this.vy;
    if (ry !== dy) this.vy = 0;
    this.onGround = landed || (dy === 0 && this.onGround);
    if (landed && !this.sneaking && impact < -3 && q.getRaw && (q.getRaw(Math.floor(this.x), Math.floor(this.y - 0.01), Math.floor(this.z)) & 0xfff) === B.BEDROLL) {
      this.vy = -impact * BED_BOUNCE;
      this.onGround = false;
      this.bounced = true;
    }
    if (this.onGround && this.flying) this.flying = false;

    if (this.onGround || this.inWater || this.flying) this.fallSpeed = 0;
    else this.fallSpeed = Math.max(this.fallSpeed, -this.vy);
  }
}
