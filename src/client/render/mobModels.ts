import { Mob, MobAnim, MobFlag } from '../../shared/entities/mobs';

// Creature rigs: boxes ("cuboids") on bones, in 1/16-block model pixels. Every species has its own
// builder (proportions, features, colour variants, baby proportions) and its own animator. Boxes are
// placed in model space (centre `at`, y up from the feet, the creature faces -z); bones pivot at
// `pivot` (model space too) and may hold child bones. Skins are painted per box from a colour and a
// pattern plus pixel details (eyes, nostrils, markings) – see MobRenderer.

export type RGB = [number, number, number];
export type Pattern = 'plain' | 'fur' | 'fleece' | 'cloth' | 'rags' | 'ribs' | 'spots' | 'feather' | 'chitin' | 'patches' | 'shaggy' | 'stripes';
/** A pixel rectangle on a face: [x from the viewer's left, y from the top, w, h, colour]. */
export type Detail = [number, number, number, number, RGB];

export interface Box {
  size: [number, number, number];
  at: [number, number, number];
  color: RGB;
  top?: RGB;
  pattern?: Pattern;
  /** Second colour for spots / patches / stripes. */
  spot?: RGB;
  /** Lowest texel rows of the side faces in another colour (hooves, socks, cuffs). */
  band?: { rows: number; color: RGB };
  glow?: boolean;
  /** Details on the front face (-z). */
  face?: Detail[];
  /** Details on both side faces, x measured from the front end. */
  side?: Detail[];
}

export interface Bone {
  name: string;
  pivot: [number, number, number];
  /** Resting rotation (x, y, z radians). */
  rot?: [number, number, number];
  boxes: Box[];
  children?: Bone[];
  /** Old-style limb role (monsters): animated by the generic animator. */
  role?: 'legA' | 'legB' | 'arm' | 'cap';
}

export interface Rig {
  bones: Bone[];
  /** Whole-model scale (babies are smaller). */
  scale: number;
}

export interface Look {
  variant: number;
  flags: number;
}

/** What the animator knows about a creature this frame. */
export interface AnimState {
  /** Seconds since the page started. */
  t: number;
  dt: number;
  /** Walk cycle phase (advances with distance). */
  walk: number;
  /** Horizontal speed, blocks/s. */
  speed: number;
  /** Vertical speed, blocks/s. */
  vy: number;
  anim: number;
  flags: number;
  /** A per-creature random number 0..1 (so idle motions don't sync up). */
  seed: number;
  /** Seconds since its last big hit on the ground ('slam' event); Infinity if none. */
  slam: number;
}

/** The posable parts of a built model, by bone name. */
export type Pose = Map<string, {
  obj: { rotation: { x: number; y: number; z: number; set(x: number, y: number, z: number): void }; position: { x: number; y: number; z: number }; scale: { setScalar(n: number): void } };
  rest: [number, number, number];
  base: [number, number, number];
}>;

export interface Species {
  build(look: Look): Rig;
  animate(pose: Pose, s: AnimState): void;
  /** Look flags that change the model (others are animation only). */
  lookFlags: number;
  /** Every variant value it can have (for the gallery). */
  variants: number[];
}

export const range = (n: number) => Array.from({ length: n }, (_, i) => i);

// --- Helpers ----------------------------------------------------------------------------

export const c = (r: number, g: number, b: number): RGB => [r / 255, g / 255, b / 255];
export const BLACK = c(22, 20, 22);
export const WHITE = c(246, 244, 240);
export const PINK = c(236, 160, 164);

export const box = (size: Box['size'], at: Box['at'], color: RGB, o: Partial<Box> = {}): Box => ({ size, at, color, ...o });
export const bone = (name: string, pivot: Bone['pivot'], boxes: Box[], children: Bone[] = [], rot?: Bone['rot']): Bone => ({ name, pivot, boxes, children, rot });
export const mirror = (b: Box): Box => ({ ...b, at: [-b.at[0], b.at[1], b.at[2]] });
export const both = (b: Box): Box[] => [b, mirror(b)];

interface QuadSpec {
  legH: number;
  legW: number;
  legX: number;
  /** How far the legs sit in from the front/back ends of the body. */
  legIn: [number, number];
  leg: Partial<Box> & { color: RGB };
  body: { w: number; h: number; l: number; z?: number; lift?: number } & Partial<Box> & { color: RGB };
  /** dy: head top above the body top; dz: how far its back sits inside the body front. */
  head: { w: number; h: number; l: number; dy: number; dz: number } & Partial<Box> & { color: RGB };
  /** Pivot of the body bone: 'hips' for sitters (wolves, cats). */
  sitter?: boolean;
}

interface Quad {
  bones: Bone[];
  body: Bone;
  head: Bone;
  legY: number;
  bodyTop: number;
  bodyFront: number;
  bodyBack: number;
  headTop: number;
  headFront: number;
  headY: number;
  headZ: number;
  headBottom: number;
}

/** A four-legged frame: legs (legFL/FR/BL/BR), body, head on the body. Species add their own features. */
function quad(q: QuadSpec): Quad {
  const { legH, legW, legX } = q;
  const b = q.body;
  const bz = b.z ?? 0;
  const bodyY = legH + (b.lift ?? 0) + b.h / 2;
  const bodyFront = bz - b.l / 2;
  const bodyBack = bz + b.l / 2;
  const bodyTop = bodyY + b.h / 2;
  const legZ = [bodyFront + q.legIn[0], bodyBack - q.legIn[1]];
  const { w: _w, h: _h, l: _l, z: _z, lift: _lift, ...bodyLook } = b;
  void _w; void _h; void _l; void _z; void _lift;
  const h = q.head;
  const headY = bodyTop + h.dy - h.h / 2;
  // dz: how far the back of the head sits inside the body's front.
  const headZ = bodyFront + h.dz - h.l / 2;
  const { w: _hw, h: _hh, l: _hl, dy: _dy, dz: _dz, ...headLook } = h;
  void _hw; void _hh; void _hl; void _dy; void _dz;
  const head = bone('head', [0, Math.min(headY, bodyTop - 1), bodyFront + 1], [box([h.w, h.h, h.l], [0, headY, headZ], h.color, headLook)]);
  const bodyPivot: Bone['pivot'] = q.sitter ? [0, legH, bodyBack - 2] : [0, bodyY, bz];
  const body = bone('body', bodyPivot, [box([b.w, b.h, b.l], [0, bodyY, bz], b.color, bodyLook)], [head]);
  const legs = (['FL', 'FR', 'BL', 'BR'] as const).map((n, i) => {
    const x = n[1] === 'L' ? -legX : legX;
    const z = i < 2 ? legZ[0] : legZ[1];
    const { color, ...legLook } = q.leg;
    return bone(`leg${n}`, [x, legH, z], [box([legW, legH, legW], [x, legH / 2, z], color, legLook)]);
  });
  return {
    bones: [body, ...legs], body, head, legY: legH, bodyTop, bodyFront, bodyBack,
    headTop: headY + h.h / 2, headFront: headZ - h.l / 2, headY, headZ, headBottom: headY - h.h / 2,
  };
}

