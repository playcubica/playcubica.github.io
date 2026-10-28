import {
  B, DIR_VEC, DOOR_OPEN, DOOR_UPPER, FACING_DIR, OPPOSITE_DIR, POWER_ON, PUSHER_EXTENDED, REPLACEABLE, withState,
} from '../shared/blocks/registry';

// "Glow power": Cubica's signal system.
//   Sources: lever (toggle), pressure plate (something standing on it), power crystal (always on).
//   Glowwire carries a signal of strength 15 that drops by 1 per wire block (same level, 4 directions).
//   Relay: passes the signal from its back to its front after 2 ticks (restoring full strength).
//   Inverter: its front is on while its back is OFF (after 2 ticks) — clocks and latches.
//   Consumers next to a signal: glow lamps light up, pushers extend/retract, doors open/close.

export interface PowerHost {
  /** Raw block value, or -1 if the chunk is not loaded. */
  getRaw(x: number, y: number, z: number): number;
  /** Sets a block (lighting, broadcast) without triggering another power update. */
  setRaw(x: number, y: number, z: number, raw: number): void;
  hasBlockEntity(x: number, y: number, z: number): boolean;
  /** Calls PowerGrid.gateTick(x, y, z) after `ticks`. */
  schedule(ticks: number, x: number, y: number, z: number): void;
}

const WIRE_DIRS = [0, 1, 4, 5];
const MAX_PUSH = 12;
const MAX_NETWORK = 4096;
const MAX_WORK = 512;
const IMMOVABLE = new Set<number>([B.COREROCK, B.PUSHER, B.PUSHER_HEAD, B.RIFT, B.RIFT_STONE, B.ASHWOOD_DOOR, B.BEDROLL, B.WATER, B.MAGMA]);

/** Blocks whose surroundings matter for power. */
export function isPowerBlock(id: number): boolean {
  return id === B.GLOWWIRE || id === B.LEVER || id === B.PRESSURE_PLATE || id === B.POWER_CRYSTAL || id === B.RELAY ||
    id === B.INVERTER || id === B.LAMP || id === B.LAMP_ON || id === B.PUSHER || id === B.ASHWOOD_DOOR;
}

/** Blocks that carry or produce a signal (as opposed to consumers like lamps and doors). */
export function isSignalBlock(id: number): boolean {
  return id === B.GLOWWIRE || id === B.LEVER || id === B.PRESSURE_PLATE || id === B.POWER_CRYSTAL || id === B.RELAY || id === B.INVERTER;
}

/** Power a (non-wire) block sends to its neighbour in direction d. */
function emitted(raw: number, d: number): number {
  const id = raw & 0xfff;
  const st = raw >>> 12;
  switch (id) {
    case B.LEVER:
    case B.PRESSURE_PLATE:
      return st & POWER_ON ? 15 : 0;
    case B.POWER_CRYSTAL:
      return 15;
    case B.RELAY:
    case B.INVERTER:
      return st & POWER_ON && d === FACING_DIR[st & 3] ? 15 : 0;
    default:
      return 0;
  }
}

type Pos = [number, number, number];
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

export class PowerGrid {
  constructor(private readonly host: PowerHost) {}

  /** Strongest signal reaching (x, y, z) from any neighbour. */
  inputAt(x: number, y: number, z: number): number {
    let best = 0;
    for (let d = 0; d < 6; d++) {
      const [dx, dy, dz] = DIR_VEC[d];
      const raw = this.host.getRaw(x + dx, y + dy, z + dz);
      if (raw <= 0) continue;
      const p = (raw & 0xfff) === B.GLOWWIRE ? raw >>> 12 : emitted(raw, OPPOSITE_DIR[d]);
      if (p > best) best = p;
    }
    return best;
  }

  /** Signal arriving at a relay/inverter from behind. */
  private gateInput(x: number, y: number, z: number, raw: number): number {
    const front = FACING_DIR[(raw >>> 12) & 3];
    const back = OPPOSITE_DIR[front];
    const [dx, dy, dz] = DIR_VEC[back];
    const n = this.host.getRaw(x + dx, y + dy, z + dz);
    if (n <= 0) return 0;
    return (n & 0xfff) === B.GLOWWIRE ? n >>> 12 : emitted(n, front);
  }

