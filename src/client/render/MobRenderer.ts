import * as THREE from 'three';
import { BABY_SCALE, Mob, MobAnim, MobFlag, mobDef } from '../../shared/entities/mobs';
import type { EntityInfo, MobEventName } from '../../shared/protocol/messages';
import { hash01, mulberry32 } from '../../shared/rng';
import type { ClientWorld } from '../ClientWorld';
import { SPECIES, type AnimState, type Bone, type Box, type Detail, type Pose, type RGB, type Rig } from './mobModels';

// Creatures as articulated box models. Animals come from species rigs (mobModels.ts: own proportions,
// features, variants, baby forms and animations); monsters and traders from role-tagged box lists.
// Every box gets a pixel-art skin painted from its colour, a pattern and pixel details, one texel per
// model pixel; the skins of a model share one canvas atlas, built once per kind/look and shared.

type Role = 'legA' | 'legB' | 'arm' | 'cap';

interface Part extends Box {
  role?: Role;
}

const PX = 1 / 16;
const THORN_GRAVITY = 6;

const legs = (w: number, h: number, x: number, z: number, color: RGB, extra: Partial<Part> = {}): Part[] => [
  { size: [w, h, w], at: [-x, h / 2, -z], color, role: 'legA', ...extra },
  { size: [w, h, w], at: [x, h / 2, z], color, role: 'legA', ...extra },
  { size: [w, h, w], at: [x, h / 2, -z], color, role: 'legB', ...extra },
  { size: [w, h, w], at: [-x, h / 2, z], color, role: 'legB', ...extra },
];
const eyes = (x: number, y: number, z: number, color: RGB = [0.05, 0.05, 0.05], glow = false, w = 1, h = 1): Part[] => [
  { size: [w, h, 0.3], at: [-x, y, z], color, glow, pattern: 'plain' },
  { size: [w, h, 0.3], at: [x, y, z], color, glow, pattern: 'plain' },
];
const pair = (p: Part): Part[] => [p, { ...p, at: [-p.at[0], p.at[1], p.at[2]] }];

/** Placeholder colour replaced by the trader's profession colour. */
const ROBE: RGB = [-1, -1, -1];
const ROBE_COLORS: RGB[] = [[0.35, 0.55, 0.25], [0.45, 0.33, 0.24], [0.42, 0.26, 0.6]];
const SKIN: RGB = [0.85, 0.68, 0.52];

