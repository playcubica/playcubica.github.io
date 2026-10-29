import * as THREE from 'three';
import { Anim, type EntityState } from '../../shared/protocol/messages';
import { hash3i } from '../../shared/rng';
import type { ClientWorld } from '../ClientWorld';

// Other players: a simple original block figure (head, body, arms, legs) with colours
// derived from the name, a floating name tag, and interpolated movement.

const PX = 1.8 / 32; // model pixels -> blocks (32 px tall = 1.8 blocks)
const INTERP_DELAY = 120; // ms behind the newest snapshot, for smooth motion

const SKIN = [[0.96, 0.8, 0.66], [0.85, 0.66, 0.5], [0.64, 0.45, 0.32], [0.45, 0.3, 0.22]];
const HAIR = [[0.15, 0.1, 0.06], [0.42, 0.26, 0.12], [0.85, 0.7, 0.35], [0.6, 0.18, 0.1], [0.1, 0.1, 0.12]];

function hsl(h: number, s: number, l: number): [number, number, number] {
  const c = new THREE.Color().setHSL(h, s, l);
  return [c.r, c.g, c.b];
}

/** A box with per-face shading baked into vertex colours (no scene lights needed). */
function shadedBox(w: number, h: number, d: number, top: number[], side: number[], bottom = side): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w * PX, h * PX, d * PX).toNonIndexed();
  const colors: number[] = [];
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z (6 vertices each when non-indexed).
  const shade = [0.8, 0.8, 1, 0.5, 0.9, 0.7];
  for (let f = 0; f < 6; f++) {
    const base = f === 2 ? top : f === 3 ? bottom : side;
    for (let v = 0; v < 6; v++) colors.push(base[0] * shade[f], base[1] * shade[f], base[2] * shade[f]);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return g;
}

export function nameTag(name: string): THREE.Sprite {
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  const font = 'bold 28px system-ui, sans-serif';
  g.font = font;
  const w = Math.ceil(g.measureText(name).width) + 20;
  c.width = w;
  c.height = 40;
  g.font = font;
  g.fillStyle = 'rgba(0,0,0,0.45)';
  g.fillRect(0, 0, w, 40);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.direction = 'rtl';
  g.fillText(name, w / 2, 21);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
  sprite.scale.set((w / 40) * 0.3, 0.3, 1);
  return sprite;
}

interface Remote {
  name: string;
  root: THREE.Group;
  body: THREE.Group;
  head: THREE.Mesh;
  armL: THREE.Group;
  armR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  tag: THREE.Sprite;
  material: THREE.MeshBasicMaterial;
  /** Snapshots (time, state), oldest first. */
  history: Array<{ at: number; s: EntityState }>;
  walk: number;
  swing: number;
  bodyYaw: number;
  lastX: number;
  lastZ: number;
}

export class PlayerModels {
  private readonly remotes = new Map<number, Remote>();

  constructor(private readonly scene: THREE.Scene, private readonly world: ClientWorld) {}

  get count(): number {
    return this.remotes.size;
  }

  add(id: number, name: string): void {
    if (this.remotes.has(id)) return;
    const h = hash3i(name.length, [...name].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) | 0, 3, 9);
    const skin = SKIN[h % SKIN.length];
    const hair = HAIR[(h >>> 4) % HAIR.length];
    const shirt = hsl(((h >>> 8) % 360) / 360, 0.55, 0.5);
    const pants = hsl(((h >>> 17) % 360) / 360, 0.35, 0.3);
    const material = new THREE.MeshBasicMaterial({ vertexColors: true });

    const part = (w: number, hgt: number, d: number, top: number[], side: number[], pivotY: number, y: number) => {
      const pivot = new THREE.Group();
      pivot.position.y = pivotY * PX;
      const m = new THREE.Mesh(shadedBox(w, hgt, d, top, side), material);
      m.position.y = y * PX;
      pivot.add(m);
      return pivot;
    };

    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const legL = part(4, 12, 4, pants, pants, 12, -6);
    const legR = part(4, 12, 4, pants, pants, 12, -6);
    legL.position.x = -2 * PX;
    legR.position.x = 2 * PX;
    const torso = new THREE.Mesh(shadedBox(8, 12, 4, shirt, shirt), material);
    torso.position.y = 18 * PX;
    const armL = part(4, 12, 4, shirt, skin, 23, -5);
    const armR = part(4, 12, 4, shirt, skin, 23, -5);
    armL.position.x = -6 * PX;
    armR.position.x = 6 * PX;
    const head = new THREE.Mesh(shadedBox(8, 8, 8, hair, skin), material);
    head.position.y = 28 * PX;
    // Face: two eyes and a fringe on the front (-z is "forward" for yaw 0).
    const eyes = new THREE.Mesh(shadedBox(6, 1, 0.2, [0.1, 0.1, 0.15], [0.1, 0.1, 0.15]), material);
    eyes.position.set(0, 0, -4.05 * PX);
    const gap = new THREE.Mesh(shadedBox(2, 1.1, 0.3, skin, skin), material);
    gap.position.set(0, 0, -4.06 * PX);
    const fringe = new THREE.Mesh(shadedBox(8, 2, 0.2, hair, hair), material);
    fringe.position.set(0, 3 * PX, -4.05 * PX);
    head.add(eyes, gap, fringe);
    body.add(legL, legR, torso, armL, armR, head);