  /** Re-evaluates power around a changed block. `fromPower` = the change was a signal change. */
  update(x: number, y: number, z: number, fromPower = true): void {
    const work: Array<{ p: Pos; fromPower: boolean }> = [{ p: [x, y, z], fromPower }];
    const done = new Set<string>();
    for (let n = 0; work.length > 0 && n < MAX_WORK; n++) {
      const { p, fromPower: fp } = work.shift()!;
      const k = key(...p);
      if (done.has(k)) continue;
      done.add(k);
      const around: Pos[] = [p, ...DIR_VEC.map(([dx, dy, dz]): Pos => [p[0] + dx, p[1] + dy, p[2] + dz])];
      const changed = this.recomputeWires(around.filter(([a, b, c]) => (this.host.getRaw(a, b, c) & 0xfff) === B.GLOWWIRE));
      const touched = new Map<string, Pos>();
      for (const q of [...around, ...changed]) {
        touched.set(key(...q), q);
        for (const [dx, dy, dz] of DIR_VEC) touched.set(key(q[0] + dx, q[1] + dy, q[2] + dz), [q[0] + dx, q[1] + dy, q[2] + dz]);
      }
      for (const q of touched.values()) {
        const moved = this.react(q, fp || changed.length > 0);
        for (const m of moved) work.push({ p: m, fromPower: true });
      }
    }
  }

  /** Recomputes the signal strength of every wire network touching the seeds. Returns wires that changed. */
  private recomputeWires(seeds: Pos[]): Pos[] {
    const changed: Pos[] = [];
    const seen = new Set<string>();
    for (const seed of seeds) {
      if (seen.has(key(...seed))) continue;
      // Collect the network.
      const net: Pos[] = [];
      const index = new Map<string, number>();
      const stack = [seed];
      seen.add(key(...seed));
      while (stack.length > 0 && net.length < MAX_NETWORK) {
        const w = stack.pop()!;
        index.set(key(...w), net.length);
        net.push(w);
        for (const d of WIRE_DIRS) {
          const [dx, , dz] = DIR_VEC[d];
          const n: Pos = [w[0] + dx, w[1], w[2] + dz];
          const nk = key(...n);
          if (seen.has(nk) || (this.host.getRaw(...n) & 0xfff) !== B.GLOWWIRE) continue;
          seen.add(nk);
          stack.push(n);
        }
      }
      // Strength fed in by sources next to each wire, then spread with -1 per step.
      const level = net.map(([wx, wy, wz]) => {
        let best = 0;
        for (let d = 0; d < 6; d++) {
          const [dx, dy, dz] = DIR_VEC[d];
          const raw = this.host.getRaw(wx + dx, wy + dy, wz + dz);
          if (raw > 0 && (raw & 0xfff) !== B.GLOWWIRE) best = Math.max(best, emitted(raw, OPPOSITE_DIR[d]));
        }
        return best;
      });
      const buckets: number[][] = Array.from({ length: 16 }, () => []);
      level.forEach((l, i) => l > 0 && buckets[l].push(i));
      for (let l = 15; l > 1; l--) {
        for (const i of buckets[l]) {
          if (level[i] !== l) continue;
          for (const d of WIRE_DIRS) {
            const [dx, , dz] = DIR_VEC[d];
            const j = index.get(key(net[i][0] + dx, net[i][1], net[i][2] + dz));
            if (j !== undefined && level[j] < l - 1) {
              level[j] = l - 1;
              buckets[l - 1].push(j);
            }
          }
        }
      }
      net.forEach((w, i) => {
        if (this.host.getRaw(...w) >>> 12 !== level[i]) {
          this.host.setRaw(...w, withState(B.GLOWWIRE, level[i]));
          changed.push(w);
        }
      });
    }
    return changed;
  }