function tail(pivot: Bone['pivot'], size: Box['size'], color: RGB, rot: Bone['rot'], o: Partial<Box> = {}): Bone {
  return bone('tail', pivot, [box(size, [pivot[0], pivot[1] - size[1] / 2, pivot[2]], color, o)], [], rot);
}

const baby = (l: Look) => (l.flags & MobFlag.BABY) !== 0;

// --- Shared animation pieces --------------------------------------------------------------

export function set(pose: Pose, name: string, x: number, y = 0, z = 0): void {
  const p = pose.get(name);
  if (p) p.obj.rotation.set(p.rest[0] + x, p.rest[1] + y, p.rest[2] + z);
}

/** Moves a bone by (dy, dz) model pixels from where it was built. */
export function lift(pose: Pose, name: string, dy: number, dz = 0): void {
  const p = pose.get(name);
  if (p) {
    p.obj.position.y = p.base[1] + dy / 16;
    p.obj.position.z = p.base[2] + dz / 16;
  }
}

/** Diagonal-pair walk (front-left with back-right). */
export function walkLegs(pose: Pose, s: AnimState, amp = 0.75): number {
  const k = Math.min(1, s.speed / 1.6) * amp;
  const a = Math.sin(s.walk) * k;
  set(pose, 'legFL', a);
  set(pose, 'legBR', a);
  set(pose, 'legFR', -a);
  set(pose, 'legBL', -a);
  return k;
}

/** Head: grazing (down), idle glances, a nod while walking. */
export function headIdle(pose: Pose, s: AnimState, eatDown = 1.0): void {
  if (s.anim & MobAnim.EAT) {
    set(pose, 'head', -eatDown + Math.sin(s.t * 14) * 0.08);
    return;
  }
  const still = s.speed < 0.2;
  const glance = still ? Math.sin(s.t * 0.45 + s.seed * 20) * 0.45 + Math.sin(s.t * 1.3 + s.seed * 7) * 0.12 : 0;
  set(pose, 'head', still ? Math.sin(s.t * 0.7 + s.seed * 9) * 0.06 : Math.sin(s.walk * 2) * 0.05, glance);
}

/**
 * Sitting (wolves, cats): the hips drop by `drop` px and the body tips up about them so the chest stays
 * on the straight front legs `reach` px ahead; the hind legs fold forward on the ground.
 */
function sitPose(pose: Pose, drop: number, reach: number): void {
  const pitch = Math.asin(Math.min(0.9, drop / reach));
  set(pose, 'body', pitch);
  lift(pose, 'body', -drop);
  for (const n of ['legBL', 'legBR']) {
    set(pose, n, 1.45, 0, n === 'legBL' ? -0.15 : 0.15);
    lift(pose, n, -drop, -1);
  }
  set(pose, 'legFL', 0);
  set(pose, 'legFR', 0);
  set(pose, 'head', -pitch);
}

export function resetLifts(pose: Pose): void {
  for (const p of pose.values()) {
    p.obj.position.y = p.base[1];
    p.obj.position.z = p.base[2];
  }
}

const collar = (q: Quad, w: number): Box => box([w + 0.4, 1.2, 2], [0, q.headBottom + 0.4, q.bodyFront + 0.6], c(200, 40, 40), { pattern: 'plain' });

// --- Cow ------------------------------------------------------------------------------------

const COWS = [
  { hide: c(238, 236, 230), spot: c(34, 32, 36), pattern: 'patches' as Pattern, head: c(238, 236, 230), muzzle: c(232, 178, 178), horn: c(226, 214, 180) },
  { hide: c(164, 84, 42), spot: c(130, 62, 30), pattern: 'shaggy' as Pattern, head: c(154, 78, 38), muzzle: c(112, 66, 48), horn: c(232, 220, 186) },
  { hide: c(216, 198, 168), spot: c(170, 150, 124), pattern: 'fur' as Pattern, head: c(132, 114, 98), muzzle: c(64, 56, 52), horn: c(70, 60, 52) },
];

