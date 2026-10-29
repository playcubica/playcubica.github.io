import { Mob, MobAnim, MobFlag } from '../../shared/entities/mobs';
import {
  baby, BLACK, bone, both, box, c, lift, quad, range, set, tail, walkLegs,
  type Bone, type Detail, type Pattern, type RGB, type Species,
} from './mobModels';

// Stage C creatures (see mobModels.ts for the conventions): fish in several species, an octopus, songbirds,
// bats, a sea turtle and a donkey.

const swimWave = (t: number, speed: number) => t * (5 + Math.min(4, speed) * 2.5);

// --- Fish: perch, salmon and four warm-water reef fish. --------------------------------------------

const FISH: Array<{ body: RGB; top: RGB; fin: RGB; pattern: Pattern; spot?: RGB }> = [
  { body: c(150, 160, 70), top: c(90, 110, 50), fin: c(230, 120, 40), pattern: 'stripes', spot: c(60, 70, 40) },
  { body: c(220, 150, 140), top: c(110, 120, 130), fin: c(150, 150, 160), pattern: 'spots', spot: c(70, 70, 80) },
  { body: c(250, 130, 40), top: c(250, 130, 40), fin: c(250, 250, 245), pattern: 'stripes', spot: c(250, 250, 245) },
  { body: c(50, 110, 220), top: c(30, 70, 170), fin: c(250, 220, 50), pattern: 'fur' },
  { body: c(250, 220, 60), top: c(240, 200, 40), fin: c(40, 40, 50), pattern: 'stripes', spot: c(40, 40, 50) },
  { body: c(190, 90, 200), top: c(150, 60, 170), fin: c(250, 170, 220), pattern: 'spots', spot: c(250, 200, 240) },
];

const fish: Species = {
  variants: range(6),
  lookFlags: 0,
  build(l) {
    const p = FISH[l.variant] ?? FISH[0];
    const tailFin = bone('tail', [0, 3, 4], [box([1, 4, 3], [0, 3, 5.5], p.fin, { pattern: 'ribs' })]);
    const body = bone('body', [0, 3, 0], [
      box([3, 4, 7], [0, 3, 0.5], p.body, { top: p.top, pattern: p.pattern, spot: p.spot, side: [[1, 1, 1, 1, BLACK], [0, 2, 1, 1, c(40, 30, 30)]] }),
      box([1, 1.5, 4], [0, 5.5, 0.5], p.fin, { pattern: 'ribs' }),
      ...both(box([0.5, 1, 1.5], [-1.7, 2, -1], p.fin, { pattern: 'plain' })),
    ], [tailFin]);
    return { bones: [body], scale: 1 };
  },
  animate(pose, s) {
    const f = swimWave(s.t + s.seed * 10, s.speed);
    set(pose, 'body', s.vy * 0.06, Math.sin(f) * 0.12, 0);
    set(pose, 'tail', 0, Math.sin(f - 1) * (s.anim & MobAnim.FLEE ? 0.9 : 0.5), 0);
  },
};

// --- Octopus: a soft mantle on eight curling arms. ---------------------------------------------------

const OCTOPI = [{ skin: c(200, 90, 64), spot: c(240, 150, 110) }, { skin: c(120, 100, 130), spot: c(170, 150, 180) }];

const octopus: Species = {
  variants: range(2),
  lookFlags: 0,
  build(l) {
    const p = OCTOPI[l.variant] ?? OCTOPI[0];
    const arms: Bone[] = [];
    // Eight arms spread out from under the mantle, each curling up at the tip.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const x = Math.cos(a) * 2.5;
      const z = Math.sin(a) * 2.5;
      const out = [Math.cos(a), Math.sin(a)];
      const tip = bone(`arm${i}b`, [x, 0, z], [box([1, 4, 1], [x, -2, z], p.skin, { pattern: 'spots', spot: p.spot })], [], [-out[1] * 0.9, 0, out[0] * 0.9]);
      arms.push(bone(`arm${i}`, [x, 4, z], [box([1.6, 4, 1.6], [x, 2, z], p.skin, { pattern: 'spots', spot: p.spot })], [tip], [-out[1] * 1.1, 0, out[0] * 1.1]));
    }
    const mantle = bone('mantle', [0, 5, 0], [
      box([7, 5, 7], [0, 6.5, 0], p.skin, { pattern: 'spots', spot: p.spot, side: [[2, 1, 2, 2, c(250, 230, 120)], [3, 1, 1, 2, BLACK]] }),
      box([6, 6, 6], [0, 11, 2], p.skin, { pattern: 'spots', spot: p.spot }),
    ], [], [-0.3, 0, 0]);
    return { bones: [bone('body', [0, 4, 0], [], [mantle, ...arms])], scale: 1 };
  },
  animate(pose, s) {
    const jet = (s.anim & MobAnim.FLEE) !== 0;
    for (let i = 0; i < 8; i++) {
      const w = Math.sin(s.t * 2.2 + i * 0.8 + s.seed * 9);
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      // Jetting: the arms sweep together behind; otherwise they ripple.
      const k = jet ? -0.8 : w * 0.25;
      // (-sin, cos) tips an arm outwards; negative k pulls it in.
      set(pose, `arm${i}`, -Math.sin(a) * k, 0, Math.cos(a) * k);
      set(pose, `arm${i}b`, -Math.sin(a) * w * 0.3, 0, Math.cos(a) * w * 0.3);
    }
    set(pose, 'mantle', jet ? 0.4 : Math.sin(s.t * 1.5 + s.seed) * 0.08);
    lift(pose, 'body', Math.sin(s.t * 1.5 + s.seed * 4) * 0.5);
  },
};

