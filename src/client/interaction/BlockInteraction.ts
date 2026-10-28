import * as THREE from 'three';
import { B, OPAQUE, RENDER, REPLACEABLE, SOLID } from '../../shared/blocks/registry';
import type { Inventory } from '../../shared/items/Inventory';
import { breakTime, CREATIVE_BREAK_DELAY, REACH } from '../../shared/items/mining';
import { itemDef } from '../../shared/items/registry';
import { boxOverlapsBlock } from '../../shared/physics/collision';
import { raycast, type RayHit } from '../../shared/physics/raycast';
import { mulberry32 } from '../../shared/rng';
import type { ClientMsg } from '../../shared/protocol/messages';
import type { ClientWorld } from '../ClientWorld';
import { MouseButton, type Controls } from '../input/Controls';

export interface InteractionHost {
  readonly world: ClientWorld;
  readonly inventory: Inventory;
  readonly creative: boolean;
  send(msg: ClientMsg): void;
  /** Applies a block change locally before the host confirms it. */
  predictBlock(x: number, y: number, z: number, id: number): void;
  playerBox(): { min: number[]; max: number[] };
  /** Creative "pick block": put this block in the hotbar. */
  pickBlock(id: number): void;
}

const PLACE_REPEAT = 0.22;
const SURVIVAL_BREAK_DELAY = 0.25;
const CRACK_STAGES = 10;

const targetable = (id: number) => RENDER[id] === 1 || RENDER[id] === 2;
const needsSupport = (id: number) => RENDER[id] === 2 || id === B.CACTUS;

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

/** Targeting, mining (with progress and cracks), placing and picking blocks. */
export class BlockInteraction {
  target: RayHit | null = null;
  private dig: { x: number; y: number; z: number; progress: number; need: number } | null = null;
  private breakCooldown = 0;
  private placeCooldown = 0;
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
    const t = this.target;
    this.outline.visible = !!t;
    if (t) this.outline.position.set(t.x + 0.5, t.y + 0.5, t.z + 0.5);

    this.breakCooldown = Math.max(0, this.breakCooldown - dt);
    this.placeCooldown = Math.max(0, this.placeCooldown - dt);

    if (this.controls.isButtonDown(MouseButton.LEFT) && t) this.mine(dt, t);
    else this.stopDigging();

    if (this.controls.isButtonDown(MouseButton.RIGHT) && this.placeCooldown === 0) this.place();

    const d = this.dig;
    this.crack.visible = !!d && d.progress > 0;
    if (d && d.progress > 0) {
      this.crack.position.set(d.x + 0.5, d.y + 0.5, d.z + 0.5);
      this.crackMaterial.map = this.crackTextures[Math.min(CRACK_STAGES - 1, Math.floor(d.progress * CRACK_STAGES))];
      this.crackMaterial.needsUpdate = true;
    }
  }

  private mouseDown(button: number): void {
    if (button === MouseButton.RIGHT) {
      this.placeCooldown = 0;
      this.place();
    } else if (button === MouseButton.LEFT) {
      this.breakCooldown = 0;
    } else if (button === MouseButton.MIDDLE && this.target && this.host.creative) {
      this.host.pickBlock(this.target.id);
    }
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
      const need = breakTime(t.id, held ? itemDef(held.id) : undefined, false);
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
    if (needsSupport(h.world.getBlock(x, y + 1, z))) h.predictBlock(x, y + 1, z, B.AIR);
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
    const [x, y, z] = REPLACEABLE[t.id] ? [t.x, t.y, t.z] : [t.x + t.nx, t.y + t.ny, t.z + t.nz];
    const current = h.world.getBlock(x, y, z);
    if (!REPLACEABLE[current] || current === block || y < 0 || y > 255) return;
    if (needsSupport(block) && !OPAQUE[h.world.getBlock(x, y - 1, z)]) return;
    if (SOLID[block]) {
      const { min, max } = h.playerBox();
      if (boxOverlapsBlock(min, max, x, y, z)) return;
    }
    h.send({ t: 'place', x, y, z, face: 0, slot: h.inventory.selected });
    h.predictBlock(x, y, z, block);
    if (!h.creative) h.inventory.take(h.inventory.selected, 1);
  }

  dispose(): void {
    this.outline.geometry.dispose();
    this.crack.geometry.dispose();
    this.crackMaterial.dispose();
    for (const t of this.crackTextures) t.dispose();
  }
}
