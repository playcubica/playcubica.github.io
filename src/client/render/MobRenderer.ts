import * as THREE from 'three';
import { Mob, mobDef } from '../../shared/entities/mobs';
import type { EntityInfo } from '../../shared/protocol/messages';
import type { ClientWorld } from '../ClientWorld';

// Creatures as block models built from coloured boxes (sizes in 1/16 block "pixels",
// positions are box centres, y measured up from the feet, front faces -z).

type RGB = [number, number, number];
type Role = 'legA' | 'legB' | 'arm' | 'cap';

interface Part {
  size: [number, number, number];
  at: [number, number, number];
  color: RGB;
  top?: RGB;
  role?: Role;
  /** Self-lit (eyes, glowing spots). */
  glow?: boolean;
}

const PX = 1 / 16;
const THORN_GRAVITY = 6;

const legs = (w: number, h: number, x: number, z: number, color: RGB): Part[] => [
  { size: [w, h, w], at: [-x, h / 2, -z], color, role: 'legA' },
  { size: [w, h, w], at: [x, h / 2, z], color, role: 'legA' },
  { size: [w, h, w], at: [x, h / 2, -z], color, role: 'legB' },
  { size: [w, h, w], at: [-x, h / 2, z], color, role: 'legB' },
];
const eyes = (x: number, y: number, z: number, color: RGB = [0.05, 0.05, 0.05], glow = false, w = 1, h = 1): Part[] => [
  { size: [w, h, 0.3], at: [-x, y, z], color, glow },
  { size: [w, h, 0.3], at: [x, y, z], color, glow },
];