/** Monsters and traders: boxes with limb roles, animated by the generic animator. */
const MODELS: Record<number, Part[]> = {
  [Mob.TRADER]: [
    { size: [8, 20, 6], at: [0, 10, 0], color: ROBE, pattern: 'cloth', band: { rows: 2, color: [0.2, 0.15, 0.1] } },
    { size: [8.4, 1.5, 6.4], at: [0, 12, 0], color: [0.36, 0.24, 0.14], pattern: 'plain' },
    { size: [2, 2, 0.6], at: [0, 12, -3.4], color: [0.85, 0.72, 0.3], pattern: 'plain' },
    ...pair({ size: [3, 11, 3], at: [-5.5, 15.5, 0], color: ROBE, pattern: 'cloth', band: { rows: 2, color: SKIN } }),
    { size: [8, 8, 8], at: [0, 24, 0], color: SKIN, pattern: 'plain' },
    ...eyes(1.8, 25, -4.1),
    { size: [6, 1, 0.3], at: [0, 26.5, -4.1], color: [0.36, 0.24, 0.16], pattern: 'plain' },
    { size: [2, 3, 1], at: [0, 23, -4.4], color: [0.75, 0.56, 0.42], pattern: 'plain' },
    { size: [11, 1, 11], at: [0, 28.5, 0], color: [0.3, 0.22, 0.14], pattern: 'cloth' },
    { size: [7, 3, 7], at: [0, 30.5, 0], color: [0.3, 0.22, 0.14], pattern: 'cloth', band: { rows: 1, color: ROBE } },
  ],
  [Mob.GLOOMWALKER]: [
    { size: [4, 12, 4], at: [-2, 6, 0], color: [0.22, 0.19, 0.27], role: 'legA', pattern: 'rags', band: { rows: 2, color: [0.1, 0.09, 0.12] } },
    { size: [4, 12, 4], at: [2, 6, 0], color: [0.22, 0.19, 0.27], role: 'legB', pattern: 'rags', band: { rows: 2, color: [0.1, 0.09, 0.12] } },
    { size: [8, 12, 4], at: [0, 18, 0], color: [0.3, 0.26, 0.36], pattern: 'rags' },
    { size: [8.4, 1, 4.4], at: [0, 13, 0], color: [0.17, 0.14, 0.2], pattern: 'plain' },
    { size: [3, 15, 3], at: [-5.5, 17, 0], color: [0.27, 0.23, 0.32], role: 'arm', pattern: 'rags', band: { rows: 3, color: [0.36, 0.42, 0.4] } },
    { size: [3, 15, 3], at: [5.5, 17, 0], color: [0.27, 0.23, 0.32], role: 'arm', pattern: 'rags', band: { rows: 3, color: [0.36, 0.42, 0.4] } },
    { size: [8, 8, 8], at: [0, 28, -0.5], color: [0.36, 0.42, 0.4], top: [0.16, 0.13, 0.2], pattern: 'fur' },
    { size: [9, 3, 9], at: [0, 31.5, 0], color: [0.16, 0.13, 0.2], pattern: 'rags' },
    { size: [9, 6, 2], at: [0, 28, 3.5], color: [0.16, 0.13, 0.2], pattern: 'rags' },
    ...eyes(2, 29, -4.6, [1, 0.85, 0.3], true, 2, 1),
    { size: [4, 1, 0.3], at: [0, 26, -4.6], color: [0.12, 0.1, 0.12], pattern: 'plain' },
  ],
  [Mob.THORNSLINGER]: [
    { size: [12, 12, 12], at: [0, 9, 0], color: [0.3, 0.55, 0.25], pattern: 'ribs' },
    { size: [10, 2, 10], at: [0, 16, 0], color: [0.2, 0.42, 0.18], pattern: 'ribs' },
    { size: [4, 2, 4], at: [0, 18, 0], color: [0.9, 0.4, 0.55], pattern: 'spots', spot: [1, 0.85, 0.4] },
    { size: [6, 3, 0.4], at: [0, 9, -6.1], color: [0.45, 0.08, 0.1], pattern: 'plain' },
    ...eyes(2.5, 12.5, -6.1, [0.95, 0.9, 0.3], true),
    { size: [1, 1, 3], at: [-6.5, 11, 0], color: [0.92, 0.88, 0.6], pattern: 'plain' },
    { size: [1, 1, 3], at: [6.5, 7, 2], color: [0.92, 0.88, 0.6], pattern: 'plain' },
    { size: [3, 1, 1], at: [-3, 15.5, 5], color: [0.92, 0.88, 0.6], pattern: 'plain' },
    { size: [1, 3, 1], at: [3, 6, 6.5], color: [0.92, 0.88, 0.6], pattern: 'plain' },
    { size: [1, 1, 3], at: [6.5, 12, -3], color: [0.92, 0.88, 0.6], pattern: 'plain' },
    ...legs(2, 3, 3, 3, [0.42, 0.3, 0.18], { pattern: 'fur' }),
  ],
  [Mob.SKITTERLING]: [
    { size: [10, 5, 12], at: [0, 6, 1], color: [0.14, 0.3, 0.3], pattern: 'chitin' },
    { size: [8, 4, 6], at: [0, 6.5, 9], color: [0.12, 0.26, 0.27], pattern: 'spots', spot: [0.5, 0.15, 0.15] },
    { size: [6, 4, 5], at: [0, 6, -7.5], color: [0.12, 0.25, 0.26], pattern: 'chitin' },
    ...pair({ size: [1, 1, 2], at: [-1.5, 4, -10.5], color: [0.08, 0.14, 0.14], pattern: 'plain' }),
    ...eyes(1.2, 7, -10.1, [1, 0.2, 0.2], true),
    ...eyes(2.6, 6.2, -10.1, [1, 0.2, 0.2], true),
    ...[-4, -1.5, 1.5, 4].flatMap((z, i): Part[] => [
      { size: [8, 1, 1], at: [-8, 4, z], color: [0.1, 0.2, 0.2], role: i % 2 ? 'legA' : 'legB', pattern: 'chitin' },
      { size: [8, 1, 1], at: [8, 4, z], color: [0.1, 0.2, 0.2], role: i % 2 ? 'legB' : 'legA', pattern: 'chitin' },
    ]),
  ],
  [Mob.SPORECAP]: [
    { size: [2, 2, 3], at: [-2, 1, 0], color: [0.75, 0.7, 0.58], role: 'legA' },
    { size: [2, 2, 3], at: [2, 1, 0], color: [0.75, 0.7, 0.58], role: 'legB' },
    { size: [6, 10, 6], at: [0, 6, 0], color: [0.86, 0.8, 0.68], pattern: 'ribs' },
    { size: [8, 1, 8], at: [0, 10.5, 0], color: [0.78, 0.7, 0.6], pattern: 'ribs' },
    ...eyes(1.5, 8, -3.1, [0.05, 0.05, 0.05], false, 1, 2),
    { size: [14, 5, 14], at: [0, 13.5, 0], color: [0.45, 0.22, 0.56], role: 'cap', pattern: 'spots', spot: [0.8, 0.7, 0.86] },
    { size: [10, 2, 10], at: [0, 17, 0], color: [0.5, 0.26, 0.6], role: 'cap', pattern: 'spots', spot: [0.8, 0.7, 0.86] },
    { size: [2, 0.6, 2], at: [-3, 18.2, -2], color: [0.4, 1, 0.9], glow: true, role: 'cap', pattern: 'plain' },
    { size: [2, 0.6, 2], at: [3, 18.2, 2], color: [0.4, 1, 0.9], glow: true, role: 'cap', pattern: 'plain' },
    { size: [0.6, 2, 2], at: [-7.2, 14, 3], color: [0.4, 1, 0.9], glow: true, role: 'cap', pattern: 'plain' },
    { size: [0.6, 2, 2], at: [7.2, 14, -3], color: [0.4, 1, 0.9], glow: true, role: 'cap', pattern: 'plain' },
  ],
};