const cow: Species = {
  variants: range(3),
  lookFlags: MobFlag.BABY,
  build(l) {
    const p = COWS[l.variant] ?? COWS[0];
    const kid = baby(l);
    const q = quad({
      legH: kid ? 9 : 10, legW: kid ? 3 : 4, legX: kid ? 3 : 4, legIn: kid ? [2, 2] : [3, 3],
      leg: { color: p.hide, pattern: p.pattern, spot: p.spot, band: { rows: 1, color: c(46, 40, 36) } },
      body: kid ? { w: 9, h: 8, l: 12, color: p.hide, pattern: p.pattern, spot: p.spot } : { w: 12, h: 10, l: 18, z: 1, color: p.hide, pattern: p.pattern, spot: p.spot },
      head: {
        w: 8, h: kid ? 8 : 8, l: kid ? 6 : 7, dy: kid ? 3 : 2, dz: 1, color: p.head,
        pattern: l.variant === 0 ? 'patches' : 'fur', spot: p.spot,
        face: [[1, 2, 1, 2, BLACK], [6, 2, 1, 2, BLACK], [1, 1, 1, 1, c(255, 255, 255)], [6, 1, 1, 1, c(255, 255, 255)]],
      },
    });
    const h = q.head.boxes;
    h.push(box([6, 4, 2], [0, q.headY - 1.5, q.headFront - 1], p.muzzle, { pattern: 'plain', face: [[1, 1, 1, 1, c(60, 40, 40)], [4, 1, 1, 1, c(60, 40, 40)]] }));
    h.push(...both(box([3, 2, 1], [-5.5, q.headTop - 2, q.headZ + 1], p.head)));
    if (!kid) {
      if (l.variant === 1) {
        h.push(...both(box([4, 1.5, 1.5], [-6, q.headTop - 0.5, q.headZ + 1], p.horn, { pattern: 'ribs' })));
        h.push(...both(box([1.5, 2.5, 1.5], [-8.25, q.headTop + 1.25, q.headZ + 1], p.horn, { pattern: 'plain' })));
        h.push(box([8.2, 3, 1], [0, q.headTop - 1.5, q.headFront - 0.4], p.spot, { pattern: 'shaggy' }));
      } else {
        h.push(...both(box([1, l.variant === 2 ? 2 : 3, 1], [-4.5, q.headTop + 1, q.headZ + 1], p.horn, { pattern: 'plain' })));
      }
      q.body.boxes.push(box([4, 2, 5], [0, q.legY - 1, q.bodyBack - 6], PINK, { pattern: 'plain' }));
      if (l.variant === 2) q.body.boxes.push(box([6, 4, 5], [0, q.bodyTop + 1.5, q.bodyFront + 3], p.hide, { pattern: 'fur' }));
    }
    q.body.children!.push(tail([0, q.bodyTop - 1, q.bodyBack + 0.5], [1, kid ? 6 : 9, 1], p.hide, [-0.15, 0, 0], { band: { rows: 2, color: p.spot } }));
    return { bones: q.bones, scale: kid ? 0.62 : 1 };
  },
  animate(pose, s) {
    walkLegs(pose, s, 0.6);
    headIdle(pose, s, 1.1);
    set(pose, 'tail', Math.sin(s.t * 1.7 + s.seed * 5) * 0.12, 0, Math.sin(s.t * 2.3 + s.seed * 3) * 0.25);
  },
};

// --- Sheep ----------------------------------------------------------------------------------

const FLEECE: RGB[] = [c(240, 238, 230), c(176, 176, 172), c(92, 90, 92), c(36, 34, 36), c(116, 80, 50), c(242, 178, 196)];

const sheep: Species = {
  variants: range(6),
  lookFlags: MobFlag.BABY | MobFlag.SHEARED,
  build(l) {
    const kid = baby(l);
    const shorn = (l.flags & MobFlag.SHEARED) !== 0;
    const wool = FLEECE[l.variant] ?? FLEECE[0];
    const face = c(52, 44, 40);
    const skin = c(222, 200, 180);
    const body = shorn ? { w: kid ? 7 : 9, h: kid ? 6 : 8, l: kid ? 10 : 14, color: skin, pattern: 'fur' as Pattern }
      : { w: kid ? 9 : 12, h: kid ? 8 : 10, l: kid ? 11 : 16, color: wool, pattern: 'fleece' as Pattern };
    const q = quad({
      legH: kid ? 7 : 8, legW: 3, legX: kid ? 2.5 : 3.5, legIn: [2.5, 2.5],
      leg: { color: face, pattern: 'fur', band: { rows: 1, color: c(30, 26, 24) } },
      body,
      head: {
        w: 6, h: 6, l: kid ? 6 : 7, dy: shorn ? 4 : 3, dz: 2, color: face, pattern: 'fur',
        face: [[1, 2, 1, 1, c(216, 196, 120)], [4, 2, 1, 1, c(216, 196, 120)], [2, 4, 2, 1, c(30, 24, 22)]],
      },
    });
    q.head.boxes.push(...both(box([3, 1, 2], [-4, q.headTop - 1.5, q.headZ + 1], face)));
    if (!shorn) {
      q.head.boxes.push(box([6.4, 2, kid ? 3 : 4], [0, q.headTop + 0.6, q.headZ + 1.5], wool, { pattern: 'fleece' }));
      for (const b of q.bones) if (b.name.startsWith('leg')) b.boxes.push(box([4, 3, 4], [b.pivot[0], b.pivot[1] - 1.5, b.pivot[2]], wool, { pattern: 'fleece' }));
    }
    q.body.children!.push(tail([0, q.bodyTop - 2, q.bodyBack + 0.5], [3, 3, 2], shorn ? skin : wool, [-0.2, 0, 0], { pattern: shorn ? 'fur' : 'fleece' }));
    return { bones: q.bones, scale: kid ? 0.6 : 1 };
  },
  animate(pose, s) {
    walkLegs(pose, s, 0.7);
    headIdle(pose, s, 1.2);
    set(pose, 'tail', 0, 0, Math.sin(s.t * 3 + s.seed * 4) * 0.15);
  },
};

// --- Pig ------------------------------------------------------------------------------------

const PIGS = [
  { skin: c(240, 170, 168), dark: c(214, 136, 138), pattern: 'fur' as Pattern },
  { skin: c(150, 104, 70), dark: c(110, 74, 48), pattern: 'fleece' as Pattern },
  { skin: c(40, 36, 40), dark: c(24, 22, 24), pattern: 'fur' as Pattern },
];

