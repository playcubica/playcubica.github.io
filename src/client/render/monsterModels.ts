import { Mob, MobAnim } from '../../shared/entities/mobs';
import {
  BLACK, bone, both, box, c, lift, set, SPECIES, walkLegs,
  type AnimState, type Bone, type Box, type Pose, type RGB, type Species,
} from './mobModels';

// Cubica's monsters and traders as rigs (see mobModels.ts for the conventions). Each has its own
// silhouette and moves: the shambling gloomwalker, the bobbing thornslinger, the eight-legged
// skitterling, the waddling sporecap, the flapping duskwing, the waving mirefin, the shell-curling
// cragback, the floating shade, the slamming bramblehulk, scuttling ember mites, and the matriarch.

const glowEye = (x: number, y: number, z: number, color: RGB, w = 1, h = 1): Box[] =>
  both(box([w, h, 0.3], [-x, y, z], color, { glow: true, pattern: 'plain' }));

interface HumanoidSpec {
  legH: number;
  legW: number;
  body: [number, number, number];
  arm: [number, number];
  head: [number, number, number];
  leg: Partial<Box> & { color: RGB };
  torso: Partial<Box> & { color: RGB };
  sleeve: Partial<Box> & { color: RGB };
  face: Partial<Box> & { color: RGB };
  /** Resting arm angle (forward is positive). */
  armRest?: number;
}

/** Two legs, a torso holding the arms and head. Bones: legL, legR, body, armL, armR, head. */
function humanoid(h: HumanoidSpec): { bones: Bone[]; body: Bone; head: Bone } {
  const [bw, bh, bd] = h.body;
  const [aw, al] = h.arm;
  const top = h.legH + bh;
  const head = bone('head', [0, top, 0], [box(h.head, [0, top + h.head[1] / 2, 0], h.face.color, h.face)]);
  const arm = (n: string, x: number) => bone(n, [x, top - 1.5, 0], [box([aw, al, aw], [x, top - al / 2, 0], h.sleeve.color, h.sleeve)], [], [h.armRest ?? 0, 0, 0]);
  const body = bone('body', [0, h.legH, 0], [box([bw, bh, bd], [0, h.legH + bh / 2, 0], h.torso.color, h.torso)], [
    head, arm('armL', -(bw + aw) / 2), arm('armR', (bw + aw) / 2),
  ]);
  const leg = (n: string, x: number) => bone(n, [x, h.legH, 0], [box([h.legW, h.legH, h.legW], [x, h.legH / 2, 0], h.leg.color, h.leg)]);
  return { bones: [body, leg('legL', -h.legW / 2), leg('legR', h.legW / 2)], body, head };
}

function walk2(pose: Pose, s: AnimState, amp = 0.8): number {
  const k = Math.min(1, s.speed / 1.6) * amp;
  const a = Math.sin(s.walk) * k;
  set(pose, 'legL', a);
  set(pose, 'legR', -a);
  return a;
}

const monster = (build: Species['build'], animate: Species['animate'], variants = [0]): Species => ({ build, animate, lookFlags: 0, variants });

// --- Gloomwalker: a shambling figure in dark rags, arms reaching, eyes burning. ---------------

const GLOOM = { rag: c(76, 66, 92), dark: c(42, 34, 52), skin: c(92, 108, 102), boot: c(26, 22, 30) };

const gloomwalker = monster(() => {
  const h = humanoid({
    legH: 12, legW: 4, body: [8, 12, 4], arm: [3, 15], head: [8, 8, 8], armRest: 1.45,
    leg: { color: c(56, 48, 68), pattern: 'rags', band: { rows: 2, color: GLOOM.boot } },
    torso: { color: GLOOM.rag, pattern: 'rags' },
    sleeve: { color: c(68, 58, 82), pattern: 'rags', band: { rows: 3, color: GLOOM.skin } },
    face: { color: GLOOM.skin, top: GLOOM.dark, pattern: 'fur', face: [[2, 5, 4, 1, c(30, 24, 30)], [1, 2, 6, 1, c(60, 70, 66)]] },
  });
  h.body.boxes.push(box([8.4, 1, 4.4], [0, 13, 0], GLOOM.dark, { pattern: 'plain' }));
  h.head.boxes.push(
    box([9, 3, 9], [0, 33.5, 0.2], GLOOM.dark, { pattern: 'rags' }),
    box([9, 7, 2], [0, 29, 3.6], GLOOM.dark, { pattern: 'rags' }),
    ...glowEye(2, 29, -4.15, c(255, 216, 80), 2, 1),
  );
  return { bones: h.bones, scale: 1 };
}, (pose, s) => {
  const a = walk2(pose, s, 0.7);
  const hit = s.anim & MobAnim.ATTACK ? Math.sin(s.t * 18) * 0.5 : 0;
  set(pose, 'armL', -a * 0.25 + hit + Math.sin(s.t * 1.3 + s.seed) * 0.05);
  set(pose, 'armR', a * 0.25 - hit + Math.sin(s.t * 1.1 + s.seed * 3) * 0.05);
  set(pose, 'body', Math.min(1, s.speed / 2) * -0.12, 0, Math.sin(s.walk) * 0.06);
  set(pose, 'head', 0.1, Math.sin(s.t * 0.6 + s.seed * 9) * 0.3, Math.sin(s.t * 0.9) * 0.12);
});