// --- Songbirds: robin, bluebird, sparrow, cardinal. ------------------------------------------------

const BIRDS: Array<{ back: RGB; breast: RGB; head: RGB; crest?: boolean; mask?: boolean }> = [
  { back: c(110, 90, 70), breast: c(230, 110, 50), head: c(90, 74, 60) },
  { back: c(60, 110, 210), breast: c(220, 130, 80), head: c(60, 110, 210) },
  { back: c(140, 110, 80), breast: c(200, 190, 170), head: c(120, 100, 80) },
  { back: c(200, 40, 40), breast: c(220, 50, 50), head: c(220, 50, 50), crest: true, mask: true },
];

const songbird: Species = {
  variants: range(4),
  lookFlags: 0,
  build(l) {
    const p = BIRDS[l.variant] ?? BIRDS[0];
    const beak = l.variant === 3 ? c(240, 140, 60) : c(60, 50, 40);
    const face: Detail[] = p.mask ? [[0, 1, 3, 2, BLACK], [0, 1, 1, 1, c(250, 250, 250)]] : [[0, 1, 1, 1, BLACK], [2, 1, 1, 1, BLACK]];
    const head = bone('head', [0, 4, -1.5], [
      box([3, 3, 3], [0, 5, -2.5], p.head, { pattern: 'feather', face }),
      box([1, 1, 1.5], [0, 4.6, -4.6], beak, { pattern: 'plain' }),
      ...(p.crest ? [box([1, 2, 2], [0, 7, -2], p.head, { pattern: 'plain' })] : []),
    ]);
    const wing = (n: string, x: number) => bone(n, [x, 4, -1], [box([0.6, 2, 4], [x, 3, 0.5], p.back, { pattern: 'feather' })]);
    const body = bone('body', [0, 2, 0], [
      box([3, 3, 5], [0, 3, 0], p.back, { pattern: 'feather', face: [[0, 1, 3, 2, p.breast]], top: p.back }),
      box([3.1, 1.6, 3], [0, 2.3, -0.8], p.breast, { pattern: 'fur' }),
      box([2, 0.6, 3], [0, 4, 3.5], p.back, { pattern: 'feather' }),
    ], [head, wing('wingL', -1.7), wing('wingR', 1.7)]);
    const leg = (n: string, x: number) => bone(n, [x, 1.5, 0.5], [box([0.5, 1.5, 0.5], [x, 0.75, 0.5], c(90, 70, 50), { pattern: 'plain' })]);
    return { bones: [body, leg('legL', -0.7), leg('legR', 0.7)], scale: 1 };
  },
  animate(pose, s) {
    const flying = s.speed > 2.2 || Math.abs(s.vy) > 1.5;
    const flap = flying ? Math.sin(s.t * 38 + s.seed * 9) * 1.1 : 0;
    set(pose, 'wingL', 0, 0, flying ? 0.6 + flap : 0);
    set(pose, 'wingR', 0, 0, flying ? -0.6 - flap : 0);
    set(pose, 'legL', flying ? 0.8 : 0);
    set(pose, 'legR', flying ? 0.8 : 0);
    set(pose, 'body', flying ? Math.max(-0.4, Math.min(0.4, s.vy * 0.1)) : 0);
    if (s.anim & MobAnim.EAT) set(pose, 'head', -0.9 + Math.sin(s.t * 20) * 0.2);
    else set(pose, 'head', 0, flying ? 0 : Math.sin(s.t * 1.7 + s.seed * 30) * 0.7);
  },
};

// --- Bat. -------------------------------------------------------------------------------------------------

const BATS = [{ fur: c(90, 64, 46), wing: c(60, 44, 36) }, { fur: c(96, 92, 92), wing: c(60, 58, 60) }];

