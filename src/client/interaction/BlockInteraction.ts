import * as THREE from 'three';
import { B, DOOR_OPEN, DOOR_UPPER, POWER_ON, OPAQUE, RENDER, REPLACEABLE, SOLID, withState } from '../../shared/blocks/registry';
import { isInteractive, isSupported, placementRaw } from '../../shared/blocks/placement';
import type { Inventory } from '../../shared/items/Inventory';
import { breakTime, CREATIVE_BREAK_DELAY, EAT_TIME, REACH } from '../../shared/items/mining';
import { PLAYER_ATTACK_COOLDOWN, PLAYER_ATTACK_REACH } from '../../shared/entities/mobs';
import { itemDef } from '../../shared/items/registry';
import { runeLevel, RUNE_SWIFT } from '../../shared/items/runes';
import { boxOverlapsBlock } from '../../shared/physics/collision';
import { raycast, type RayHit } from '../../shared/physics/raycast';
import { mulberry32 } from '../../shared/rng';
import type { ClientMsg } from '../../shared/protocol/messages';
import type { ClientWorld } from '../ClientWorld';
import { KEYS, MouseButton, type Controls } from '../input/Controls';

export interface InteractionHost {
  readonly world: ClientWorld;
  readonly inventory: Inventory;
  readonly creative: boolean;
  /** Hunger below full (eating allowed). */
  readonly hungry: boolean;
  send(msg: ClientMsg): void;
  /** Applies a block change locally before the host confirms it. */
  predictBlock(x: number, y: number, z: number, raw: number): void;
  playerBox(): { min: number[]; max: number[] };
  /** Creative "pick block": put this block in the hotbar. */
  pickBlock(id: number): void;
  /** Nearest creature under the crosshair. */
  pickEntity(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): { id: number; distance: number } | null;
}

const PLACE_REPEAT = 0.22;
const SURVIVAL_BREAK_DELAY = 0.25;
const CRACK_STAGES = 10;
const NEIGHBOURS = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];

const targetable = (id: number) => RENDER[id] === 1 || RENDER[id] === 2 || RENDER[id] === 4;

function crackTextures(): THREE.Texture[] {
  const rnd = mulberry32(77);
  // Grow a set of random-walk cracks; stage k shows the first (k+1)/10 of the pixels.
  const pixels: Array<[number, number]> = [];
  for (let n = 0; n < 6; n++) {
    let x = 4 + Math.floor(rnd() * 8);
    let y = 4 + Math.floor(rnd() * 8);
    for (let s = 0; s < 14; s++) {
      pixels.push([x, y]);
      x = Math.max(0, Math.min(15, x + Math.round(rnd() * 2 - 1)));
      y = Math.max(0, Math.min(15, y + Math.round(rnd() * 2 - 1)));
    }
  }
  const textures: THREE.Texture[] = [];
  for (let k = 0; k < CRACK_STAGES; k++) {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const g = c.getContext('2d')!;
    g.fillStyle = 'rgba(20,16,12,0.8)';
    const count = Math.ceil(((k + 1) / CRACK_STAGES) * pixels.length);
    for (let i = 0; i < count; i++) {
      // Interleave cracks so every stage grows all of them a bit.
      const [x, y] = pixels[(i % 6) * 14 + Math.floor(i / 6)];
      g.fillRect(x, y, 1, 1);
    }
    const t = new THREE.CanvasTexture(c);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    textures.push(t);
  }
  return textures;
}

/** Targeting, mining (with progress and cracks), placing, using blocks and eating. */
export class BlockInteraction {
  target: RayHit | null = null;
  /** Creature under the crosshair (takes priority over a block behind it). */
  entityTarget: number | null = null;
  /** performance.now() of the last attack (real time, so low frame rates don't slow attacks). */
  private lastAttack = 0;
  /** 0..1 while eating, else null. */
  eating: number | null = null;
  private dig: { x: number; y: number; z: number; progress: number; need: number } | null = null;
  private breakCooldown = 0;
  private placeCooldown = 0;
  private eatSlot = -1;
  private readonly outline: THREE.LineSegments;
  private readonly crack: THREE.Mesh;
  private readonly crackMaterial: THREE.MeshBasicMaterial;
  private readonly crackTextures = crackTextures();