// --- Thornslinger: a walking cactus-like bulb with a crimson maw and a flower. -----------------

const thornslinger = monster(() => {
  const spine = c(236, 226, 156);
  const spines: Box[] = [
    [-6.5, 11, 0, 1, 1, 3], [6.5, 7, 2, 1, 1, 3], [-3, 15.5, 5, 3, 1, 1], [3, 6, 6.5, 1, 3, 1], [6.5, 12, -3, 1, 1, 3],
    [-6.5, 6, -3, 1, 1, 3], [2, 10, 6.5, 1, 1, 1], [-4, 8, -6.4, 1, 1, 0.5],
  ].map(([x, y, z, w, h, d]) => box([w, h, d], [x, y, z], spine, { pattern: 'plain' }));
  const body = bone('body', [0, 3, 0], [
    box([12, 12, 12], [0, 9, 0], c(76, 140, 64), { pattern: 'ribs', face: [[3, 6, 6, 3, c(116, 20, 26)], [4, 6, 4, 1, c(240, 230, 210)]] }),
    box([10, 2, 10], [0, 16, 0], c(52, 108, 46), { pattern: 'ribs' }),
    ...glowEye(2.5, 12.5, -6.15, c(240, 230, 80)),
    ...spines,
  ], [
    bone('flower', [0, 17, 0], [
      box([4, 2, 4], [0, 18, 0], c(230, 100, 140), { pattern: 'spots', spot: c(255, 216, 100) }),
      box([2, 1, 2], [0, 19.5, 0], c(255, 220, 90), { pattern: 'plain' }),
    ]),
  ]);
  const leg = (n: string, x: number, z: number) => bone(n, [x, 3, z], [box([2, 3, 2], [x, 1.5, z], c(108, 76, 46), { pattern: 'fur' })]);
  return { bones: [body, leg('legFL', -3, -3), leg('legFR', 3, -3), leg('legBL', -3, 3), leg('legBR', 3, 3)], scale: 1 };
}, (pose, s) => {
  walkLegs(pose, s, 0.9);
  lift(pose, 'body', Math.abs(Math.sin(s.walk)) * Math.min(1, s.speed) * 0.8 + Math.sin(s.t * 2 + s.seed * 5) * 0.2);
  set(pose, 'body', s.anim & MobAnim.ATTACK ? -0.25 : 0);
  set(pose, 'flower', 0, s.t * 0.6, 0);
});

// --- Skitterling: low teal crawler with eight jointed legs and four red eyes. -------------------