  /** Lets a consumer respond to its input. Returns positions whose blocks moved (pushers). */
  private react([x, y, z]: Pos, fromPower: boolean): Pos[] {
    const raw = this.host.getRaw(x, y, z);
    if (raw <= 0) return [];
    const id = raw & 0xfff;
    const st = raw >>> 12;
    switch (id) {
      case B.LAMP:
      case B.LAMP_ON: {
        const want = this.inputAt(x, y, z) > 0 ? B.LAMP_ON : B.LAMP;
        if (want !== id) this.host.setRaw(x, y, z, want);
        return [];
      }
      case B.RELAY:
      case B.INVERTER:
        this.host.schedule(2, x, y, z);
        return [];
      case B.PUSHER: {
        const powered = this.inputAt(x, y, z) > 0;
        const extended = (st & PUSHER_EXTENDED) !== 0;
        if (powered && !extended) return this.extend(x, y, z, raw);
        if (!powered && extended) return this.retract(x, y, z, raw);
        return [];
      }
      case B.ASHWOOD_DOOR: {
        // Doors follow the signal only when the signal changes, so hand-opened doors stay open.
        if (!fromPower) return [];
        const lower = st & DOOR_UPPER ? y - 1 : y;
        const open = this.inputAt(x, lower, z) > 0 || this.inputAt(x, lower + 1, z) > 0;
        for (const yy of [lower, lower + 1]) {
          const r = this.host.getRaw(x, yy, z);
          if ((r & 0xfff) !== B.ASHWOOD_DOOR) continue;
          const isOpen = ((r >>> 12) & DOOR_OPEN) !== 0;
          if (isOpen !== open) this.host.setRaw(x, yy, z, r ^ (DOOR_OPEN << 12));
        }
        return [];
      }
      default:
        return [];
    }
  }

  /** Delayed relay/inverter evaluation. */
  gateTick(x: number, y: number, z: number): void {
    const raw = this.host.getRaw(x, y, z);
    const id = raw & 0xfff;
    if (id !== B.RELAY && id !== B.INVERTER) return;
    const input = this.gateInput(x, y, z, raw) > 0;
    const out = id === B.RELAY ? input : !input;
    const st = raw >>> 12;
    if (out === ((st & POWER_ON) !== 0)) return;
    this.host.setRaw(x, y, z, withState(id, out ? st | POWER_ON : st & ~POWER_ON));
    const [dx, dy, dz] = DIR_VEC[FACING_DIR[st & 3]];
    this.update(x + dx, y + dy, z + dz);
  }

  private extend(x: number, y: number, z: number, raw: number): Pos[] {
    const dir = (raw >>> 12) & 7;
    const [vx, vy, vz] = DIR_VEC[dir];
    const line: number[] = [];
    for (let i = 1; ; i++) {
      const cx = x + vx * i;
      const cy = y + vy * i;
      const cz = z + vz * i;
      if (cy < 0 || cy > 255) return [];
      const r = this.host.getRaw(cx, cy, cz);
      if (r < 0) return [];
      const id = r & 0xfff;
      if (id === B.AIR || (REPLACEABLE[id] && !IMMOVABLE.has(id))) break;
      if (IMMOVABLE.has(id) || this.host.hasBlockEntity(cx, cy, cz) || i > MAX_PUSH) return [];
      line.push(r);
    }
    const moved: Pos[] = [];
    for (let j = line.length - 1; j >= 0; j--) {
      const p: Pos = [x + vx * (j + 2), y + vy * (j + 2), z + vz * (j + 2)];
      this.host.setRaw(...p, line[j]);
      moved.push(p);
    }
    this.host.setRaw(x + vx, y + vy, z + vz, withState(B.PUSHER_HEAD, dir));
    this.host.setRaw(x, y, z, raw | (PUSHER_EXTENDED << 12));
    moved.push([x + vx, y + vy, z + vz]);
    return moved;
  }

  private retract(x: number, y: number, z: number, raw: number): Pos[] {
    const dir = (raw >>> 12) & 7;
    const [vx, vy, vz] = DIR_VEC[dir];
    const head = this.host.getRaw(x + vx, y + vy, z + vz);
    if ((head & 0xfff) === B.PUSHER_HEAD) this.host.setRaw(x + vx, y + vy, z + vz, B.AIR);
    this.host.setRaw(x, y, z, raw & ~(PUSHER_EXTENDED << 12));
    return [[x + vx, y + vy, z + vz]];
  }
}