  constructor(scene: THREE.Scene, private readonly host: InteractionHost, private readonly controls: Controls) {
    this.outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004)),
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55 }),
    );
    this.outline.visible = false;
    this.crackMaterial = new THREE.MeshBasicMaterial({
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.crack = new THREE.Mesh(new THREE.BoxGeometry(1.002, 1.002, 1.002), this.crackMaterial);
    this.crack.visible = false;
    scene.add(this.outline, this.crack);
    controls.onMouseDown = (button) => this.mouseDown(button);
  }

  /** Breaking progress 0..1 of the current target (for the HUD/debug). */
  get progress(): number {
    return this.dig?.progress ?? 0;
  }

  update(dt: number, eye: THREE.Vector3, dir: THREE.Vector3): void {
    const w = this.host.world;
    this.target = raycast((x, y, z) => w.getBlock(x, y, z), targetable, eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, REACH);
    const ent = this.host.pickEntity(eye, dir, PLAYER_ATTACK_REACH);
    this.entityTarget = null;
    if (ent && (!this.target || ent.distance < this.target.distance)) {
      this.entityTarget = ent.id;
      this.target = null;
    }
    if (this.entityTarget !== null && this.controls.isButtonDown(MouseButton.LEFT)) this.attack();
    const t = this.target;
    this.outline.visible = !!t;
    if (t) this.outline.position.set(t.x + 0.5, t.y + 0.5, t.z + 0.5);

    this.breakCooldown = Math.max(0, this.breakCooldown - dt);
    this.placeCooldown = Math.max(0, this.placeCooldown - dt);

    if (this.controls.isButtonDown(MouseButton.LEFT) && t) this.mine(dt, t);
    else this.stopDigging();

    const right = this.controls.isButtonDown(MouseButton.RIGHT);
    if (right && this.canEatHeld() && !(t && this.usesBlock(t))) this.eat(dt);
    else {
      this.stopEating();
      if (right && this.placeCooldown === 0 && !(t && this.usesBlock(t))) this.place();
    }

    const d = this.dig;
    this.crack.visible = !!d && d.progress > 0;
    if (d && d.progress > 0) {
      this.crack.position.set(d.x + 0.5, d.y + 0.5, d.z + 0.5);
      this.crackMaterial.map = this.crackTextures[Math.min(CRACK_STAGES - 1, Math.floor(d.progress * CRACK_STAGES))];
      this.crackMaterial.needsUpdate = true;
    }
  }

  /** Right-click on this block opens/toggles it (sneak to place against it instead). */
  private usesBlock(t: RayHit): boolean {
    return isInteractive(t.id, this.host.inventory.held?.id ?? 0) && !this.controls.isDown(KEYS.sneak);
  }

  private canEatHeld(): boolean {
    const held = this.host.inventory.held;
    return !!held && !!itemDef(held.id)?.food && this.host.hungry && !this.host.creative;
  }

  private mouseDown(button: number): void {
    const t = this.target;
    if (button === MouseButton.RIGHT) {
      if (this.entityTarget !== null) this.host.send({ t: 'interact', entityId: this.entityTarget });
      else if (t && this.usesBlock(t)) this.useBlock(t);
      else if (!this.canEatHeld()) {
        this.placeCooldown = 0;
        this.place();
      }
    } else if (button === MouseButton.LEFT) {
      this.breakCooldown = 0;
      if (this.entityTarget !== null) this.attack();
    } else if (button === MouseButton.MIDDLE && t && this.host.creative) {
      this.host.pickBlock(t.id);
    }
  }

  private attack(): void {
    const now = performance.now();
    if (now - this.lastAttack < PLAYER_ATTACK_COOLDOWN * 1000 || this.entityTarget === null) return;
    this.lastAttack = now;
    this.host.send({ t: 'attack', entityId: this.entityTarget });
  }

  private useBlock(t: RayHit): void {
    const h = this.host;
    h.send({ t: 'useBlock', x: t.x, y: t.y, z: t.z });
    if (t.id === B.LEVER) h.predictBlock(t.x, t.y, t.z, h.world.getRaw(t.x, t.y, t.z) ^ (POWER_ON << 12));
    if (t.id === B.ASHWOOD_DOOR) {
      const raw = h.world.getRaw(t.x, t.y, t.z);
      const lower = (raw >>> 12) & DOOR_UPPER ? t.y - 1 : t.y;
      for (const y of [lower, lower + 1]) {
        const r = h.world.getRaw(t.x, y, t.z);
        if ((r & 0xfff) === B.ASHWOOD_DOOR) h.predictBlock(t.x, y, t.z, r ^ (DOOR_OPEN << 12));
      }
    }
  }

  private eat(dt: number): void {
    const inv = this.host.inventory;
    if (this.eating === null || this.eatSlot !== inv.selected) {
      this.stopEating();
      this.eating = 0;
      this.eatSlot = inv.selected;
      this.host.send({ t: 'useItem', phase: 0, slot: inv.selected });
    }
    this.eating += dt / EAT_TIME;
    if (this.eating >= 1) {
      this.host.send({ t: 'useItem', phase: 2, slot: this.eatSlot });
      this.eating = null;
    }
  }

  private stopEating(): void {
    if (this.eating !== null) this.host.send({ t: 'useItem', phase: 1, slot: this.eatSlot });
    this.eating = null;
  }

  private mine(dt: number, t: RayHit): void {
    if (this.breakCooldown > 0) return;
    const h = this.host;
    if (h.creative) {
      this.breakAt(t.x, t.y, t.z);
      this.breakCooldown = CREATIVE_BREAK_DELAY;
      return;
    }
    const d = this.dig;
    if (!d || d.x !== t.x || d.y !== t.y || d.z !== t.z) {
      this.stopDigging();
      const held = h.inventory.held;
      const need = breakTime(t.id, held ? itemDef(held.id) : undefined, false, runeLevel(held, RUNE_SWIFT));
      if (!Number.isFinite(need)) return;
      this.dig = { x: t.x, y: t.y, z: t.z, progress: 0, need };
      h.send({ t: 'dig', phase: 0, x: t.x, y: t.y, z: t.z, face: 0 });
    }
    const cur = this.dig!;
    cur.progress = cur.need <= 0 ? 1 : cur.progress + dt / cur.need;
    if (cur.progress >= 1) {
      this.dig = null;
      this.breakAt(cur.x, cur.y, cur.z);
      this.breakCooldown = SURVIVAL_BREAK_DELAY;
    }
  }

  private breakAt(x: number, y: number, z: number): void {
    const h = this.host;
    h.send({ t: 'dig', phase: 2, x, y, z, face: 0 });
    h.predictBlock(x, y, z, B.AIR);
    // Predict blocks that lose their support (plants, torches, the other door half).
    const get = (a: number, b: number, c: number) => h.world.getRaw(a, b, c);
    const queue = [[x, y, z]];
    for (let guard = 0; queue.length > 0 && guard < 64; guard++) {
      const [qx, qy, qz] = queue.shift()!;
      for (const [dx, dy, dz] of NEIGHBOURS) {
        const raw = get(qx + dx, qy + dy, qz + dz);
        if (raw === 0 || isSupported(get, qx + dx, qy + dy, qz + dz, raw)) continue;
        h.predictBlock(qx + dx, qy + dy, qz + dz, B.AIR);
        queue.push([qx + dx, qy + dy, qz + dz]);
      }
    }
  }

  private stopDigging(): void {
    if (this.dig) {
      const d = this.dig;
      this.host.send({ t: 'dig', phase: 1, x: d.x, y: d.y, z: d.z, face: 0 });
      this.dig = null;
    }
  }

  private place(): void {
    const t = this.target;
    const h = this.host;
    if (!t) return;
    const stack = h.inventory.held;
    const block = stack ? itemDef(stack.id)?.block : undefined;
    if (block === undefined) return;
    this.placeCooldown = PLACE_REPEAT;
    // Clicking a replaceable block (tall grass…) places into it; otherwise next to the clicked face.
    const into = REPLACEABLE[t.id] === 1;
    const [x, y, z] = into ? [t.x, t.y, t.z] : [t.x + t.nx, t.y + t.ny, t.z + t.nz];
    const raw = placementRaw(block, into ? 0 : t.nx, into ? 1 : t.ny, into ? 0 : t.nz, this.controls.yaw, this.controls.pitch);
    if (raw === null || y < 0 || y > 255) return;
    const w = h.world;
    const current = w.getBlock(x, y, z);
    if (!REPLACEABLE[current] || current === block) return;
    const door = block === B.ASHWOOD_DOOR;
    if (door) {
      if (!OPAQUE[w.getBlock(x, y - 1, z)] || !REPLACEABLE[w.getBlock(x, y + 1, z)]) return;
    } else if (!isSupported((a, b, c) => w.getRaw(a, b, c), x, y, z, raw)) {
      return;
    }
    if (SOLID[block]) {
      const { min, max } = h.playerBox();
      if (boxOverlapsBlock(min, max, x, y, z) || (door && boxOverlapsBlock(min, max, x, y + 1, z))) return;
    }
    h.send({ t: 'place', x, y, z, raw, slot: h.inventory.selected });
    h.predictBlock(x, y, z, raw);
    if (door) h.predictBlock(x, y + 1, z, withState(block, (raw >>> 12) | DOOR_UPPER));
    if (!h.creative) h.inventory.take(h.inventory.selected, 1);
  }

  dispose(): void {
    this.outline.geometry.dispose();
    this.crack.geometry.dispose();
    this.crackMaterial.dispose();
    for (const t of this.crackTextures) t.dispose();
  }
}