const skitterling = monster(() => {
  const shell = c(36, 76, 76);
  const legC = c(26, 52, 52);
  const legs: Bone[] = [];
  [-4, -1.5, 1.5, 4].forEach((z, i) => {
    for (const side of [-1, 1]) {
      const name = `leg${side < 0 ? 'L' : 'R'}${i}`;
      const tip = side * 9;
      const lower = bone(`${name}b`, [tip, 5.5, z], [box([1, 6, 1], [tip, 3, z], legC, { pattern: 'chitin' })], [], [0, 0, side * -0.35]);
      // Knees up, feet down: the upper segment rises outwards, the lower one hangs straight.
      legs.push(bone(name, [side * 3.5, 5.5, z], [box([5.5, 1.2, 1.2], [side * 6.25, 5.5, z], legC, { pattern: 'chitin' })], [lower], [0, 0, side * 0.35]));
    }
  });
  const body = bone('body', [0, 5, 0], [
    box([8, 5, 9], [0, 6, 0], shell, { pattern: 'chitin' }),
    box([9, 5, 8], [0, 6.8, 8], c(30, 66, 68), { pattern: 'spots', spot: c(128, 38, 38) }),
  ], [
    bone('head', [0, 6, -4.5], [
      box([6, 4, 4], [0, 6, -6.5], c(30, 64, 66), { pattern: 'chitin' }),
      ...both(box([1, 1.5, 2], [-1.5, 4, -9], c(20, 36, 36), { pattern: 'plain' })),
      ...glowEye(1.1, 7, -8.6, c(255, 60, 50)),
      ...glowEye(2.4, 6.2, -8.6, c(255, 60, 50)),
    ]),
  ]);
  return { bones: [body, ...legs], scale: 1 };
}, (pose, s) => {
  const k = Math.min(1, s.speed / 1.5);
  for (let i = 0; i < 4; i++) {
    for (const side of ['L', 'R']) {
      const ph = s.walk * 1.6 + i * Math.PI / 2 + (side === 'L' ? 0 : Math.PI);
      set(pose, `leg${side}${i}`, 0, Math.sin(ph) * 0.45 * k, Math.max(0, Math.cos(ph)) * 0.35 * k * (side === 'L' ? -1 : 1));
    }
  }
  lift(pose, 'body', Math.sin(s.walk * 3.2) * 0.3 * k);
  set(pose, 'head', s.anim & MobAnim.ATTACK ? -0.3 : 0, Math.sin(s.t * 3 + s.seed * 9) * 0.1);
});

// --- Sporecap: a walking toadstool; its cap swells before it bursts. ----------------------------

const sporecap = monster(() => {
  const glow = c(100, 255, 230);
  const cap = bone('cap', [0, 11, 0], [
    box([14, 5, 14], [0, 13.5, 0], c(116, 56, 142), { pattern: 'spots', spot: c(204, 178, 220) }),
    box([10, 2, 10], [0, 17, 0], c(128, 66, 152), { pattern: 'spots', spot: c(204, 178, 220) }),
    box([2, 0.6, 2], [-3, 18.3, -2], glow, { glow: true, pattern: 'plain' }),
    box([2, 0.6, 2], [3, 18.3, 2], glow, { glow: true, pattern: 'plain' }),
    box([0.6, 2, 2], [-7.3, 14, 3], glow, { glow: true, pattern: 'plain' }),
    box([0.6, 2, 2], [7.3, 14, -3], glow, { glow: true, pattern: 'plain' }),
  ]);
  const body = bone('body', [0, 2, 0], [
    box([6, 9, 6], [0, 6.5, 0], c(220, 204, 174), { pattern: 'ribs', face: [[1, 2, 1, 2, BLACK], [4, 2, 1, 2, BLACK], [2, 5, 2, 1, c(120, 90, 80)]] }),
    box([9, 1, 9], [0, 10.5, 0], c(196, 176, 150), { pattern: 'ribs' }),
  ], [cap]);
  const leg = (n: string, x: number) => bone(n, [x, 2, 0], [box([2, 2, 3], [x, 1, -0.5], c(190, 176, 148), { pattern: 'plain' })]);
  return { bones: [body, leg('legL', -1.8), leg('legR', 1.8)], scale: 1 };
}, (pose, s) => {
  walk2(pose, s, 1);
  set(pose, 'body', 0, 0, Math.sin(s.walk) * 0.12 * Math.min(1, s.speed));
  const fuse = (s.anim & MobAnim.FUSE) !== 0;
  pose.get('cap')?.obj.scale.setScalar(fuse ? 1 + Math.abs(Math.sin(s.t * 11)) * 0.18 : 1 + Math.sin(s.t * 1.5 + s.seed * 7) * 0.02);
  set(pose, 'cap', 0, s.t * 0.15, 0);
});

// --- Trader: settlement folk in long robes and wide hats (robe colour by profession). ----------

const ROBES: RGB[] = [c(90, 140, 64), c(116, 84, 62), c(108, 66, 154)];
const SKIN = c(216, 172, 132);
const WHITE_EYE = c(240, 238, 230);