/** A monster's box list as a rig: limbs become bones that swing from their top. */
function partsRig(parts: Part[]): Rig {
  const root: Bone = { name: 'root', pivot: [0, 0, 0], boxes: [], children: [] };
  const caps: Box[] = [];
  parts.forEach((p, i) => {
    if (p.role === 'cap') caps.push(p);
    else if (p.role) root.children!.push({ name: `${p.role}${i}`, role: p.role, pivot: [p.at[0], p.at[1] + p.size[1] / 2, p.at[2]], boxes: [p] });
    else root.boxes.push(p);
  });
  if (caps.length) root.children!.push({ name: 'cap', role: 'cap', pivot: [0, caps[0].at[1], 0], boxes: caps });
  return { bones: [root], scale: 1 };
}

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
  roles: Array<{ obj: THREE.Object3D; role: Role }>;
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
};

/** Renders creatures, thorns and particles; also answers "which creature is the crosshair on". */
export class MobRenderer {
  private readonly mobs = new Map<number, MobView>();
  private readonly thorns = new Map<number, ThornView>();
  private readonly puffs: Puff[] = [];
  private readonly thornMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.85, 0.82, 0.45) });
  private readonly thornGeometry = new THREE.BoxGeometry(1 * PX, 1 * PX, 6 * PX);
  /** Skins and geometries per kind/look, shared by every creature that looks the same. */
  private readonly kits = new Map<string, Kit>();
  private readonly ray = new THREE.Ray();
  private readonly hitBox = new THREE.Box3();
  private readonly hitPoint = new THREE.Vector3();
  /** Gallery: fixed speed / vertical speed per creature instead of measured motion. */
  readonly motion = new Map<number, { speed: number; vy: number }>();
  /** The creature this client rides: drawn where the local player is (no network lag). */
  private ridden: { id: number; at: () => { x: number; y: number; z: number; yaw: number } } | null = null;

  constructor(private readonly scene: THREE.Scene, private readonly world: ClientWorld) {}

  get count(): number {
    return this.mobs.size;
  }

  private lookKey(kind: number, variant: number, flags: number): string {
    return `${kind}:${variant}:${flags & (SPECIES[kind]?.lookFlags ?? 0)}`;
  }

  private kit(kind: number, variant: number, flags: number): Kit | null {
    const key = this.lookKey(kind, variant, flags);
    let kit = this.kits.get(key);
    if (!kit) {
      const species = SPECIES[kind];
      let rig: Rig;
      if (species) rig = species.build({ variant, flags });
      else {
        const parts = MODELS[kind];
        if (!parts) return null;
        const robe = ROBE_COLORS[variant] ?? ROBE_COLORS[0];
        const fill = (c: RGB): RGB => (c === ROBE ? robe : c);
        rig = partsRig(parts.map((p) => ({ ...p, color: fill(p.color), band: p.band && { ...p.band, color: fill(p.band.color) } })));
      }
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
    view.roles = [];
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
      if (b.role) view.roles.push({ obj: g, role: b.role });
      for (const ch of b.children ?? []) add(ch, g, b.pivot);
    };
    for (const b of kit.rig.bones) add(b, view.model, [0, 0, 0]);
    view.model.scale.setScalar(kit.rig.scale);
    view.material.map = kit.texture;
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
    if (!SPECIES[e.mob] && !MODELS[e.mob]) return;
    const root = new THREE.Group();
    const model = new THREE.Group();
    root.add(model);
    const view: MobView = {
      kind: e.mob, variant: e.variant ?? 0, flags: e.flags ?? 0, lookKey: '', root, model, pose: new Map(), roles: [],
      material: new THREE.MeshBasicMaterial({ vertexColors: true }),
      x: e.x, y: e.y, z: e.z, yaw: e.yaw, tx: e.x, ty: e.y, tz: e.z, tyaw: e.yaw, anim: 0, walk: Math.random() * 6, vy: 0,
      seed: Math.random(), hurt: 0, dying: 0,
    };
    this.dress(view);
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
    if (this.lookKey(m.kind, m.variant, m.flags) !== m.lookKey) this.dress(m);
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

  setRidden(id: number | null, at?: () => { x: number; y: number; z: number; yaw: number }): void {
    this.ridden = id !== null && at ? { id, at } : null;
  }

  event(id: number, event: MobEventName): void {
    const m = this.mobs.get(id);
    if (!m) return;
    if (event === 'hurt') m.hurt = 0.35;
    else if (event === 'death') m.dying = 0.001;
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

  update(dt: number, daylight: number): void {
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
      const species = SPECIES[m.kind];
      if (species) {
        const s: AnimState = { t: now, dt, walk: m.walk, speed, vy: m.vy, anim: m.anim, flags: m.flags, seed: m.seed };
        species.animate(m.pose, s);
      } else {
        const swing = Math.sin(m.walk) * Math.min(1, speed / 2) * 0.7;
        const attacking = (m.anim & MobAnim.ATTACK) !== 0;
        const fuse = (m.anim & MobAnim.FUSE) !== 0;
        for (const p of m.roles) {
          if (p.role === 'legA') p.obj.rotation.x = swing;
          else if (p.role === 'legB') p.obj.rotation.x = -swing;
          else if (p.role === 'arm') p.obj.rotation.x = -1.35 + (attacking ? Math.sin(performance.now() / 60) * 0.4 : swing * 0.2);
          else if (p.role === 'cap') p.obj.scale.setScalar(fuse ? 1 + Math.abs(Math.sin(performance.now() / 90)) * 0.15 : 1);
        }
      }

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

  dispose(): void {
    for (const id of [...this.mobs.keys(), ...this.thorns.keys()]) this.remove(id);
    for (const kit of this.kits.values()) {
      kit.geometries.forEach((g) => g.dispose());
      kit.texture.dispose();
      kit.glow.dispose();
    }
    this.kits.clear();
    this.thornMaterial.dispose();
    this.thornGeometry.dispose();
  }
}

/** For the creature gallery: a rig's skins + geometries, without a renderer. */
export { buildKit as buildCreatureKit, partsRig, MODELS as MONSTER_MODELS, ROBE, ROBE_COLORS };