const pig: Species = {
  variants: range(3),
  lookFlags: MobFlag.BABY,
  build(l) {
    const p = PIGS[l.variant] ?? PIGS[0];
    const kid = baby(l);
    const q = quad({
      legH: kid ? 3 : 5, legW: 3, legX: kid ? 2 : 3, legIn: [2, 2],
      leg: { color: p.skin, pattern: 'fur', band: { rows: 1, color: p.dark } },
      body: kid ? { w: 7, h: 6, l: 9, color: p.skin, pattern: p.pattern } : { w: 10, h: 9, l: 15, color: p.skin, pattern: p.pattern },
      head: {
        w: kid ? 7 : 8, h: kid ? 7 : 8, l: kid ? 5 : 7, dy: kid ? 1 : -1, dz: 1, color: p.skin, pattern: 'fur',
        face: [[1, 2, 1, 1, BLACK], [kid ? 5 : 6, 2, 1, 1, BLACK]],
      },
    });
    const snout = l.variant === 2 ? c(220, 150, 150) : c(250, 186, 186);
    q.head.boxes.push(box([5, 3, 1.5], [0, q.headY - 1, q.headFront - 0.75], snout, { pattern: 'plain', face: [[1, 1, 1, 1, c(150, 80, 84)], [3, 1, 1, 1, c(150, 80, 84)]] }));
    q.head.boxes.push(...both(box([3, 1, 3], [-(q.head.boxes[0].size[0] / 2) + 0.5, q.headTop - 0.2, q.headZ - 1], p.dark, { pattern: 'plain' })));
    if (l.variant === 2 && !kid) q.body.boxes.push(box([10.3, 9.3, 3], [0, q.legY + 4.5, q.bodyFront + 3.5], c(234, 184, 184), { pattern: 'fur' }));
    q.body.children!.push(bone('tail', [0, q.bodyTop - 2, q.bodyBack], [
      box([1, 1, 2], [0, q.bodyTop - 2, q.bodyBack + 1], p.dark, { pattern: 'plain' }),
      box([1, 2, 1], [0, q.bodyTop - 1.5, q.bodyBack + 2.2], p.dark, { pattern: 'plain' }),
    ]));
    return { bones: q.bones, scale: kid ? 0.65 : 1 };
  },
  animate(pose, s) {
    walkLegs(pose, s, 0.8);
    headIdle(pose, s, 0.6);
    set(pose, 'tail', 0, 0, Math.sin(s.t * 6 + s.seed * 4) * 0.3);
  },
};

// --- Chicken --------------------------------------------------------------------------------

const HENS = [
  { body: c(246, 244, 238), wing: c(226, 224, 218), tail: c(236, 234, 228), pattern: 'feather' as Pattern, spot: undefined as RGB | undefined },
  { body: c(150, 152, 156), wing: c(120, 122, 126), tail: c(60, 62, 66), pattern: 'stripes' as Pattern, spot: c(70, 72, 78) },
  { body: c(170, 84, 40), wing: c(140, 64, 30), tail: c(52, 40, 34), pattern: 'feather' as Pattern, spot: undefined },
];

const chicken: Species = {
  variants: range(3),
  lookFlags: MobFlag.BABY,
  build(l) {
    const yellow = c(240, 180, 50);
    if (baby(l)) {
      const fluff = c(250, 226, 110);
      const head = bone('head', [0, 6, -1.5], [
        box([4, 4, 3.5], [0, 7.5, -2.5], fluff, { pattern: 'fleece', face: [[0, 1, 1, 1, BLACK], [3, 1, 1, 1, BLACK]] }),
        box([1.5, 1, 1.5], [0, 7, -5], c(240, 150, 40), { pattern: 'plain' }),
      ]);
      const body = bone('body', [0, 3, 0], [box([5, 5, 5], [0, 4.5, 0.5], fluff, { pattern: 'fleece' })], [
        head,
        bone('wingL', [-2.6, 6, 0], [box([0.8, 2, 3], [-2.8, 5, 0.6], fluff, { pattern: 'fleece' })]),
        bone('wingR', [2.6, 6, 0], [box([0.8, 2, 3], [2.8, 5, 0.6], fluff, { pattern: 'fleece' })]),
      ]);
      const leg = (n: string, x: number) => bone(n, [x, 2.2, 0.5], [box([0.8, 2.2, 0.8], [x, 1.1, 0.5], c(236, 150, 40), { pattern: 'plain' }), box([2, 0.5, 2], [x, 0.25, -0.2], c(236, 150, 40), { pattern: 'plain' })]);
      return { bones: [body, leg('legL', -1), leg('legR', 1)], scale: 0.62 };
    }
    const p = HENS[l.variant] ?? HENS[0];
    const red = c(214, 40, 34);
    const head = bone('head', [0, 10, -3], [
      box([4, 6, 3], [0, 13, -4.5], p.body, { pattern: 'feather', face: [[0, 1, 1, 1, BLACK], [3, 1, 1, 1, BLACK]] }),
      box([2, 1.5, 2], [0, 13.5, -7], yellow, { pattern: 'plain', top: c(250, 200, 70) }),
      box([1, 2, 1], [0, 11.5, -6.5], red, { pattern: 'plain' }),
      box([1, l.variant === 0 ? 2.5 : 1.5, 3], [0, l.variant === 0 ? 17.2 : 16.7, -4.5], red, { pattern: 'plain' }),
    ]);
    const body = bone('body', [0, 6, 0], [
      box([6, 6, 8], [0, 8, 0.5], p.body, { pattern: p.pattern, spot: p.spot }),
      box([4, 4, 2], [0, 11.5, 5], p.tail, { pattern: 'feather' }),
    ], [
      head,
      bone('wingL', [-3.5, 10.5, -1], [box([1, 4, 6], [-3.5, 8.5, 1], p.wing, { pattern: 'feather', spot: p.spot })]),
      bone('wingR', [3.5, 10.5, -1], [box([1, 4, 6], [3.5, 8.5, 1], p.wing, { pattern: 'feather', spot: p.spot })]),
    ]);
    const leg = (n: string, x: number) => bone(n, [x, 5, 0.5], [
      box([1, 5, 1], [x, 2.5, 0.5], yellow, { pattern: 'ribs' }),
      box([3, 0.6, 3], [x, 0.3, -0.5], yellow, { pattern: 'plain' }),
    ]);
    return { bones: [body, leg('legL', -1.5), leg('legR', 1.5)], scale: 1 };
  },
  animate(pose, s) {
    const k = Math.min(1, s.speed / 1.2);
    const a = Math.sin(s.walk * 1.4) * 0.9 * k;
    set(pose, 'legL', a);
    set(pose, 'legR', -a);
    // Head bobs forward and back as it walks; pecks when grazing.
    const peck = s.anim & MobAnim.EAT ? -Math.max(0, Math.sin(s.t * 9)) * 1.1 : 0;
    set(pose, 'head', peck, s.speed < 0.2 ? Math.sin(s.t * 0.8 + s.seed * 13) * 0.6 : 0);
    lift(pose, 'head', 0, k * Math.sin(s.walk * 2.8) * 0.9);
    // Wings flap while falling or running away, otherwise rest.
    const flap = s.vy < -0.5 || s.anim & MobAnim.FLEE ? 0.6 + Math.sin(s.t * 32) * 0.6 : 0;
    set(pose, 'wingL', 0, 0, flap);
    set(pose, 'wingR', 0, 0, -flap);
  },
};