const trader = monster((l) => {
  const robe = ROBES[l.variant] ?? ROBES[0];
  const leather = c(92, 62, 36);
  const head = bone('head', [0, 20, 0], [
    box([8, 8, 8], [0, 24, 0], SKIN, { pattern: 'plain', face: [[1, 3, 2, 1, WHITE_EYE], [5, 3, 2, 1, WHITE_EYE], [2, 3, 1, 1, BLACK], [5, 3, 1, 1, BLACK], [1, 2, 6, 1, c(92, 62, 40)], [2, 6, 4, 1, c(150, 90, 80)]] }),
    box([2, 3, 1.5], [0, 23, -4.6], c(196, 146, 108), { pattern: 'plain' }),
    box([11, 1, 11], [0, 28.5, 0], c(78, 56, 36), { pattern: 'cloth' }),
    box([7, 3, 7], [0, 30.5, 0], c(78, 56, 36), { pattern: 'cloth', band: { rows: 1, color: robe } }),
  ]);
  const arm = (n: string, x: number) => bone(n, [x, 19, 0], [box([3, 11, 3], [x, 14.5, 0], robe, { pattern: 'cloth', band: { rows: 2, color: SKIN } })]);
  const body = bone('body', [0, 0, 0], [
    box([8, 20, 6], [0, 10, 0], robe, { pattern: 'cloth', band: { rows: 2, color: c(52, 38, 26) } }),
    box([8.4, 1.5, 6.4], [0, 12, 0], leather, { pattern: 'plain' }),
    box([2, 2, 0.6], [0, 12, -3.4], c(216, 184, 76), { pattern: 'plain' }),
  ], [head, arm('armL', -5.5), arm('armR', 5.5)]);
  return { bones: [body], scale: 1 };
}, (pose, s) => {
  const k = Math.min(1, s.speed / 1.4);
  const a = Math.sin(s.walk) * 0.5 * k;
  set(pose, 'armL', a);
  set(pose, 'armR', -a);
  set(pose, 'body', 0, 0, Math.sin(s.walk) * 0.04 * k);
  set(pose, 'head', Math.sin(s.t * 0.7 + s.seed * 4) * 0.08, Math.sin(s.t * 0.4 + s.seed * 11) * 0.5);
}, [0, 1, 2]);

// --- Duskwing: membrane-winged night flier. -------------------------------------------------------

const duskwing = monster(() => {
  const fur = c(58, 46, 70);
  const wing = c(92, 70, 112);
  const eye = c(220, 190, 255);
  const wingBone = (side: -1 | 1): Bone => {
    const n = side < 0 ? 'L' : 'R';
    const tip = bone(`tip${n}`, [side * 11, 6, -1], [box([7, 0.6, 7], [side * 14.5, 6, 0.5], wing, { pattern: 'ribs', top: c(72, 54, 90) })]);
    return bone(`wing${n}`, [side * 3, 6, -1], [box([8, 0.8, 8], [side * 7, 6, 0], wing, { pattern: 'ribs', top: c(72, 54, 90) })], [tip]);
  };
  const head = bone('head', [0, 5.5, -4.5], [
    box([5, 4, 4], [0, 6, -6.5], fur, { pattern: 'fur', face: [[1, 3, 1, 1, c(240, 236, 230)], [3, 3, 1, 1, c(240, 236, 230)]] }),
    ...both(box([1.5, 3, 1], [-1.75, 9.5, -6], fur, { pattern: 'plain' })),
    ...glowEye(1.2, 6.5, -8.6, eye),
  ]);
  const body = bone('body', [0, 5, 0], [
    box([6, 4, 9], [0, 5, 0], fur, { pattern: 'fur' }),
    ...both(box([1, 2, 1], [-1.5, 2.5, 2], c(40, 32, 48), { pattern: 'plain' })),
  ], [head, wingBone(-1), wingBone(1), bone('tail', [0, 5, 4.5], [box([2, 1, 6], [0, 5, 7.5], wing, { pattern: 'ribs' })])]);
  return { bones: [body], scale: 1 };
}, (pose, s) => {
  const dive = (s.anim & MobAnim.DASH) !== 0;
  const beat = dive ? 0 : Math.sin(s.t * (s.vy > 0.5 ? 16 : 10) + s.seed * 6);
  const fold = dive ? 0.25 : 0;
  set(pose, 'wingL', 0, dive ? -0.9 : 0, beat * 0.8 + fold);
  set(pose, 'wingR', 0, dive ? 0.9 : 0, -beat * 0.8 - fold);
  set(pose, 'tipL', 0, 0, beat * 0.4);
  set(pose, 'tipR', 0, 0, -beat * 0.4);
  set(pose, 'body', dive ? -0.5 : Math.max(-0.3, Math.min(0.3, s.vy * 0.08)));
  set(pose, 'tail', Math.sin(s.t * 3) * 0.15);
  set(pose, 'head', s.anim & MobAnim.ATTACK ? -0.4 : 0, Math.sin(s.t * 1.2 + s.seed * 5) * 0.2);
});