const bat: Species = {
  variants: range(2),
  lookFlags: 0,
  build(l) {
    const p = BATS[l.variant] ?? BATS[0];
    const wing = (side: -1 | 1): Bone => {
      const n = side < 0 ? 'L' : 'R';
      const tip = bone(`tip${n}`, [side * 6, 6, 0], [box([4, 0.5, 4], [side * 8, 6, 0.5], p.wing, { pattern: 'ribs' })]);
      return bone(`wing${n}`, [side * 1.5, 6, 0], [box([4.5, 0.6, 4], [side * 3.75, 6, 0.5], p.wing, { pattern: 'ribs' })], [tip]);
    };
    const head = bone('head', [0, 7, 0], [
      box([3, 3, 3], [0, 8.5, -0.5], p.fur, { pattern: 'fur', face: [[0, 1, 1, 1, BLACK], [2, 1, 1, 1, BLACK]] }),
      ...both(box([1, 2, 1], [-1, 11, -0.5], p.fur, { pattern: 'plain' })),
    ]);
    const body = bone('body', [0, 5, 0], [
      box([3, 4, 3], [0, 5, 0.3], p.fur, { pattern: 'fur' }),
      ...both(box([0.6, 1.5, 0.6], [-0.8, 2.3, 0.3], c(40, 30, 26), { pattern: 'plain' })),
    ], [head, wing(-1), wing(1)]);
    return { bones: [body], scale: 1 };
  },
  animate(pose, s) {
    if (s.anim & MobAnim.SLEEP) {
      // Roosting: upside down, wings wrapped around.
      set(pose, 'body', 0, 0, Math.PI);
      lift(pose, 'body', 0.5);
      set(pose, 'wingL', 0, 0.2, -1.3);
      set(pose, 'wingR', 0, -0.2, 1.3);
      set(pose, 'tipL', 0, 0, -1.2);
      set(pose, 'tipR', 0, 0, 1.2);
      return;
    }
    lift(pose, 'body', 0);
    const flap = Math.sin(s.t * 30 + s.seed * 7);
    set(pose, 'body', 0.3, 0, Math.sin(s.t * 3 + s.seed) * 0.15);
    set(pose, 'wingL', 0, 0, flap * 0.9);
    set(pose, 'wingR', 0, 0, -flap * 0.9);
    set(pose, 'tipL', 0, 0, flap * 0.5);
    set(pose, 'tipR', 0, 0, -flap * 0.5);
  },
};

// --- Sea turtle. -----------------------------------------------------------------------------------------

const TURTLES = [{ shell: c(80, 110, 60), dark: c(50, 70, 40), skin: c(130, 150, 100) }, { shell: c(130, 100, 60), dark: c(90, 70, 40), skin: c(150, 140, 100) }];

const turtle: Species = {
  variants: range(2),
  lookFlags: MobFlag.BABY,
  build(l) {
    const p = TURTLES[l.variant] ?? TURTLES[0];
    const kid = baby(l);
    const flipper = (n: string, side: -1 | 1, z: number, len: number) =>
      bone(n, [side * 5.5, 2.5, z], [box([len, 1.2, 3], [side * (5.5 + len / 2), 2, z], p.skin, { pattern: 'fur' })], [], [0, side * (z < 0 ? -0.3 : 0.4), 0]);
    const body = bone('body', [0, 3, 0], [
      box([12, 4, 15], [0, 4, 0], p.shell, { top: p.dark, pattern: 'chitin' }),
      box([9, 2, 11], [0, 7, 0.5], p.dark, { pattern: 'chitin' }),
      box([11, 1.5, 13], [0, 1.8, 0], c(220, 210, 160), { pattern: 'chitin' }),
      box([2, 1.5, 2], [0, 3, 8.5], p.skin, { pattern: 'plain' }),
    ], [
      bone('head', [0, 4, -7], [box([4, 3.5, 5], [0, 4.5, -9], p.skin, { pattern: 'spots', spot: p.dark, face: [[0, 1, 1, 1, BLACK], [3, 1, 1, 1, BLACK]] })]),
    ]);
    return {
      bones: [body, flipper('legFL', -1, -4, 6), flipper('legFR', 1, -4, 6), flipper('legBL', -1, 5, 3.5), flipper('legBR', 1, 5, 3.5)],
      scale: kid ? 0.35 : 1,
    };
  },
  animate(pose, s) {
    const k = Math.min(1, s.speed / 1.2);
    const swim = s.speed > 1.4;
    const a = Math.sin(s.walk * (swim ? 0.6 : 1));
    // Swimming: front flippers sweep up and down together; on land they paddle in turn.
    set(pose, 'legFL', 0, swim ? 0 : a * 0.5 * k, swim ? a * 0.7 : 0);
    set(pose, 'legFR', 0, swim ? 0 : a * 0.5 * k, swim ? -a * 0.7 : 0);
    set(pose, 'legBL', 0, -a * 0.4 * k, 0);
    set(pose, 'legBR', 0, a * 0.4 * k, 0);
    set(pose, 'head', Math.sin(s.t * 0.6 + s.seed) * 0.1, Math.sin(s.t * 0.4 + s.seed * 5) * 0.3);
  },
};