// --- Horse ----------------------------------------------------------------------------------

const COATS: Array<{ coat: RGB; mane: RGB }> = [
  { coat: c(236, 232, 224), mane: c(210, 206, 196) },
  { coat: c(222, 192, 140), mane: c(246, 236, 210) },
  { coat: c(160, 86, 40), mane: c(124, 62, 28) },
  { coat: c(98, 64, 40), mane: c(36, 28, 24) },
  { coat: c(36, 32, 34), mane: c(20, 18, 20) },
  { coat: c(138, 138, 142), mane: c(56, 56, 60) },
];

const horse: Species = {
  variants: range(24).map((i) => (i % 6) | (Math.floor(i / 6) << 3)),
  lookFlags: MobFlag.BABY | MobFlag.SADDLED,
  build(l) {
    const kid = baby(l);
    const coat = COATS[l.variant & 7] ?? COATS[0];
    const marks = (l.variant >> 3) & 3;
    const legH = kid ? 11 : 12;
    const white = c(242, 238, 230);
    const q = quad({
      legH, legW: kid ? 2.5 : 3, legX: kid ? 2.5 : 3.5, legIn: [2.5, 2.5],
      leg: { color: coat.coat, pattern: 'fur', band: marks === 1 ? { rows: 5, color: white } : undefined },
      body: kid ? { w: 7, h: 7, l: 13, color: coat.coat, pattern: marks === 3 ? 'spots' : 'fur', spot: white }
        : { w: 10, h: 10, l: 22, color: coat.coat, pattern: marks === 3 ? 'spots' : 'fur', spot: c(Math.min(255, coat.coat[0] * 255 + 50), Math.min(255, coat.coat[1] * 255 + 50), Math.min(255, coat.coat[2] * 255 + 50)) },
      head: { w: 1, h: 1, l: 1, dy: 0, dz: 0, color: coat.coat },
    });
    for (const b of q.bones) if (b.name.startsWith('leg')) b.boxes.push(box([(kid ? 2.5 : 3) + 0.4, 1.5, (kid ? 2.5 : 3) + 0.4], [b.pivot[0], 0.75, b.pivot[2]], c(44, 38, 34), { pattern: 'plain' }));
    // Neck and head replace the generic head: the neck leans forward, the long head points down.
    q.body.children = [];
    const nw = kid ? 4 : 5;
    const nl = kid ? 9 : 12;
    const pivot: Bone['pivot'] = [0, q.bodyTop - 2, q.bodyFront + 2.5];
    const hl = kid ? 8 : 11;
    const hz = pivot[2] - 4;
    const hy = pivot[1] + nl - 1;
    const head = bone('head', [0, hy, pivot[2]], [
      box([nw, kid ? 4.5 : 5, hl], [0, hy, hz], coat.coat, {
        pattern: 'fur',
        face: [[1, kid ? 3 : 3, 1, 1, c(40, 30, 28)], [nw - 2, kid ? 3 : 3, 1, 1, c(40, 30, 28)], ...(marks === 2 ? [[Math.floor(nw / 2), 0, 1, 3, white] as Detail] : [])],
        side: [[3, 1, 1, 1, BLACK]],
      }),
      ...both(box([1.5, 3, 1.5], [-(nw / 2) + 0.75, hy + 3.5, pivot[2] - 0.5], coat.coat, { pattern: 'fur' })),
      box([2, 2, 3], [0, hy + 2.8, pivot[2] - 1], coat.mane, { pattern: 'shaggy' }),
    ], [], [-0.3, 0, 0]);
    const neck = bone('neck', pivot, [
      box([nw, nl, kid ? 5 : 7], [0, pivot[1] + nl / 2, pivot[2] - 1], coat.coat, { pattern: 'fur' }),
      box([2, nl + 1, 2.5], [0, pivot[1] + nl / 2 + 0.5, pivot[2] + 2.6], coat.mane, { pattern: 'shaggy' }),
    ], [head], [-0.6, 0, 0]);
    q.body.children.push(neck);
    q.body.children.push(tail([0, q.bodyTop - 1, q.bodyBack], [kid ? 2 : 3, kid ? 8 : 13, kid ? 2 : 3], coat.mane, [-0.4, 0, 0], { pattern: 'shaggy' }));
    if (l.flags & MobFlag.SADDLED && !kid) {
      const leather = c(120, 72, 40);
      q.body.boxes.push(
        box([10.6, 1.5, 9], [0, q.bodyTop + 0.5, q.bodyFront + 9], leather, { pattern: 'plain' }),
        box([10.6, 2, 2], [0, q.bodyTop + 1.5, q.bodyFront + 13], c(98, 58, 32), { pattern: 'plain' }),
        box([10.8, 4, 0.8], [0, q.bodyTop - 2, q.bodyFront + 8], c(60, 40, 26), { pattern: 'plain' }),
        ...both(box([1, 1, 1.5], [-5.6, q.bodyTop - 4.5, q.bodyFront + 8], c(190, 190, 196), { pattern: 'plain' })),
      );
    }
    return { bones: q.bones, scale: kid ? 0.6 : 1 };
  },
  animate(pose, s) {
    const gallop = s.speed > 4;
    walkLegs(pose, s, gallop ? 1.0 : 0.6);
    const eat = (s.anim & MobAnim.EAT) !== 0;
    set(pose, 'neck', eat ? -1.0 : gallop ? -0.25 : Math.sin(s.walk * 2) * 0.05 + (s.speed < 0.2 ? Math.sin(s.t * 0.6 + s.seed * 9) * 0.08 : 0),
      s.speed < 0.2 && !eat ? Math.sin(s.t * 0.4 + s.seed * 17) * 0.25 : 0);
    set(pose, 'head', eat ? -0.3 + Math.sin(s.t * 12) * 0.05 : 0);
    set(pose, 'tail', gallop ? -0.7 : Math.sin(s.t * 1.3 + s.seed * 5) * 0.1, 0, Math.sin(s.t * 2.1 + s.seed * 3) * 0.3);
  },
};