// --- Mirefin: an eel with a glowing lure; its body waves as it swims. -----------------------------

const mirefin = monster(() => {
  const skin = c(56, 84, 60);
  const belly = c(160, 170, 120);
  const fin = c(90, 120, 80);
  const tail = bone('tail', [0, 4, 12.5], [box([1, 6, 5], [0, 4, 15], fin, { pattern: 'ribs' })]);
  const seg3 = bone('seg3', [0, 4, 6.5], [box([3, 3, 6], [0, 4, 9.5], skin, { pattern: 'spots', spot: c(36, 56, 40) }), box([0.6, 1.5, 5], [0, 6, 9.5], fin, { pattern: 'ribs' })], [tail]);
  const seg2 = bone('seg2', [0, 4, 0.5], [box([4, 4, 6], [0, 4, 3.5], skin, { pattern: 'spots', spot: c(36, 56, 40) }), box([0.6, 2, 6], [0, 7, 3.5], fin, { pattern: 'ribs' })], [seg3]);
  const lure = bone('lure', [0, 6.5, -7], [
    box([1, 1, 5], [0, 7.5, -9], c(70, 90, 70), { pattern: 'plain' }),
    box([2, 2, 2], [0, 7.5, -12], c(255, 240, 140), { glow: true, pattern: 'plain' }),
  ], [], [0.35, 0, 0]);
  const head = bone('head', [0, 4, -5.5], [
    box([6, 5, 7], [0, 4, -9], skin, { top: c(46, 70, 50), pattern: 'spots', spot: c(36, 56, 40), face: [[0, 3, 6, 1, c(232, 228, 210)], [1, 4, 4, 1, c(40, 16, 18)]] }),
    ...glowEye(2.2, 5.5, -12.6, c(250, 220, 90)),
  ], [lure]);
  const seg1 = bone('seg1', [0, 4, -5.5], [box([5, 5, 6], [0, 4, -2.5], skin, { top: c(46, 70, 50), pattern: 'spots', spot: c(36, 56, 40) }), box([5.2, 1, 6], [0, 1.6, -2.5], belly, { pattern: 'plain' })], [head, seg2]);
  return { bones: [seg1], scale: 1 };
}, (pose, s) => {
  const k = 0.25 + Math.min(1, s.speed / 3) * 0.35;
  const f = s.t * (4 + s.speed * 1.5);
  set(pose, 'seg1', s.vy * 0.05, Math.sin(f) * k * 0.4, 0);
  set(pose, 'seg2', 0, Math.sin(f - 0.9) * k, 0);
  set(pose, 'seg3', 0, Math.sin(f - 1.8) * k, 0);
  set(pose, 'tail', 0, Math.sin(f - 2.7) * k * 1.2, 0);
  set(pose, 'head', s.anim & MobAnim.ATTACK ? -0.3 : Math.sin(f + 0.9) * 0.06, -Math.sin(f) * k * 0.3);
  set(pose, 'lure', Math.sin(s.t * 2.2) * 0.12);
});

// --- Cragback: a slow crawler under a mossy stone shell; curls up when struck in the face. ------

const cragback = monster(() => {
  const stone = c(118, 114, 108);
  const moss = c(84, 116, 60);
  const skin = c(120, 104, 86);
  const legs: Bone[] = [];
  for (const [n, z] of [['F', -5], ['M', 0], ['B', 5]] as const) {
    for (const side of [-1, 1]) legs.push(bone(`leg${n}${side < 0 ? 'L' : 'R'}`, [side * 6, 4, z], [box([3, 4, 3], [side * 6, 2, z], skin, { pattern: 'chitin', band: { rows: 1, color: c(70, 60, 50) } })]));
  }
  const spikes = [[-3, 12.5, -2], [3, 12.5, 2], [0, 12.5, 5], [-4, 12, 5], [4, 12, -4]].map(([x, y, z]) => box([2, 2, 2], [x, y, z], c(150, 146, 138), { pattern: 'plain' }));
  const body = bone('body', [0, 4, 0], [
    box([14, 8, 16], [0, 8, 0], stone, { top: moss, pattern: 'chitin' }),
    box([15, 2, 17], [0, 4.5, 0], c(90, 86, 80), { pattern: 'chitin' }),
    box([3, 2, 3], [0, 5, 9], skin, { pattern: 'plain' }),
    ...spikes,
  ], [
    bone('head', [0, 6, -7], [
      box([6, 5, 5], [0, 6, -9.5], skin, { pattern: 'chitin', face: [[1, 1, 1, 1, c(240, 200, 60)], [4, 1, 1, 1, c(240, 200, 60)]] }),
      box([4, 2, 2], [0, 4.5, -12.5], c(60, 52, 46), { pattern: 'plain' }),
    ]),
  ]);
  return { bones: [body, ...legs], scale: 1 };
}, (pose, s) => {
  const curled = (s.anim & MobAnim.STUN) !== 0;
  const k = curled ? 0 : Math.min(1, s.speed / 1.2) * 0.6;
  const a = Math.sin(s.walk) * k;
  for (const [n, sign] of [['FL', 1], ['MR', 1], ['BL', 1], ['FR', -1], ['ML', -1], ['BR', -1]] as const) {
    set(pose, `leg${n}`, a * sign);
    lift(pose, `leg${n}`, curled ? 3 : 0);
  }
  lift(pose, 'body', curled ? -2.5 : 0);
  lift(pose, 'head', curled ? -1 : 0, curled ? 4 : 0);
  set(pose, 'head', s.anim & MobAnim.ATTACK ? -0.3 : 0, curled ? 0 : Math.sin(s.t * 0.5 + s.seed * 8) * 0.35);
});