const MODELS: Record<number, Part[]> = {
  [Mob.GRAZER]: [
    { size: [12, 10, 16], at: [0, 11, 0], color: [0.92, 0.89, 0.8] },
    { size: [6, 6, 6], at: [0, 14, -10], color: [0.36, 0.26, 0.2], top: [0.92, 0.89, 0.8] },
    { size: [2, 3, 2], at: [-3.5, 18, -10], color: [0.74, 0.68, 0.56] },
    { size: [2, 3, 2], at: [3.5, 18, -10], color: [0.74, 0.68, 0.56] },
    ...eyes(1.6, 15, -13.1),
    ...legs(3, 6, 4, 5, [0.36, 0.26, 0.2]),
  ],
  [Mob.TUSKLING]: [
    { size: [10, 8, 13], at: [0, 8, 0], color: [0.48, 0.42, 0.28] },
    { size: [2, 2, 11], at: [0, 13, 0], color: [0.28, 0.22, 0.16] },
    { size: [8, 7, 6], at: [0, 9, -9], color: [0.44, 0.38, 0.25] },
    { size: [4, 3, 2], at: [0, 7, -12.5], color: [0.62, 0.48, 0.38] },
    { size: [1, 3, 1], at: [-2.5, 8, -13], color: [0.95, 0.92, 0.82] },
    { size: [1, 3, 1], at: [2.5, 8, -13], color: [0.95, 0.92, 0.82] },
    ...eyes(2, 10.5, -12.1),
    ...legs(3, 4, 3.5, 4, [0.3, 0.25, 0.18]),
  ],
  [Mob.STILTFOWL]: [
    { size: [1, 10, 1], at: [-1.5, 5, 0], color: [0.9, 0.55, 0.2], role: 'legA' },
    { size: [1, 10, 1], at: [1.5, 5, 0], color: [0.9, 0.55, 0.2], role: 'legB' },
    { size: [6, 6, 9], at: [0, 13, 1], color: [0.42, 0.5, 0.64] },
    { size: [4, 4, 2], at: [0, 15, 6], color: [0.3, 0.36, 0.5] },
    { size: [2, 5, 2], at: [0, 18, -3], color: [0.42, 0.5, 0.64] },
    { size: [3, 3, 4], at: [0, 21, -4], color: [0.45, 0.54, 0.68] },
    { size: [1, 1, 3], at: [0, 20.5, -7], color: [0.95, 0.8, 0.25] },
    { size: [1, 3, 2], at: [0, 23.5, -3.5], color: [0.2, 0.75, 0.7] },
    ...eyes(1.55, 21.5, -5),
  ],
  [Mob.HORNOX]: [
    { size: [14, 12, 20], at: [0, 14, 1], color: [0.45, 0.25, 0.18] },
    { size: [12, 4, 8], at: [0, 21, -3], color: [0.38, 0.2, 0.14] },
    { size: [8, 8, 7], at: [0, 15, -12], color: [0.36, 0.2, 0.14] },
    { size: [6, 4, 2], at: [0, 13, -16], color: [0.68, 0.55, 0.42] },
    { size: [5, 2, 2], at: [-6, 19, -12], color: [0.88, 0.84, 0.72] },
    { size: [5, 2, 2], at: [6, 19, -12], color: [0.88, 0.84, 0.72] },
    { size: [2, 4, 2], at: [-8, 21, -12], color: [0.88, 0.84, 0.72] },
    { size: [2, 4, 2], at: [8, 21, -12], color: [0.88, 0.84, 0.72] },
    ...eyes(2.5, 16, -15.6),
    ...legs(4, 8, 5, 6, [0.3, 0.17, 0.12]),
  ],
  [Mob.GLOOMWALKER]: [
    { size: [4, 12, 4], at: [-2, 6, 0], color: [0.22, 0.19, 0.27], role: 'legA' },
    { size: [4, 12, 4], at: [2, 6, 0], color: [0.22, 0.19, 0.27], role: 'legB' },
    { size: [8, 12, 4], at: [0, 18, 0], color: [0.3, 0.26, 0.36] },
    { size: [3, 15, 3], at: [-5.5, 17, 0], color: [0.27, 0.23, 0.32], role: 'arm' },
    { size: [3, 15, 3], at: [5.5, 17, 0], color: [0.27, 0.23, 0.32], role: 'arm' },
    { size: [8, 8, 8], at: [0, 28, 0], color: [0.26, 0.22, 0.3], top: [0.16, 0.13, 0.2] },
    ...eyes(2, 29, -4.1, [1, 0.85, 0.3], true, 2, 1),
  ],
  [Mob.THORNSLINGER]: [
    { size: [12, 12, 12], at: [0, 9, 0], color: [0.3, 0.55, 0.25] },
    { size: [10, 2, 10], at: [0, 16, 0], color: [0.2, 0.42, 0.18] },
    { size: [6, 3, 0.4], at: [0, 9, -6.1], color: [0.45, 0.08, 0.1] },
    ...eyes(2.5, 12.5, -6.1, [0.95, 0.9, 0.3], true),
    { size: [1, 1, 3], at: [-6.5, 11, 0], color: [0.92, 0.88, 0.6] },
    { size: [1, 1, 3], at: [6.5, 7, 2], color: [0.92, 0.88, 0.6] },
    { size: [3, 1, 1], at: [-3, 15.5, 5], color: [0.92, 0.88, 0.6] },
    { size: [1, 3, 1], at: [3, 6, 6.5], color: [0.92, 0.88, 0.6] },
    ...legs(2, 3, 3, 3, [0.42, 0.3, 0.18]),
  ],
  [Mob.SKITTERLING]: [
    { size: [10, 5, 12], at: [0, 6, 1], color: [0.14, 0.3, 0.3] },
    { size: [6, 4, 5], at: [0, 6, -7.5], color: [0.12, 0.25, 0.26] },
    ...eyes(1.2, 7, -10.1, [1, 0.2, 0.2], true),
    ...eyes(2.6, 6.2, -10.1, [1, 0.2, 0.2], true),
    ...[-4, -1.5, 1.5, 4].flatMap((z, i): Part[] => [
      { size: [8, 1, 1], at: [-8, 4, z], color: [0.1, 0.2, 0.2], role: i % 2 ? 'legA' : 'legB' },
      { size: [8, 1, 1], at: [8, 4, z], color: [0.1, 0.2, 0.2], role: i % 2 ? 'legB' : 'legA' },
    ]),
  ],
  [Mob.SPORECAP]: [
    { size: [2, 2, 3], at: [-2, 1, 0], color: [0.75, 0.7, 0.58], role: 'legA' },
    { size: [2, 2, 3], at: [2, 1, 0], color: [0.75, 0.7, 0.58], role: 'legB' },
    { size: [6, 10, 6], at: [0, 6, 0], color: [0.86, 0.8, 0.68] },
    ...eyes(1.5, 8, -3.1, [0.05, 0.05, 0.05], false, 1, 2),
    { size: [14, 5, 14], at: [0, 13.5, 0], color: [0.45, 0.22, 0.56], role: 'cap' },
    { size: [10, 2, 10], at: [0, 17, 0], color: [0.5, 0.26, 0.6], role: 'cap' },
    { size: [2, 0.6, 2], at: [-3, 18.2, -2], color: [0.4, 1, 0.9], glow: true, role: 'cap' },
    { size: [2, 0.6, 2], at: [3, 18.2, 2], color: [0.4, 1, 0.9], glow: true, role: 'cap' },
    { size: [0.6, 2, 2], at: [-7.2, 14, 3], color: [0.4, 1, 0.9], glow: true, role: 'cap' },
    { size: [0.6, 2, 2], at: [7.2, 14, -3], color: [0.4, 1, 0.9], glow: true, role: 'cap' },
  ],
};