// --- Wolf -----------------------------------------------------------------------------------

const WOLVES = [
  { fur: c(150, 144, 136), back: c(104, 98, 94), belly: c(200, 194, 184) },
  { fur: c(236, 232, 224), back: c(212, 206, 196), belly: c(248, 246, 240) },
  { fur: c(56, 52, 54), back: c(36, 34, 36), belly: c(96, 90, 88) },
];

const wolf: Species = {
  variants: range(3),
  lookFlags: MobFlag.BABY | MobFlag.TAMED | MobFlag.ANGRY,
  build(l) {
    const p = WOLVES[l.variant] ?? WOLVES[0];
    const kid = baby(l);
    const angry = (l.flags & MobFlag.ANGRY) !== 0;
    const eye = angry ? c(230, 40, 30) : c(214, 170, 60);
    const q = quad({
      legH: kid ? 5 : 8, legW: 2, legX: kid ? 1.5 : 2, legIn: [1.5, 1.5], sitter: true,
      leg: { color: p.fur, pattern: 'fur' },
      body: kid ? { w: 5, h: 5, l: 8, color: p.fur, top: p.back, pattern: 'fur' } : { w: 6, h: 6, l: 12, z: 1, color: p.fur, top: p.back, pattern: 'fur' },
      head: {
        w: 6, h: kid ? 6 : 6, l: 4, dy: 4, dz: kid ? 1 : 0, color: p.fur, top: p.back, pattern: 'fur',
        face: [[1, 2, 1, 1, eye], [4, 2, 1, 1, eye], ...(angry ? [[1, 1, 1, 1, c(30, 26, 26)], [4, 1, 1, 1, c(30, 26, 26)]] as Detail[] : [])],
      },
    });
    if (!kid) q.body.boxes.push(box([8, 7, 6], [0, q.bodyTop - 2.5, q.bodyFront + 2.5], p.fur, { top: p.back, pattern: 'shaggy' }));
    q.head.boxes.push(box([3, 3, kid ? 2.5 : 4], [0, q.headY - 1.5, q.headFront - (kid ? 1.25 : 2)], p.belly, { pattern: 'fur', face: [[1, 0, 1, 1, BLACK]], ...(angry ? { side: [[0, 2, kid ? 2 : 3, 1, WHITE]] } : {}) }));
    q.head.boxes.push(...both(box([2, 3, 1], [-2, q.headTop + 1.5, q.headZ + 1], p.back, { pattern: 'plain' })));
    if (l.flags & MobFlag.TAMED) q.body.boxes.push(collar(q, kid ? 5 : 8));
    q.body.children!.push(tail([0, q.bodyTop - 1, q.bodyBack], [2, kid ? 5 : 8, 2], p.fur, [-0.5, 0, 0], { pattern: 'fur', band: { rows: 2, color: p.back } }));
    return { bones: q.bones, scale: kid ? 0.62 : 1 };
  },
  animate(pose, s) {
    resetLifts(pose);
    const tamed = (s.flags & MobFlag.TAMED) !== 0;
    const angry = (s.flags & MobFlag.ANGRY) !== 0;
    if (s.flags & MobFlag.SITTING) {
      const kid = (s.flags & MobFlag.BABY) !== 0;
      sitPose(pose, kid ? 3 : 5, kid ? 5 : 8.5);
      set(pose, 'tail', -0.8, 0, Math.sin(s.t * 6) * (tamed ? 0.3 : 0));
      return;
    }
    set(pose, 'body', 0);
    walkLegs(pose, s, s.speed > 3 ? 1 : 0.75);
    if (s.anim & MobAnim.ATTACK) set(pose, 'head', -0.3 + Math.sin(s.t * 20) * 0.2);
    else headIdle(pose, s, 0.5);
    const wag = tamed && !angry ? Math.sin(s.t * 12) * 0.6 : 0;
    set(pose, 'tail', angry ? -1.0 : tamed ? -0.6 : 0, wag, 0);
  },
};

// --- Cat ------------------------------------------------------------------------------------

const CATS = [
  { fur: c(232, 146, 60), spot: c(176, 92, 30), pattern: 'stripes' as Pattern, eye: c(120, 200, 70), points: null as RGB | null },
  { fur: c(34, 32, 36), spot: c(24, 22, 26), pattern: 'fur' as Pattern, eye: c(236, 210, 60), points: null },
  { fur: c(150, 150, 154), spot: c(90, 90, 96), pattern: 'stripes' as Pattern, eye: c(120, 200, 70), points: null },
  { fur: c(244, 242, 238), spot: c(220, 218, 214), pattern: 'fur' as Pattern, eye: c(90, 160, 230), points: null },
  { fur: c(244, 240, 232), spot: c(220, 128, 50), pattern: 'patches' as Pattern, eye: c(236, 190, 60), points: null },
  { fur: c(232, 218, 190), spot: c(90, 64, 48), pattern: 'fur' as Pattern, eye: c(90, 160, 230), points: c(90, 64, 48) },
];