// --- Shade: a floating hooded wraith with long pale hands (drawn see-through by the renderer). ---

const shade = monster(() => {
  const cloth = c(34, 30, 44);
  const hand = c(196, 204, 214);
  const arm = (n: string, x: number) => bone(n, [x, 22, 0], [box([3, 16, 3], [x, 14.5, 0], cloth, { pattern: 'rags', band: { rows: 3, color: hand } })]);
  const head = bone('head', [0, 23, 0], [
    box([9, 9, 9], [0, 27.5, 0], cloth, { pattern: 'rags', face: [[1, 2, 7, 6, c(6, 6, 10)]] }),
    ...glowEye(1.8, 28, -4.65, c(150, 236, 255), 1.5, 1),
  ]);
  const body = bone('body', [0, 8, 0], [
    box([8, 10, 6], [0, 18, 0], cloth, { pattern: 'rags' }),
    box([10, 9, 7], [0, 9.5, 0], c(28, 24, 38), { pattern: 'rags' }),
    box([11, 3, 8], [0, 5.5, 0], c(22, 20, 30), { pattern: 'rags' }),
  ], [head, arm('armL', -5.5), arm('armR', 5.5)]);
  return { bones: [body], scale: 1 };
}, (pose, s) => {
  lift(pose, 'body', 2 + Math.sin(s.t * 2 + s.seed * 6) * 1.2);
  const reach = s.anim & MobAnim.ATTACK ? 1.4 : 0.15 + Math.min(1, s.speed / 2) * 0.5;
  set(pose, 'armL', reach + Math.sin(s.t * 1.7) * 0.1, 0, 0.08);
  set(pose, 'armR', reach + Math.sin(s.t * 1.5 + 1) * 0.1, 0, -0.08);
  set(pose, 'body', Math.min(1, s.speed / 2) * -0.15, 0, Math.sin(s.t * 1.3 + s.seed) * 0.05);
  set(pose, 'head', 0.1, Math.sin(s.t * 0.8 + s.seed * 3) * 0.3);
});

// --- Bramblehulk: a giant of rock and roots with a glowing core in its back. ----------------------

