import * as THREE from 'three';
import { BABY_SCALE, Mob, MobAnim, MobFlag, mobDef } from '../../shared/entities/mobs';
import type { EntityInfo, MobEventName } from '../../shared/protocol/messages';
import { hash01, mulberry32 } from '../../shared/rng';
import type { ClientWorld } from '../ClientWorld';
import { type AnimState, type Bone, type Box, type Detail, type Pose, type RGB, type Rig } from './mobModels';
import { CREATURES } from './monsterModels';
import { nameTag } from './PlayerModels';

// Creatures as articulated box models: every kind has its own rig and animator (mobModels.ts for
// animals, monsterModels.ts for monsters and traders).
// Every box gets a pixel-art skin painted from its colour, a pattern and pixel details, one texel per
// model pixel; the skins of a model share one canvas atlas, built once per kind/look and shared.

const PX = 1 / 16;
const THORN_GRAVITY = 6;

// --- Skins ---------------------------------------------------------------------------------

/** BoxGeometry face order: +x, -x, +y, -y, +z, -z. Texel size of each face (width, height). */
function faceSizes([w, h, d]: [number, number, number]): Array<[number, number]> {
  const t = (n: number) => Math.max(1, Math.round(n));
  return [[t(d), t(h)], [t(d), t(h)], [t(w), t(d)], [t(w), t(d)], [t(w), t(h)], [t(w), t(h)]];
}

/** Colour of one texel (row 0 = top of a side face). */
function texel(p: Box, face: number, x: number, y: number, w: number, h: number, seed: number, r: () => number): RGB {
  const side = face !== 2 && face !== 3;
  if (p.band && side && p.band.rows > 0 && y >= h - p.band.rows) return p.band.color.map((c) => c * (0.9 + r() * 0.12)) as RGB;
  const base = face === 2 && p.top ? p.top : p.color;
  let k = 0.93 + r() * 0.1;
  switch (p.pattern) {
    case 'plain':
      k = 1;
      break;
    case 'fur':
      k = 0.88 + r() * 0.2;
      if (r() < 0.1) k *= 0.85;
      break;
    case 'fleece':
      k = 0.9 + r() * 0.12;
      if ((x + (y >> 1) * 2) % 3 === 0 && y % 2 === 0) k = 1.07;
      if (r() < 0.14) k = 0.84;
      break;
    case 'shaggy':
      // Long hair: vertical streaks on the sides.
      k = side ? 0.86 + hash01(seed, x, 0, face) * 0.22 + r() * 0.06 : 0.9 + r() * 0.15;
      break;
    case 'cloth':
      k = 0.94 + r() * 0.08;
      if (y % 4 === 3) k *= 0.9;
      break;
    case 'rags':
      k = 0.9 + r() * 0.14;
      if (y % 5 === 4) k *= 0.82;
      if (r() < 0.1) k = 0.62;
      break;
    case 'ribs':
      k = side ? (x % 3 === 1 ? 1.12 : 0.9 + r() * 0.08) : 0.94 + r() * 0.1;
      break;
    case 'feather':
      k = (side ? (y + (x & 1)) % 3 === 0 : (x + y) % 3 === 0) ? 0.82 : 0.95 + r() * 0.1;
      break;
    case 'chitin':
      k = x % 4 === 0 || y % 4 === 0 ? 0.78 : 0.92 + r() * 0.15;
      break;
    case 'spots':
      if (p.spot && hash01(seed, x >> 1, y >> 1, face) < 0.16) return p.spot.map((c) => c * (0.95 + r() * 0.08)) as RGB;
      break;
    case 'patches':
      // Big irregular patches (a cow's hide, a calico cat).
      if (p.spot && hash01(seed, (x + (hash01(seed, y, 1, face) < 0.5 ? 1 : 0)) >> 2, y >> 2, face) < 0.36) return p.spot.map((c) => c * (0.94 + r() * 0.08)) as RGB;
      k = 0.94 + r() * 0.08;
      break;
    case 'stripes':
      // Tabby / barred stripes across the body.
      if (p.spot && (side ? x % 3 === 0 : y % 3 === 0)) return p.spot.map((c) => c * (0.92 + r() * 0.1)) as RGB;
      k = 0.92 + r() * 0.12;
      break;
  }
  // A slightly darker rim keeps the boxes crisp, like the block tiles.
  if (p.pattern !== 'plain' && w >= 4 && h >= 4 && (x === 0 || y === 0 || x === w - 1 || y === h - 1)) k *= 0.9;
  return base.map((c) => Math.min(1, c * k)) as RGB;
}