const cat: Species = {
  variants: range(6),
  lookFlags: MobFlag.BABY | MobFlag.TAMED,
  build(l) {
    const p = CATS[l.variant] ?? CATS[0];
    const kid = baby(l);
    const point = p.points ?? p.fur;
    const q = quad({
      legH: kid ? 4 : 6, legW: 2, legX: 1.5, legIn: [1.5, 1.5], sitter: true,
      leg: { color: p.fur, pattern: 'fur', band: p.points ? { rows: 3, color: p.points } : undefined },
      body: kid ? { w: 4, h: 4, l: 8, color: p.fur, pattern: p.pattern, spot: p.spot } : { w: 4, h: 5, l: 12, color: p.fur, pattern: p.pattern, spot: p.spot },
      head: {
        w: 5, h: 4, l: kid ? 4 : 5, dy: 3, dz: 1, color: p.fur, pattern: p.pattern === 'patches' ? 'patches' : 'fur', spot: p.spot,
        face: [[1, 1, 1, 1, p.eye], [3, 1, 1, 1, p.eye], ...(p.points ? [[1, 2, 3, 2, p.points] as Detail] : [])],
      },
    });
    q.head.boxes.push(box([3, 2, 1], [0, q.headY - 1, q.headFront - 0.5], p.points ?? c(Math.min(255, p.fur[0] * 270), Math.min(255, p.fur[1] * 270), Math.min(255, p.fur[2] * 270)), { pattern: 'plain', face: [[1, 0, 1, 1, PINK]] }));
    q.head.boxes.push(...both(box([1.5, 2, 1], [-1.75, q.headTop + 1, q.headZ - 0.5], point, { pattern: 'plain' })));
    if (l.flags & MobFlag.TAMED) q.body.boxes.push(collar(q, 4.5));
    const l1 = kid ? 5 : 8;
    const l2 = kid ? 4 : 6;
    const y1 = q.bodyTop - 1;
    const t2 = bone('tail2', [0, y1 + l1, q.bodyBack], [box([1, l2, 1], [0, y1 + l1 + l2 / 2, q.bodyBack], point, { pattern: 'fur' })], [], [-0.8, 0, 0]);
    const t1 = bone('tail', [0, y1, q.bodyBack], [box([1, l1, 1], [0, y1 + l1 / 2, q.bodyBack], p.pattern === 'stripes' ? p.fur : point, { pattern: p.pattern, spot: p.spot })], [t2], [1.2, 0, 0]);
    q.body.children!.push(t1);
    return { bones: q.bones, scale: kid ? 0.6 : 0.95 };
  },
  animate(pose, s) {
    resetLifts(pose);
    if (s.flags & MobFlag.SITTING) {
      const kid = (s.flags & MobFlag.BABY) !== 0;
      sitPose(pose, kid ? 2.5 : 4, kid ? 5 : 8.5);
      set(pose, 'tail', 0.8, Math.sin(s.t * 1.5 + s.seed) * 0.3, 0);
      return;
    }
    set(pose, 'body', 0);
    walkLegs(pose, s, s.speed > 2.5 ? 0.9 : 0.6);
    headIdle(pose, s, 0.4);
    set(pose, 'tail', s.speed > 2.5 ? 0.3 : 0, Math.sin(s.t * 1.1 + s.seed * 6) * 0.25, 0);
    set(pose, 'tail2', Math.sin(s.t * 1.7 + s.seed * 3) * 0.3);
  },
};

// --- Rabbit ---------------------------------------------------------------------------------

const RABBITS = [
  { fur: c(150, 112, 80), spot: c(120, 88, 62), pattern: 'fur' as Pattern },
  { fur: c(246, 246, 244), spot: c(230, 230, 228), pattern: 'fur' as Pattern },
  { fur: c(222, 190, 124), spot: c(196, 164, 100), pattern: 'fur' as Pattern },
  { fur: c(244, 242, 238), spot: c(40, 36, 38), pattern: 'patches' as Pattern },
];

const rabbit: Species = {
  variants: range(4),
  lookFlags: MobFlag.BABY,
  build(l) {
    const p = RABBITS[l.variant] ?? RABBITS[0];
    const inner = c(236, 170, 170);
    const eye = l.variant === 1 ? c(200, 60, 70) : BLACK;
    const head = bone('head', [0, 6, -2.5], [
      box([4, 4, 4], [0, 7.5, -4.5], p.fur, { pattern: p.pattern, spot: p.spot, face: [[0, 1, 1, 1, eye], [3, 1, 1, 1, eye], [1, 2, 2, 1, inner]] }),
    ], [
      bone('earL', [-1, 9.5, -4], [box([1, 5, 1], [-1, 12, -4], p.fur, { pattern: 'plain', face: [[0, 1, 1, 3, inner]] })], [], [0.15, 0, 0.12]),
      bone('earR', [1, 9.5, -4], [box([1, 5, 1], [1, 12, -4], p.fur, { pattern: 'plain', face: [[0, 1, 1, 3, inner]] })], [], [0.15, 0, -0.12]),
    ]);
    const body = bone('body', [0, 3, 1], [
      box([5, 5, 7], [0, 4.5, 0.5], p.fur, { pattern: p.pattern, spot: p.spot }),
      box([2, 2, 1.5], [0, 5.5, 4.6], WHITE, { pattern: 'fleece' }),
    ], [head]);
    const hind = (n: string, x: number) => bone(n, [x, 3, 2.5], [box([2, 3, 4], [x, 1.5, 2], p.fur, { pattern: 'fur' })]);
    const front = (n: string, x: number) => bone(n, [x, 3, -2], [box([1, 3, 1], [x, 1.5, -2], p.fur, { pattern: 'plain' })]);
    return { bones: [body, hind('legBL', -2), hind('legBR', 2), front('legFL', -1), front('legFR', 1)], scale: baby(l) ? 0.6 : 1 };
  },
  animate(pose, s) {
    // Hops: legs stretch and the body tips while in the air.
    const air = Math.max(-1, Math.min(1, s.vy / 5));
    const moving = s.speed > 0.3;
    set(pose, 'legBL', moving ? -air * 0.9 : 0);
    set(pose, 'legBR', moving ? -air * 0.9 : 0);
    set(pose, 'legFL', moving ? air * 0.6 : 0);
    set(pose, 'legFR', moving ? air * 0.6 : 0);
    set(pose, 'body', moving ? air * 0.25 : 0);
    headIdle(pose, s, 0.5);
    const twitch = Math.sin(s.t * 0.9 + s.seed * 30) > 0.95 ? 0.2 : 0;
    set(pose, 'earL', moving ? 0.5 : twitch);
    set(pose, 'earR', moving ? 0.5 : 0);
  },
};

// --- Fox ------------------------------------------------------------------------------------

const FOXES = [
  { fur: c(222, 112, 44), back: c(196, 92, 34), light: c(246, 240, 230), dark: c(40, 30, 28) },
  { fur: c(240, 236, 228), back: c(222, 216, 204), light: c(250, 250, 248), dark: c(80, 72, 70) },
];