const bramblehulk = monster(() => {
  const rock = c(108, 104, 98);
  const moss = c(80, 110, 56);
  const root = c(96, 66, 40);
  const core = c(255, 160, 60);
  const arm = (n: string, x: number) => bone(n, [x, 28, 0], [
    box([7, 22, 7], [x, 18, 0], rock, { pattern: 'chitin', band: { rows: 4, color: c(80, 76, 72) } }),
    box([7.4, 2, 7.4], [x, 22, 0], root, { pattern: 'fur' }),
    box([8, 5, 9], [x, 29, 0], rock, { top: moss, pattern: 'chitin' }),
  ]);
  const head = bone('head', [0, 32, -2], [
    box([8, 7, 7], [0, 35, -3], rock, { top: moss, pattern: 'chitin', face: [[1, 4, 6, 1, c(40, 34, 30)]] }),
    ...glowEye(2, 36, -6.65, c(150, 255, 110), 2, 1),
  ]);
  const body = bone('body', [0, 14, 0], [
    box([18, 18, 10], [0, 23, 0], rock, { top: moss, pattern: 'chitin' }),
    box([18.6, 2, 10.6], [0, 17, 0], root, { pattern: 'fur' }),
    box([18.6, 2, 10.6], [0, 28, 0], root, { pattern: 'fur' }),
    box([6, 6, 1], [0, 23, 5.4], core, { glow: true, pattern: 'plain' }),
    box([2, 3, 2], [-6, 33, 2], c(70, 100, 50), { pattern: 'plain' }),
    box([2, 2, 2], [5, 32.5, 3], c(70, 100, 50), { pattern: 'plain' }),
  ], [head, arm('armL', -12.5), arm('armR', 12.5)]);
  const leg = (n: string, x: number) => bone(n, [x, 14, 0], [box([6, 14, 6], [x, 7, 0], rock, { pattern: 'chitin', band: { rows: 2, color: c(76, 72, 68) } })]);
  return { bones: [body, leg('legL', -5), leg('legR', 5)], scale: 1 };
}, (pose, s) => {
  const a = walk2(pose, s, 0.45);
  const windup = (s.anim & MobAnim.WINDUP) !== 0;
  if (windup) {
    set(pose, 'armL', 2.7, 0, 0.15);
    set(pose, 'armR', 2.7, 0, -0.15);
    set(pose, 'body', 0.12);
  } else if (s.slam < 0.5) {
    // Arms smash down, body heaves forward, then settles.
    const k = 1 - s.slam / 0.5;
    set(pose, 'armL', 0.9 * k, 0, 0.1);
    set(pose, 'armR', 0.9 * k, 0, -0.1);
    set(pose, 'body', -0.35 * k);
  } else {
    set(pose, 'armL', -a * 0.6, 0, 0.06);
    set(pose, 'armR', a * 0.6, 0, -0.06);
    set(pose, 'body', 0, 0, Math.sin(s.walk) * 0.05);
  }
  set(pose, 'head', 0, Math.sin(s.t * 0.4 + s.seed * 3) * 0.3);
});

// --- Ember mite: a small glowing beetle of the Ember Deep. -------------------------------------------

const emberMite = monster(() => {
  const shell = c(70, 30, 24);
  const glow = c(255, 140, 40);
  const legs: Bone[] = [];
  [-2, 0, 2].forEach((z, i) => {
    for (const side of [-1, 1]) legs.push(bone(`leg${i}${side < 0 ? 'L' : 'R'}`, [side * 3, 2, z], [box([2.5, 0.8, 0.8], [side * 4.2, 1.6, z], c(50, 24, 20), { pattern: 'plain' })], [], [0, 0, -side * 0.4]));
  });
  const body = bone('body', [0, 2, 0], [
    box([6, 3, 7], [0, 3, 0.5], shell, { pattern: 'chitin' }),
    box([6.2, 0.6, 1], [0, 4.3, -1], glow, { glow: true, pattern: 'plain' }),
    box([6.2, 0.6, 1], [0, 4.3, 1.5], glow, { glow: true, pattern: 'plain' }),
    box([4, 2, 2], [0, 2.6, -3.8], c(60, 26, 22), { pattern: 'plain' }),
    ...both(box([1, 1, 2], [-1.2, 2.2, -5.5], glow, { glow: true, pattern: 'plain' })),
  ]);
  return { bones: [body, ...legs], scale: 1 };
}, (pose, s) => {
  const k = Math.min(1, s.speed / 2);
  for (let i = 0; i < 3; i++) {
    for (const side of ['L', 'R']) set(pose, `leg${i}${side}`, 0, Math.sin(s.walk * 2 + i * 2 + (side === 'L' ? 0 : Math.PI)) * 0.6 * k, 0);
  }
  lift(pose, 'body', Math.abs(Math.sin(s.walk * 2)) * 0.4 * k);
});

// --- The matriarch: a giant ember beetle queen. --------------------------------------------------------