// --- Donkey: stocky, long-eared, a dark stripe down its back (a horse's moves). ---------------------

const DONKEYS = [{ coat: c(140, 134, 128), light: c(220, 214, 206), dark: c(70, 64, 60) }, { coat: c(120, 90, 66), light: c(214, 196, 170), dark: c(60, 44, 34) }];

const donkey: Species = {
  variants: range(2),
  lookFlags: MobFlag.BABY | MobFlag.SADDLED,
  build(l) {
    const p = DONKEYS[l.variant] ?? DONKEYS[0];
    const kid = baby(l);
    const q = quad({
      legH: kid ? 9 : 10, legW: 3, legX: kid ? 2.5 : 3.5, legIn: [2.5, 2.5],
      leg: { color: p.coat, pattern: 'fur', band: { rows: 2, color: p.light } },
      body: kid ? { w: 7, h: 7, l: 12, color: p.coat, top: p.dark, pattern: 'fur' } : { w: 10, h: 10, l: 19, color: p.coat, top: p.dark, pattern: 'fur' },
      head: { w: 1, h: 1, l: 1, dy: 0, dz: 0, color: p.coat },
    });
    for (const b of q.bones) if (b.name.startsWith('leg')) b.boxes.push(box([3.4, 1.4, 3.4], [b.pivot[0], 0.7, b.pivot[2]], c(40, 34, 30), { pattern: 'plain' }));
    q.body.children = [];
    const nl = kid ? 7 : 9;
    const pivot: Bone['pivot'] = [0, q.bodyTop - 2, q.bodyFront + 2.5];
    const hy = pivot[1] + nl - 1;
    const hl = kid ? 7 : 9;
    const head = bone('head', [0, hy, pivot[2]], [
      box([5, 5, hl], [0, hy, pivot[2] - 3], p.coat, { pattern: 'fur', face: [[0, 2, 5, 3, p.light], [1, 3, 1, 1, BLACK], [3, 3, 1, 1, BLACK]], side: [[3, 1, 1, 1, BLACK]] }),
      ...both(box([1.5, kid ? 4 : 6, 1.2], [-1.5, hy + (kid ? 4.5 : 5.5), pivot[2] - 0.5], p.coat, { pattern: 'plain', face: [[0, 1, 1, 3, p.light]] })),
    ], [], [-0.3, 0, 0]);
    const neck = bone('neck', pivot, [
      box([5, nl, 6], [0, pivot[1] + nl / 2, pivot[2] - 1], p.coat, { pattern: 'fur' }),
      box([1.5, nl, 2], [0, pivot[1] + nl / 2 + 1, pivot[2] + 2.2], p.dark, { pattern: 'shaggy' }),
    ], [head], [-0.5, 0, 0]);
    q.body.children.push(neck, tail([0, q.bodyTop - 1, q.bodyBack], [1.5, kid ? 6 : 9, 1.5], p.coat, [-0.3, 0, 0], { band: { rows: 3, color: p.dark } }));
    if (l.flags & MobFlag.SADDLED && !kid) {
      q.body.boxes.push(
        box([10.6, 1.5, 8], [0, q.bodyTop + 0.5, q.bodyFront + 8], c(120, 72, 40), { pattern: 'plain' }),
        box([10.8, 4, 0.8], [0, q.bodyTop - 2, q.bodyFront + 7], c(60, 40, 26), { pattern: 'plain' }),
      );
    }
    return { bones: q.bones, scale: kid ? 0.62 : 1 };
  },
  animate(pose, s) {
    walkLegs(pose, s, s.speed > 4 ? 0.9 : 0.6);
    const eat = (s.anim & MobAnim.EAT) !== 0;
    set(pose, 'neck', eat ? -1.0 : Math.sin(s.walk * 2) * 0.05, s.speed < 0.2 && !eat ? Math.sin(s.t * 0.4 + s.seed * 17) * 0.25 : 0);
    set(pose, 'head', eat ? -0.3 + Math.sin(s.t * 12) * 0.05 : 0);
    set(pose, 'tail', Math.sin(s.t * 1.3 + s.seed * 5) * 0.1, 0, Math.sin(s.t * 2.1 + s.seed * 3) * 0.3);
  },
};

export const WILDLIFE: Partial<Record<number, Species>> = {
  [Mob.FISH]: fish,
  [Mob.OCTOPUS]: octopus,
  [Mob.SONGBIRD]: songbird,
  [Mob.BAT]: bat,
  [Mob.TURTLE]: turtle,
  [Mob.DONKEY]: donkey,
};