const fox: Species = {
  variants: range(2),
  lookFlags: MobFlag.BABY,
  build(l) {
    const p = FOXES[l.variant] ?? FOXES[0];
    const kid = baby(l);
    const q = quad({
      legH: kid ? 4 : 6, legW: 2, legX: 2, legIn: [1.5, 1.5], sitter: true,
      leg: { color: p.fur, pattern: 'fur', band: { rows: kid ? 2 : 3, color: p.dark } },
      body: kid ? { w: 5, h: 5, l: 8, color: p.fur, top: p.back, pattern: 'fur' } : { w: 6, h: 6, l: 11, color: p.fur, top: p.back, pattern: 'fur' },
      head: {
        w: 6, h: 5, l: kid ? 4 : 5, dy: 3, dz: 1, color: p.fur, top: p.back, pattern: 'fur',
        face: [[1, 1, 1, 1, c(240, 170, 40)], [4, 1, 1, 1, c(240, 170, 40)], [0, 3, 2, 2, p.light], [4, 3, 2, 2, p.light]],
      },
    });
    q.body.boxes.push(box([4, 4, 1], [0, q.bodyTop - 3, q.bodyFront - 0.4], p.light, { pattern: 'fur' }));
    q.head.boxes.push(box([3, 2, kid ? 2 : 3], [0, q.headY - 1.5, q.headFront - (kid ? 1 : 1.5)], p.light, { pattern: 'fur', face: [[1, 0, 1, 1, BLACK]] }));
    q.head.boxes.push(...both(box([2, 3, 1], [-2, q.headTop + 1.5, q.headZ + 0.5], p.fur, { top: p.dark, pattern: 'plain', face: [[0, 0, 2, 1, p.dark]] })));
    const tl = kid ? 6 : 10;
    q.body.children!.push(bone('tail', [0, q.bodyTop - 2, q.bodyBack], [
      box([4, 4, tl], [0, q.bodyTop - 2.5, q.bodyBack + tl / 2], p.fur, { top: p.back, pattern: 'shaggy' }),
      box([4.2, 4.2, 2], [0, q.bodyTop - 2.5, q.bodyBack + tl + 0.9], p.light, { pattern: 'fleece' }),
    ], [], [0.35, 0, 0]));
    return { bones: q.bones, scale: kid ? 0.6 : 1 };
  },
  animate(pose, s) {
    resetLifts(pose);
    if (s.anim & MobAnim.SLEEP) {
      // Curled up: body down, legs tucked, head on the paws, tail around.
      lift(pose, 'body', -4);
      for (const n of ['legFL', 'legFR']) set(pose, n, -1.5);
      for (const n of ['legBL', 'legBR']) set(pose, n, 1.5);
      set(pose, 'body', 0);
      set(pose, 'head', -0.35, 0.5);
      set(pose, 'tail', 0.2, 1.2);
      return;
    }
    set(pose, 'body', 0);
    walkLegs(pose, s, 0.8);
    if (s.anim & MobAnim.ATTACK) set(pose, 'head', -0.4 + Math.sin(s.t * 20) * 0.2);
    else headIdle(pose, s, 0.5);
    set(pose, 'tail', s.speed > 2 ? 0.1 : 0, Math.sin(s.t * 1.2 + s.seed * 4) * 0.2);
  },
};

// --- Goat -----------------------------------------------------------------------------------

const GOATS = [
  { fur: c(238, 236, 230), dark: c(200, 196, 188), horn: c(120, 112, 100) },
  { fur: c(130, 90, 58), dark: c(36, 30, 28), horn: c(70, 62, 54) },
];

const goat: Species = {
  variants: range(2),
  lookFlags: MobFlag.BABY,
  build(l) {
    const p = GOATS[l.variant] ?? GOATS[0];
    const kid = baby(l);
    const q = quad({
      legH: kid ? 8 : 9, legW: kid ? 2 : 3, legX: kid ? 2 : 3, legIn: [2, 2],
      leg: { color: p.fur, pattern: 'shaggy', band: { rows: l.variant === 1 ? 4 : 1, color: p.dark } },
      body: kid ? { w: 6, h: 6, l: 8, color: p.fur, pattern: 'shaggy' } : { w: 8, h: 9, l: 13, color: p.fur, pattern: 'shaggy' },
      head: {
        w: 5, h: kid ? 5 : 6, l: kid ? 5 : 7, dy: 4, dz: 2, color: p.fur, pattern: 'fur',
        face: [[0, 2, 1, 1, c(230, 190, 60)], [4, 2, 1, 1, c(230, 190, 60)], ...(l.variant === 1 ? [[2, 0, 1, 6, p.dark] as Detail] : [])],
      },
    });
    if (!kid) {
      q.head.boxes.push(box([2, 3, 1], [0, q.headBottom - 1, q.headFront + 1], p.fur, { pattern: 'shaggy' }));
      q.head.boxes.push(...both(box([1, 4, 2], [-1.5, q.headTop + 2, q.headZ + 1.5], p.horn, { pattern: 'ribs' })));
      q.head.boxes.push(...both(box([1, 2, 3], [-1.5, q.headTop + 4, q.headZ + 3.5], p.horn, { pattern: 'ribs' })));
    }
    q.head.boxes.push(...both(box([3, 1, 2], [-3.5, q.headTop - 1.5, q.headZ + 2], p.fur)));
    q.body.children!.push(tail([0, q.bodyTop - 1, q.bodyBack], [2, 3, 1], p.fur, [-2.4, 0, 0]));
    return { bones: q.bones, scale: kid ? 0.6 : 1 };
  },
  animate(pose, s) {
    walkLegs(pose, s, s.anim & MobAnim.RAM ? 1 : 0.7);
    if (s.anim & MobAnim.RAM) set(pose, 'head', -0.9);
    else headIdle(pose, s, 1.0);
    set(pose, 'tail', Math.sin(s.t * 4 + s.seed * 2) * 0.2);
  },
};

export const SPECIES: Partial<Record<number, Species>> = {
  [Mob.COW]: cow,
  [Mob.SHEEP]: sheep,
  [Mob.PIG]: pig,
  [Mob.CHICKEN]: chicken,
  [Mob.HORSE]: horse,
  [Mob.WOLF]: wolf,
  [Mob.CAT]: cat,
  [Mob.RABBIT]: rabbit,
  [Mob.FOX]: fox,
  [Mob.GOAT]: goat,
};