const matriarch = monster(() => {
  const shell = c(56, 26, 24);
  const plate = c(86, 40, 32);
  const ember = c(255, 130, 40);
  const legs: Bone[] = [];
  // Spread along the body (front legs reach forward, hind legs back) so she stands on all six.
  [[-9, 0.35], [2, 0], [13, -0.35]].forEach(([z, splay], i) => {
    for (const side of [-1, 1]) {
      const n = `leg${i}${side < 0 ? 'L' : 'R'}`;
      const lower = bone(`${n}b`, [side * 20, 12, z], [box([3, 16, 3], [side * 20, 4, z], plate, { pattern: 'chitin', band: { rows: 2, color: ember } })], [], [0, 0, side * -0.55]);
      legs.push(bone(n, [side * 10, 12, z], [box([10, 3, 3], [side * 15, 12, z], plate, { pattern: 'chitin' })], [lower], [0, side * splay, side * 0.4]));
    }
  });
  const mand = (side: -1 | 1) => bone(`mand${side < 0 ? 'L' : 'R'}`, [side * 5, 12, -21], [
    box([3, 3, 9], [side * 5.5, 12, -25.5], c(40, 20, 18), { pattern: 'chitin' }),
    box([3.2, 1, 2], [side * 5.5, 12, -29], ember, { glow: true, pattern: 'plain' }),
  ], [], [0, side * 0.3, 0]);
  const head = bone('head', [0, 15, -12], [
    box([16, 10, 10], [0, 15, -17], plate, { pattern: 'chitin' }),
    ...glowEye(3, 17, -22.15, c(255, 220, 90), 2, 2),
    ...glowEye(6, 16, -22.15, c(255, 180, 60), 1, 1),
    box([2, 4, 2], [0, 22, -15], ember, { glow: true, pattern: 'plain' }),
    ...both(box([2, 3, 2], [-5, 21, -15], plate, { pattern: 'plain' })),
  ], [mand(-1), mand(1)]);
  const abdomen = bone('abdomen', [0, 16, 4], [
    box([30, 16, 24], [0, 18, 15], shell, { top: plate, pattern: 'chitin' }),
    ...[9, 15, 21].map((z) => box([30.4, 1, 1], [0, 21, z], ember, { glow: true, pattern: 'plain' })),
    box([24, 1, 20], [0, 9.9, 15], c(255, 110, 30), { glow: true, pattern: 'plain' }),
  ]);
  const body = bone('body', [0, 12, -2], [box([22, 12, 16], [0, 16, -4], plate, { top: shell, pattern: 'chitin' })], [head, abdomen]);
  return { bones: [body, ...legs], scale: 1 };
}, (pose, s) => {
  const stunned = (s.anim & MobAnim.STUN) !== 0;
  const dash = (s.anim & MobAnim.DASH) !== 0;
  const k = stunned ? 0 : Math.min(1, s.speed / 2) * (dash ? 1 : 0.5);
  for (let i = 0; i < 3; i++) {
    for (const side of ['L', 'R']) {
      const ph = s.walk * 1.2 + (i % 2 === (side === 'L' ? 0 : 1) ? 0 : Math.PI);
      set(pose, `leg${i}${side}`, 0, Math.sin(ph) * 0.35 * k, stunned ? (side === 'L' ? -0.5 : 0.5) : Math.max(0, Math.cos(ph)) * 0.25 * k * (side === 'L' ? -1 : 1));
    }
  }
  lift(pose, 'body', stunned ? -5 : Math.sin(s.walk * 2.4) * 0.4 * k);
  const windup = (s.anim & MobAnim.WINDUP) !== 0;
  set(pose, 'head', stunned ? -0.35 : windup ? -0.3 : s.anim & MobAnim.ATTACK ? 0.35 : Math.sin(s.t * 0.7) * 0.05, stunned ? 0 : Math.sin(s.t * 0.5 + s.seed) * 0.15);
  set(pose, 'abdomen', windup ? 0.25 : stunned ? -0.15 : Math.sin(s.t * 1.4) * 0.04);
  const snap = s.anim & MobAnim.ATTACK || dash ? Math.sin(s.t * 14) * 0.25 : Math.sin(s.t * 1.2) * 0.08;
  set(pose, 'mandL', 0, snap, 0);
  set(pose, 'mandR', 0, -snap, 0);
});

const MONSTERS: Partial<Record<number, Species>> = {
  [Mob.GLOOMWALKER]: gloomwalker,
  [Mob.THORNSLINGER]: thornslinger,
  [Mob.SKITTERLING]: skitterling,
  [Mob.SPORECAP]: sporecap,
  [Mob.TRADER]: trader,
  [Mob.DUSKWING]: duskwing,
  [Mob.MIREFIN]: mirefin,
  [Mob.CRAGBACK]: cragback,
  [Mob.SHADE]: shade,
  [Mob.BRAMBLEHULK]: bramblehulk,
  [Mob.EMBER_MITE]: emberMite,
  [Mob.MATRIARCH]: matriarch,
};

/** Every creature's rig and animator: animals and monsters. */
export const CREATURES: Partial<Record<number, Species>> = { ...SPECIES, ...MONSTERS };