    const tag = nameTag(name);
    tag.position.y = 2.15;
    root.add(tag);
    this.scene.add(root);
    this.remotes.set(id, {
      name, root, body, head, armL, armR, legL, legR, tag, material,
      history: [], walk: 0, swing: 0, bodyYaw: 0, lastX: 0, lastZ: 0,
    });
  }

  /** Where another player is drawn now (null if unknown or hidden). */
  position(id: number): THREE.Vector3 | null {
    const r = this.remotes.get(id);
    return r && r.root.visible ? r.root.position : null;
  }

  remove(id: number): void {
    const r = this.remotes.get(id);
    if (!r) return;
    this.scene.remove(r.root);
    r.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    r.material.dispose();
    r.tag.material.map?.dispose();
    r.tag.material.dispose();
    this.remotes.delete(id);
  }

  snapshot(states: EntityState[]): void {
    const now = performance.now();
    const seen = new Set<number>();
    for (const s of states) {
      const r = this.remotes.get(s.id);
      if (!r) continue;
      seen.add(s.id);
      if (r.history.length === 0) {
        r.root.position.set(s.x, s.y, s.z);
        r.lastX = s.x;
        r.lastZ = s.z;
        r.bodyYaw = s.yaw;
      }
      r.history.push({ at: now, s });
      if (r.history.length > 20) r.history.shift();
      r.root.visible = true;
    }
    // Players missing from the snapshot are dead (or not alive yet).
    for (const [id, r] of this.remotes) if (!seen.has(id)) r.root.visible = false;
  }

  update(dt: number, daylight: number): void {
    const renderAt = performance.now() - INTERP_DELAY;
    for (const r of this.remotes.values()) {
      const h = r.history;
      if (h.length === 0) {
        r.root.visible = false;
        continue;
      }
      // Interpolate between the two snapshots around renderAt.
      let a = h[0];
      let b = h[h.length - 1];
      for (let i = 0; i < h.length - 1; i++) {
        if (h[i].at <= renderAt && h[i + 1].at >= renderAt) {
          a = h[i];
          b = h[i + 1];
          break;
        }
      }
      const t = b.at === a.at ? 1 : Math.min(1, Math.max(0, (renderAt - a.at) / (b.at - a.at)));
      const s = b.s;
      const x = a.s.x + (b.s.x - a.s.x) * t;
      const y = a.s.y + (b.s.y - a.s.y) * t;
      const z = a.s.z + (b.s.z - a.s.z) * t;
      const sneak = (s.anim & Anim.SNEAK) !== 0;
      r.root.position.set(x, y, z);

      // Walk cycle from horizontal speed; body turns towards where the head looks.
      const speed = Math.hypot(x - r.lastX, z - r.lastZ) / Math.max(dt, 1e-3);
      r.lastX = x;
      r.lastZ = z;
      const moving = Math.min(1, speed / 4);
      r.walk += dt * speed * 2.2;
      const legSwing = Math.sin(r.walk) * 0.8 * moving;
      r.legL.rotation.x = legSwing;
      r.legR.rotation.x = -legSwing;
      r.armL.rotation.x = -legSwing * 0.8;
      r.armR.rotation.x = legSwing * 0.8;
      if (s.anim & Anim.SWING) r.swing = 1;
      r.swing = Math.max(0, r.swing - dt * 4);
      if (r.swing > 0) r.armR.rotation.x = -1.6 * Math.sin(r.swing * Math.PI);
      let diff = s.yaw - r.bodyYaw;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      if (Math.abs(diff) > 0.8 || moving > 0.2) r.bodyYaw += diff * Math.min(1, dt * 8);
      r.body.rotation.y = r.bodyYaw;
      r.head.rotation.set(a.s.pitch + (s.pitch - a.s.pitch) * t, s.yaw - r.bodyYaw, 0, 'YXZ');
      r.body.position.y = sneak ? -0.15 : 0;
      r.body.rotation.x = 0;
      r.tag.position.y = sneak ? 1.95 : 2.15;
      if (s.anim & Anim.RIDING) {
        // Astride a horse: seated on its back, legs forward and apart.
        r.body.position.y = 0.62;
        r.tag.position.y = 2.8;
        r.legL.rotation.set(-1.25, 0, -0.32);
        r.legR.rotation.set(-1.25, 0, 0.32);
        r.armL.rotation.x = -0.5;
        if (r.swing === 0) r.armR.rotation.x = -0.5;
      } else {
        r.legL.rotation.z = 0;
        r.legR.rotation.z = 0;
      }

      // Light the model like the world around it.
      const l = this.world.getLight(Math.floor(x), Math.floor(y + 1.2), Math.floor(z));
      const k = Math.max(0.12, Math.pow(0.8, 15 - (l >> 4)) * daylight, Math.pow(0.8, 15 - (l & 15)));
      r.material.color.setRGB(k, k, k);
    }
  }

  dispose(): void {
    for (const id of [...this.remotes.keys()]) this.remove(id);
  }
}