/** Pixel details of a box face, in that face's texel coordinates. */
function detailsFor(p: Box, face: number, w: number): Detail[] {
  if (face === 5) return p.face ?? [];
  if (!p.side) return [];
  // Side details are measured from the front: on +x the front is the right end, on -x the left.
  if (face === 0) return p.side.map(([x, y, dw, dh, col]) => [w - x - dw, y, dw, dh, col]);
  if (face === 1) return p.side;
  return [];
}

interface Kit {
  rig: Rig;
  /** Geometry per box, in rig order (depth-first over bones). */
  geometries: THREE.BufferGeometry[];
  texture: THREE.CanvasTexture;
  glow: THREE.MeshBasicMaterial;
}

const ATLAS_W = 128;

function rigBoxes(bones: Bone[], out: Box[] = []): Box[] {
  for (const b of bones) {
    out.push(...b.boxes);
    if (b.children) rigBoxes(b.children, out);
  }
  return out;
}

/** Geometries (with atlas UVs) and the atlas texture for a rig. */
function buildKit(rig: Rig, seed: number): Kit {
  const parts = rigBoxes(rig.bones);
  // Shelf-pack every face of every box.
  const rects: Array<Array<[number, number, number, number]>> = [];
  let x = 0;
  let y = 0;
  let row = 0;
  for (const p of parts) {
    rects.push(faceSizes(p.size).map(([w, h]) => {
      if (x + w > ATLAS_W) { x = 0; y += row; row = 0; }
      const r: [number, number, number, number] = [x, y, w, h];
      x += w;
      row = Math.max(row, h);
      return r;
    }));
  }
  const H = Math.max(1, y + row);
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(ATLAS_W, H);
  const put = (px: number, py: number, c: RGB) => {
    const o = (py * ATLAS_W + px) * 4;
    img.data[o] = c[0] * 255;
    img.data[o + 1] = c[1] * 255;
    img.data[o + 2] = c[2] * 255;
    img.data[o + 3] = 255;
  };
  parts.forEach((p, i) => {
    const r = mulberry32(seed * 131 + i);
    rects[i].forEach(([rx, ry, w, h], face) => {
      for (let ty = 0; ty < h; ty++) for (let tx = 0; tx < w; tx++) put(rx + tx, ry + ty, p.glow ? p.color : texel(p, face, tx, ty, w, h, seed + i, r));
      for (const [dx, dy, dw, dh, col] of detailsFor(p, face, w)) {
        for (let ty = Math.max(0, dy); ty < Math.min(h, dy + dh); ty++) for (let tx = Math.max(0, dx); tx < Math.min(w, dx + dw); tx++) put(rx + tx, ry + ty, col);
      }
    });
  });
  ctx.putImageData(img, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;

  const shade = [0.8, 0.8, 1, 0.55, 0.9, 0.7];
  const geometries = parts.map((p, i) => {
    const [w, h, d] = p.size;
    const g = new THREE.BoxGeometry(w * PX, h * PX, d * PX).toNonIndexed();
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    const colors: number[] = [];
    for (let f = 0; f < 6; f++) {
      const [rx, ry, rw, rh] = rects[i][f];
      const k = p.glow ? 1 : shade[f];
      for (let v = f * 6; v < f * 6 + 6; v++) {
        uv.setXY(v, (rx + uv.getX(v) * rw) / ATLAS_W, 1 - (ry + (1 - uv.getY(v)) * rh) / H);
        colors.push(k, k, k);
      }
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    return g;
  });
  return { rig, geometries, texture, glow: new THREE.MeshBasicMaterial({ map: texture, vertexColors: true }) };
}

interface MobView {
  kind: number;
  variant: number;
  flags: number;
  lookKey: string;
  root: THREE.Group;
  model: THREE.Group;
  pose: Pose;
  material: THREE.MeshBasicMaterial;
  x: number;
  y: number;
  z: number;
  yaw: number;
  tx: number;
  ty: number;
  tz: number;
  tyaw: number;
  anim: number;
  walk: number;
  vy: number;
  seed: number;
  hurt: number;
  dying: number;
  /** Seconds since its last ground slam. */
  slam: number;
  /** Jump straight to the next position (it blinked) instead of gliding there. */
  snap: boolean;
  /** Name-tag label and lead rope (drawn while someone holds it). */
  name: string | null;
  tag: THREE.Sprite | null;
  leash: number | null;
  rope: THREE.Line | null;
}

interface ThornView {
  mesh: THREE.Mesh;
  p0: THREE.Vector3;
  v: THREE.Vector3;
  t: number;
}

interface Puff {
  points: THREE.Points;
  t: number;
  life: number;
  rise: number;
  grow: number;
}

const PUFFS: Partial<Record<MobEventName, { color: number; count: number; size: number; rise: number; grow: number; life: number }>> = {
  love: { color: 0xff4060, count: 7, size: 0.16, rise: 0.8, grow: 0.4, life: 1.2 },
  tamed: { color: 0xff4060, count: 12, size: 0.18, rise: 0.9, grow: 0.8, life: 1.4 },
  baby: { color: 0xff6080, count: 9, size: 0.14, rise: 0.7, grow: 0.6, life: 1.2 },
  smoke: { color: 0x9a9a9a, count: 14, size: 0.2, rise: 0.6, grow: 1.2, life: 1.0 },
  spores: { color: 0x73e6b3, count: 160, size: 0.22, rise: 0, grow: 2.5, life: 1.4 },
  shear: { color: 0xf2f0e8, count: 10, size: 0.14, rise: -0.6, grow: 0.8, life: 0.8 },
  clang: { color: 0xe8e8f0, count: 8, size: 0.1, rise: 0.4, grow: 1.4, life: 0.4 },
  crit: { color: 0xffd040, count: 10, size: 0.14, rise: 0.6, grow: 1.2, life: 0.6 },
  blink: { color: 0x3a2a5a, count: 26, size: 0.2, rise: 0.4, grow: 1.4, life: 0.9 },
  slam: { color: 0x7a6a50, count: 70, size: 0.3, rise: 0.3, grow: 4, life: 1.0 },
  stun: { color: 0xfff080, count: 10, size: 0.18, rise: 0.8, grow: 1, life: 1.4 },
  roar: { color: 0xff8030, count: 40, size: 0.2, rise: 1.2, grow: 2.5, life: 1.2 },
  ink: { color: 0x101018, count: 50, size: 0.3, rise: 0.1, grow: 2.2, life: 1.6 },
};

const ROPE_POINTS = 12;

/** Renders creatures, thorns and particles; also answers "which creature is the crosshair on". */
export class MobRenderer {
  private readonly mobs = new Map<number, MobView>();
  private readonly thorns = new Map<number, ThornView>();
  private readonly puffs: Puff[] = [];
  private readonly thornMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.85, 0.82, 0.45) });
  private readonly thornGeometry = new THREE.BoxGeometry(1 * PX, 1 * PX, 6 * PX);
  private readonly emberMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.55, 0.15) });
  private readonly emberGeometry = new THREE.BoxGeometry(4 * PX, 4 * PX, 4 * PX);
  /** Skins and geometries per kind/look, shared by every creature that looks the same. */
  private readonly kits = new Map<string, Kit>();
  private readonly ray = new THREE.Ray();
  private readonly hitBox = new THREE.Box3();
  private readonly hitPoint = new THREE.Vector3();
  /** Where a player is (to draw the lead they hold). */
  holderAt: ((playerId: number) => { x: number; y: number; z: number } | null) | null = null;
  private readonly ropeMaterial = new THREE.LineBasicMaterial({ color: 0x8a6a40 });
  /** Gallery: fixed speed / vertical speed per creature instead of measured motion. */
  readonly motion = new Map<number, { speed: number; vy: number }>();
  /** The creature this client rides: drawn where the local player is (no network lag). */
  private ridden: { id: number; at: () => { x: number; y: number; z: number; yaw: number } } | null = null;

  constructor(private readonly scene: THREE.Scene, private readonly world: ClientWorld) {}

  get count(): number {
    return this.mobs.size;
  }

  private lookKey(kind: number, variant: number, flags: number): string {
    return `${kind}:${variant}:${flags & (CREATURES[kind]?.lookFlags ?? 0)}`;
  }

  private kit(kind: number, variant: number, flags: number): Kit | null {
    const key = this.lookKey(kind, variant, flags);
    let kit = this.kits.get(key);
    if (!kit) {
      const species = CREATURES[kind];
      if (!species) return null;
      const rig: Rig = species.build({ variant, flags });
      kit = buildKit(rig, kind * 7 + variant);
      this.kits.set(key, kit);
    }
    return kit;
  }

  /** (Re)builds a creature's model from its kit. */
  private dress(view: MobView): void {
    const kit = this.kit(view.kind, view.variant, view.flags);
    view.model.clear();
    view.pose = new Map();
    view.lookKey = this.lookKey(view.kind, view.variant, view.flags);
    if (!kit) return;
    let i = 0;
    const add = (b: Bone, parent: THREE.Object3D, parentPivot: [number, number, number]) => {
      const g = new THREE.Group();
      g.position.set((b.pivot[0] - parentPivot[0]) * PX, (b.pivot[1] - parentPivot[1]) * PX, (b.pivot[2] - parentPivot[2]) * PX);
      const rest: [number, number, number] = b.rot ?? [0, 0, 0];
      g.rotation.set(rest[0], rest[1], rest[2]);
      for (const bx of b.boxes) {
        const mesh = new THREE.Mesh(kit.geometries[i++], bx.glow ? kit.glow : view.material);
        mesh.position.set((bx.at[0] - b.pivot[0]) * PX, (bx.at[1] - b.pivot[1]) * PX, (bx.at[2] - b.pivot[2]) * PX);
        g.add(mesh);
      }
      parent.add(g);
      view.pose.set(b.name, { obj: g, rest, base: [g.position.x, g.position.y, g.position.z] });
      for (const ch of b.children ?? []) add(ch, g, b.pivot);
    };
    for (const b of kit.rig.bones) add(b, view.model, [0, 0, 0]);
    view.model.scale.setScalar(kit.rig.scale);
    view.material.map = kit.texture;
  }

  spawn(e: EntityInfo): void {
    if (e.kind === 'projectile') {
      this.remove(e.id);
      const mesh = e.style === 1 ? new THREE.Mesh(this.emberGeometry, this.emberMaterial) : new THREE.Mesh(this.thornGeometry, this.thornMaterial);
      this.scene.add(mesh);
      this.thorns.set(e.id, { mesh, p0: new THREE.Vector3(e.x, e.y, e.z), v: new THREE.Vector3(e.vx, e.vy, e.vz), t: 0 });
      return;
    }
    if (e.kind !== 'mob') return;
    this.remove(e.id);
    if (!CREATURES[e.mob]) return;
    const root = new THREE.Group();
    const model = new THREE.Group();
    root.add(model);
    const ghost = e.mob === Mob.SHADE;
    const view: MobView = {
      kind: e.mob, variant: e.variant ?? 0, flags: e.flags ?? 0, lookKey: '', root, model, pose: new Map(),
      material: new THREE.MeshBasicMaterial({ vertexColors: true, transparent: ghost, depthWrite: !ghost }),
      x: e.x, y: e.y, z: e.z, yaw: e.yaw, tx: e.x, ty: e.y, tz: e.z, tyaw: e.yaw, anim: 0, walk: Math.random() * 6, vy: 0,
      seed: Math.random(), hurt: 0, dying: 0, slam: Infinity, snap: false, name: null, tag: null, leash: e.leash ?? null, rope: null,
    };
    this.dress(view);
    this.setName(view, e.name ?? null);
    root.position.set(e.x, e.y, e.z);
    this.scene.add(root);
    this.mobs.set(e.id, view);
  }

  /** Flags / look changed (sheared, tamed, grown up, saddled, sitting…). */
  state(e: EntityInfo): void {
    if (e.kind !== 'mob') return;
    const m = this.mobs.get(e.id);
    if (!m) return;
    m.variant = e.variant ?? 0;
    m.flags = e.flags ?? 0;
    m.leash = e.leash ?? null;
    if (this.lookKey(m.kind, m.variant, m.flags) !== m.lookKey) this.dress(m);
    this.setName(m, e.name ?? null);
  }

  /** Shows a name-tag label above the creature (sized for babies). */
  private setName(m: MobView, name: string | null): void {
    if (name === m.name) return;
    m.name = name;
    if (m.tag) {
      m.root.remove(m.tag);
      m.tag.material.map?.dispose();
      m.tag.material.dispose();
      m.tag = null;
    }
    if (!name) return;
    const def = mobDef(m.kind)!;
    m.tag = nameTag(name);
    m.tag.position.y = def.height * (m.flags & MobFlag.BABY ? BABY_SCALE : 1) + 0.35;
    m.root.add(m.tag);
  }

  move(data: number[]): void {
    for (let i = 0; i < data.length; i += 6) {
      const m = this.mobs.get(data[i]);
      if (!m) continue;
      m.tx = data[i + 1];
      m.ty = data[i + 2];
      m.tz = data[i + 3];
      m.tyaw = data[i + 4];
      m.anim = data[i + 5];
      if (m.snap) {
        m.x = m.tx;
        m.y = m.ty;
        m.z = m.tz;
        m.yaw = m.tyaw;
        m.snap = false;
      }
    }
  }

  setRidden(id: number | null, at?: () => { x: number; y: number; z: number; yaw: number }): void {
    this.ridden = id !== null && at ? { id, at } : null;
  }

  event(id: number, event: MobEventName): void {
    const m = this.mobs.get(id);
    if (!m) return;
    if (event === 'hurt') m.hurt = 0.35;
    else if (event === 'death') m.dying = 0.001;
    else if (event === 'slam') m.slam = 0;
    else if (event === 'blink') m.snap = true;
    const puff = PUFFS[event];
    if (puff) this.puff(m.x, m.y + (event === 'spores' ? 0.8 : 1), m.z, puff);
  }

  private puff(x: number, y: number, z: number, o: NonNullable<(typeof PUFFS)[MobEventName]>): void {
    const pos: number[] = [];
    for (let i = 0; i < o.count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * (o.count > 50 ? 1.2 : 0.45);
      pos.push(Math.cos(a) * r, (Math.random() - 0.3) * (o.count > 50 ? 1.2 : 0.5), Math.sin(a) * r);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const points = new THREE.Points(g, new THREE.PointsMaterial({ color: o.color, size: o.size, transparent: true, depthWrite: false }));
    points.position.set(x, y, z);
    this.scene.add(points);
    this.puffs.push({ points, t: 0, life: o.life, rise: o.rise, grow: o.grow });
  }

  remove(id: number): void {
    const m = this.mobs.get(id);
    if (m) {
      this.scene.remove(m.root);
      m.material.dispose();
      this.setName(m, null);
      if (m.rope) {
        this.scene.remove(m.rope);
        m.rope.geometry.dispose();
      }
      this.mobs.delete(id);
    }
    const t = this.thorns.get(id);
    if (t) {
      this.scene.remove(t.mesh);
      this.thorns.delete(id);
    }
  }

  removeInChunk(cx: number, cz: number): void {
    for (const [id, m] of this.mobs) {
      if (this.ridden?.id === id) continue;
      if (Math.floor(m.x) >> 4 === cx && Math.floor(m.z) >> 4 === cz) this.remove(id);
    }
  }

  position(id: number): { x: number; y: number; z: number } | null {
    const m = this.mobs.get(id);
    return m ? { x: m.x, y: m.y, z: m.z } : null;
  }

  kindOf(id: number): number | null {
    return this.mobs.get(id)?.kind ?? null;
  }

  isHostile(id: number): boolean {
    const m = this.mobs.get(id);
    return !!m && !!mobDef(m.kind)?.hostile;
  }

  /** A random living creature within r (for ambient sounds). */
  randomNear(x: number, y: number, z: number, r: number): { x: number; y: number; z: number; hostile: boolean; kind: number } | null {
    const list = [...this.mobs.values()].filter((m) => m.dying === 0 && Math.hypot(m.x - x, m.y - y, m.z - z) < r && !(m.anim & MobAnim.SLEEP));
    if (list.length === 0) return null;
    const m = list[Math.floor(Math.random() * list.length)];
    return { x: m.x, y: m.y, z: m.z, hostile: !!mobDef(m.kind)?.hostile, kind: m.kind };
  }

  /** Nearest living creature hit by the ray within maxDist (the one being ridden is skipped). */
  pick(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): { id: number; distance: number } | null {
    this.ray.set(origin, dir);
    let best: { id: number; distance: number } | null = null;
    for (const [id, m] of this.mobs) {
      if (m.dying > 0 || this.ridden?.id === id) continue;
      const def = mobDef(m.kind)!;
      const s = m.flags & MobFlag.BABY ? BABY_SCALE : 1;
      const h = (def.width * s) / 2;
      this.hitBox.min.set(m.x - h, m.y, m.z - h);
      this.hitBox.max.set(m.x + h, m.y + def.height * s, m.z + h);
      if (!this.ray.intersectBox(this.hitBox, this.hitPoint)) continue;
      const d = this.hitPoint.distanceTo(origin);
      if (d <= maxDist && (!best || d < best.distance)) best = { id, distance: d };
    }
    return best;
  }

  /** `viewer`: the camera position (shades fade with distance from it). */
  update(dt: number, daylight: number, viewer?: { x: number; y: number; z: number }): void {
    const k = Math.min(1, dt * 10);
    const now = performance.now() / 1000;
    for (const [id, m] of this.mobs) {
      const px = m.x;
      const py = m.y;
      const pz = m.z;
      if (this.ridden?.id === id) {
        const at = this.ridden.at();
        m.x = at.x;
        m.y = at.y;
        m.z = at.z;
        m.yaw = at.yaw;
      } else {
        m.x += (m.tx - m.x) * k;
        m.y += (m.ty - m.y) * k;
        m.z += (m.tz - m.z) * k;
        let dy = m.tyaw - m.yaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        m.yaw += dy * k;
      }
      m.root.position.set(m.x, m.y, m.z);
      m.root.rotation.y = m.yaw;

      const forced = this.motion.get(id);
      const speed = forced ? forced.speed : Math.hypot(m.x - px, m.z - pz) / Math.max(dt, 1e-3);
      m.vy += ((m.y - py) / Math.max(dt, 1e-3) - m.vy) * Math.min(1, dt * 12);
      if (forced) m.vy = forced.vy;
      const babyStep = m.flags & MobFlag.BABY ? 1.5 : 1;
      m.walk += dt * Math.min(speed, 10) * 3 * babyStep;
      m.slam += dt;
      const s: AnimState = { t: now, dt, walk: m.walk, speed, vy: m.vy, anim: m.anim, flags: m.flags, seed: m.seed, slam: m.slam };
      CREATURES[m.kind]?.animate(m.pose, s);
      if (m.kind === Mob.SHADE) {
        // Nearly invisible from afar, clearer up close, flickering.
        const d = viewer ? Math.hypot(viewer.x - m.x, viewer.y - m.y - 1, viewer.z - m.z) : 8;
        m.material.opacity = Math.min(0.9, Math.max(0.08, 1.1 - d / 7)) * (0.85 + Math.sin(now * 13 + m.seed * 40) * 0.15);
      }

      this.updateRope(m);
      if (m.dying > 0) {
        m.dying += dt;
        m.model.rotation.z = Math.min(Math.PI / 2, m.dying * 5);
        if (m.dying > 1.2) this.remove(id);
      }
      m.hurt = Math.max(0, m.hurt - dt);
      const l = this.world.getLight(Math.floor(m.x), Math.floor(m.y + 0.5), Math.floor(m.z));
      const b = Math.max(0.1, Math.pow(0.8, 15 - (l >> 4)) * daylight, Math.pow(0.8, 15 - (l & 15)));
      const fuse = (m.anim & MobAnim.FUSE) !== 0;
      if (m.hurt > 0 || m.dying > 0) m.material.color.setRGB(Math.min(1, b * 1.6), b * 0.35, b * 0.35);
      else if (fuse && Math.floor(performance.now() / 150) % 2 === 0) m.material.color.setRGB(Math.min(1, b * 1.5), Math.min(1, b * 1.5), Math.min(1, b * 1.5));
      else m.material.color.setRGB(b, b, b);
    }

    for (const [id, t] of this.thorns) {
      t.t += dt;
      const x = t.p0.x + t.v.x * t.t;
      const y = t.p0.y + t.v.y * t.t - 0.5 * THORN_GRAVITY * t.t * t.t;
      const z = t.p0.z + t.v.z * t.t;
      t.mesh.position.set(x, y, z);
      t.mesh.lookAt(x + t.v.x, y + t.v.y - THORN_GRAVITY * t.t, z + t.v.z);
      if (t.t > 3) this.remove(id);
    }

    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const c = this.puffs[i];
      c.t += dt;
      c.points.scale.setScalar(1 + c.t * c.grow);
      c.points.position.y += c.rise * dt;
      (c.points.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - c.t / c.life);
      if (c.t > c.life) {
        this.scene.remove(c.points);
        c.points.geometry.dispose();
        (c.points.material as THREE.Material).dispose();
        this.puffs.splice(i, 1);
      }
    }
  }

  /** A lead hangs from the holder's hand to the creature's neck, sagging when slack. */
  private updateRope(m: MobView): void {
    const holder = m.leash !== null ? this.holderAt?.(m.leash) : null;
    if (!holder) {
      if (m.rope) m.rope.visible = false;
      return;
    }
    if (!m.rope) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(ROPE_POINTS * 3), 3));
      m.rope = new THREE.Line(g, this.ropeMaterial);
      m.rope.frustumCulled = false;
      this.scene.add(m.rope);
    }
    m.rope.visible = true;
    const def = mobDef(m.kind)!;
    const s = m.flags & MobFlag.BABY ? BABY_SCALE : 1;
    const ax = holder.x;
    const ay = holder.y + 1.05;
    const az = holder.z;
    const bx = m.x;
    const by = m.y + def.height * s * 0.75;
    const bz = m.z;
    const sag = Math.max(0, 1 - Math.hypot(bx - ax, bz - az) / 4.5) * 0.6 + 0.1;
    const pos = m.rope.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < ROPE_POINTS; i++) {
      const t = i / (ROPE_POINTS - 1);
      pos.setXYZ(i, ax + (bx - ax) * t, ay + (by - ay) * t - Math.sin(t * Math.PI) * sag, az + (bz - az) * t);
    }
    pos.needsUpdate = true;
  }

  dispose(): void {
    for (const id of [...this.mobs.keys(), ...this.thorns.keys()]) this.remove(id);
    this.ropeMaterial.dispose();
    for (const kit of this.kits.values()) {
      kit.geometries.forEach((g) => g.dispose());
      kit.texture.dispose();
      kit.glow.dispose();
    }
    this.kits.clear();
    this.thornMaterial.dispose();
    this.thornGeometry.dispose();
    this.emberMaterial.dispose();
    this.emberGeometry.dispose();
  }
}