function box(p: Part): THREE.BufferGeometry {
  const [w, h, d] = p.size;
  const g = new THREE.BoxGeometry(w * PX, h * PX, d * PX).toNonIndexed();
  const shade = [0.8, 0.8, 1, 0.55, 0.9, 0.7];
  const colors: number[] = [];
  for (let f = 0; f < 6; f++) {
    const c = f === 2 && p.top ? p.top : p.color;
    const k = p.glow ? 1 : shade[f];
    for (let v = 0; v < 6; v++) colors.push(c[0] * k, c[1] * k, c[2] * k);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return g;
}

interface MobView {
  kind: number;
  root: THREE.Group;
  model: THREE.Group;
  parts: Array<{ obj: THREE.Object3D; role?: Role }>;
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
  hurt: number;
  dying: number;
}

interface ThornView {
  mesh: THREE.Mesh;
  p0: THREE.Vector3;
  v: THREE.Vector3;
  t: number;
}

/** Renders creatures, thorns and spore clouds; also answers "which creature is the crosshair on". */
export class MobRenderer {
  private readonly mobs = new Map<number, MobView>();
  private readonly thorns = new Map<number, ThornView>();
  private readonly clouds: Array<{ points: THREE.Points; t: number }> = [];
  private readonly glowMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });
  private readonly thornMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.85, 0.82, 0.45) });
  private readonly thornGeometry = new THREE.BoxGeometry(1 * PX, 1 * PX, 6 * PX);
  private readonly ray = new THREE.Ray();
  private readonly hitBox = new THREE.Box3();
  private readonly hitPoint = new THREE.Vector3();

  constructor(private readonly scene: THREE.Scene, private readonly world: ClientWorld) {}

  get count(): number {
    return this.mobs.size;
  }

  spawn(e: EntityInfo): void {
    if (e.kind === 'projectile') {
      this.remove(e.id);
      const mesh = new THREE.Mesh(this.thornGeometry, this.thornMaterial);
      this.scene.add(mesh);
      this.thorns.set(e.id, { mesh, p0: new THREE.Vector3(e.x, e.y, e.z), v: new THREE.Vector3(e.vx, e.vy, e.vz), t: 0 });
      return;
    }
    if (e.kind !== 'mob') return;
    this.remove(e.id);
    const parts = MODELS[e.mob];
    if (!parts) return;
    const material = new THREE.MeshBasicMaterial({ vertexColors: true });
    const root = new THREE.Group();
    const model = new THREE.Group();
    root.add(model);
    const view: MobView = {
      kind: e.mob, root, model, parts: [], material, x: e.x, y: e.y, z: e.z, yaw: e.yaw,
      tx: e.x, ty: e.y, tz: e.z, tyaw: e.yaw, anim: 0, walk: Math.random() * 6, hurt: 0, dying: 0,
    };
    for (const p of parts) {
      const mesh = new THREE.Mesh(box(p), p.glow ? this.glowMaterial : material);
      if (p.role === 'legA' || p.role === 'legB' || p.role === 'arm') {
        // Swing from the top of the limb.
        const pivot = new THREE.Group();
        pivot.position.set(p.at[0] * PX, (p.at[1] + p.size[1] / 2) * PX, p.at[2] * PX);
        mesh.position.y = (-p.size[1] / 2) * PX;
        pivot.add(mesh);
        model.add(pivot);
        view.parts.push({ obj: pivot, role: p.role });
      } else {
        mesh.position.set(p.at[0] * PX, p.at[1] * PX, p.at[2] * PX);
        model.add(mesh);
        view.parts.push({ obj: mesh, role: p.role });
      }
    }
    root.position.set(e.x, e.y, e.z);
    this.scene.add(root);
    this.mobs.set(e.id, view);
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
    }
  }

  event(id: number, event: 'hurt' | 'death' | 'spores'): void {
    const m = this.mobs.get(id);
    if (!m) return;
    if (event === 'hurt') m.hurt = 0.35;
    else if (event === 'death') m.dying = 0.001;
    else this.sporeCloud(m.x, m.y + 0.8, m.z);
  }

  private sporeCloud(x: number, y: number, z: number): void {
    const pos: number[] = [];
    for (let i = 0; i < 160; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 1.2;
      pos.push(Math.cos(a) * r, (Math.random() - 0.3) * 1.2, Math.sin(a) * r);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const points = new THREE.Points(g, new THREE.PointsMaterial({ color: new THREE.Color(0.45, 0.9, 0.7), size: 0.22, transparent: true, depthWrite: false }));
    points.position.set(x, y, z);
    this.scene.add(points);
    this.clouds.push({ points, t: 0 });
  }

  remove(id: number): void {
    const m = this.mobs.get(id);
    if (m) {
      this.scene.remove(m.root);
      m.root.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      m.material.dispose();
      this.mobs.delete(id);
    }
    const t = this.thorns.get(id);
    if (t) {
      this.scene.remove(t.mesh);
      this.thorns.delete(id);
    }
  }

  removeInChunk(cx: number, cz: number): void {
    for (const [id, m] of this.mobs) if (Math.floor(m.x) >> 4 === cx && Math.floor(m.z) >> 4 === cz) this.remove(id);
  }

  /** Nearest living creature hit by the ray within maxDist. */
  pick(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): { id: number; distance: number } | null {
    this.ray.set(origin, dir);
    let best: { id: number; distance: number } | null = null;
    for (const [id, m] of this.mobs) {
      if (m.dying > 0) continue;
      const def = mobDef(m.kind)!;
      const h = def.width / 2;
      this.hitBox.min.set(m.x - h, m.y, m.z - h);
      this.hitBox.max.set(m.x + h, m.y + def.height, m.z + h);
      if (!this.ray.intersectBox(this.hitBox, this.hitPoint)) continue;
      const d = this.hitPoint.distanceTo(origin);
      if (d <= maxDist && (!best || d < best.distance)) best = { id, distance: d };
    }
    return best;
  }

  update(dt: number, daylight: number): void {
    const k = Math.min(1, dt * 10);
    for (const [id, m] of this.mobs) {
      const px = m.x;
      const pz = m.z;
      m.x += (m.tx - m.x) * k;
      m.y += (m.ty - m.y) * k;
      m.z += (m.tz - m.z) * k;
      let dy = m.tyaw - m.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      m.yaw += dy * k;
      m.root.position.set(m.x, m.y, m.z);
      m.root.rotation.y = m.yaw;

      const speed = Math.hypot(m.x - px, m.z - pz) / Math.max(dt, 1e-3);
      m.walk += dt * Math.min(speed, 6) * 3;
      const swing = Math.sin(m.walk) * Math.min(1, speed / 2) * 0.7;
      const attacking = (m.anim & 1) !== 0;
      const fuse = (m.anim & 2) !== 0;
      for (const p of m.parts) {
        if (p.role === 'legA') p.obj.rotation.x = swing;
        else if (p.role === 'legB') p.obj.rotation.x = -swing;
        else if (p.role === 'arm') p.obj.rotation.x = -1.35 + (attacking ? Math.sin(performance.now() / 60) * 0.4 : swing * 0.2);
        else if (p.role === 'cap') p.obj.scale.setScalar(fuse ? 1 + Math.abs(Math.sin(performance.now() / 90)) * 0.15 : 1);
      }

      if (m.dying > 0) {
        m.dying += dt;
        m.model.rotation.z = Math.min(Math.PI / 2, m.dying * 5);
        if (m.dying > 1.2) this.remove(id);
      }
      m.hurt = Math.max(0, m.hurt - dt);
      const l = this.world.getLight(Math.floor(m.x), Math.floor(m.y + 0.5), Math.floor(m.z));
      const b = Math.max(0.1, Math.pow(0.8, 15 - (l >> 4)) * daylight, Math.pow(0.8, 15 - (l & 15)));
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

    for (let i = this.clouds.length - 1; i >= 0; i--) {
      const c = this.clouds[i];
      c.t += dt;
      c.points.scale.setScalar(1 + c.t * 2.5);
      (c.points.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - c.t / 1.4);
      if (c.t > 1.4) {
        this.scene.remove(c.points);
        c.points.geometry.dispose();
        (c.points.material as THREE.Material).dispose();
        this.clouds.splice(i, 1);
      }
    }
  }

  dispose(): void {
    for (const id of [...this.mobs.keys(), ...this.thorns.keys()]) this.remove(id);
    this.glowMaterial.dispose();
    this.thornMaterial.dispose();
    this.thornGeometry.dispose();
  }
}
