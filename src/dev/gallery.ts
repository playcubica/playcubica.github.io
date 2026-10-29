import * as THREE from 'three';
import { B } from '../shared/blocks/registry';
import { ALL_MOBS, BABY_SCALE, MobAnim, MobFlag, mobDef } from '../shared/entities/mobs';
import { buildChunkMesh, PAD, paddedIndex } from '../shared/mesh/mesher';
import { buildBlockTextures } from '../client/textures/atlas';
import { createChunkMaterials, createChunkUniforms } from '../client/render/chunkMaterial';
import { MobRenderer } from '../client/render/MobRenderer';
import { SPECIES } from '../client/render/mobModels';
import type { ClientWorld } from '../client/ClientWorld';

// Development-only creature gallery (http://localhost:5173/gallery.html; not part of the build):
// every creature, every variant, adult/baby, look states, animations and fixed camera views,
// next to a player-sized frame and on a block grid, with the hit box drawn.

THREE.ColorManagement.enabled = false;
const host = document.getElementById('view')!;
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
host.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0.5, 0.66, 0.86);
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 300);

// A grass floor (real block mesh, so scale against blocks is exact).
const H = 3;
const blocks = new Uint16Array(PAD * PAD * H);
const light = new Uint8Array(PAD * PAD * H).fill(0xf0);
for (let x = -1; x <= 16; x++) for (let z = -1; z <= 16; z++) blocks[paddedIndex(x, 0, z)] = (x + z) % 2 ? B.GRASS : B.FROST_TURF;
const floor = buildChunkMesh({ blocks, light, height: H }).opaque!;
const fg = new THREE.BufferGeometry();
fg.setAttribute('position', new THREE.Int16BufferAttribute(floor.pos, 3));
fg.setAttribute('aTex', new THREE.Uint16BufferAttribute(floor.tex, 4));
fg.setAttribute('aLight', new THREE.Uint8BufferAttribute(floor.light, 4));
fg.setIndex(new THREE.BufferAttribute(floor.index, 1));
const floorMesh = new THREE.Mesh(fg, createChunkMaterials(createChunkUniforms(buildBlockTextures().array)).opaque);
floorMesh.scale.setScalar(1 / 16);
floorMesh.position.set(-8, 0, -8);
floorMesh.frustumCulled = false;
scene.add(floorMesh);

// A player-sized frame (0.6 × 1.8) for scale.
const playerFrame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(0.6, 1.8, 0.6)), new THREE.LineBasicMaterial({ color: 0xffe066 }));
scene.add(playerFrame);
const hitFrame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0xff5050 }));
scene.add(hitFrame);

const world = { getLight: () => 0xf0 } as unknown as ClientWorld;
const mobs = new MobRenderer(scene, world);

const state = {
  kind: ALL_MOBS[0],
  variant: 0,
  flags: 0,
  anim: 'idle' as keyof typeof ANIMS,
  view: 'quarter' as keyof typeof VIEWS,
  mode: 'one' as 'one' | 'herd' | 'all',
  orbit: 0,
};

const ANIMS = {
  idle: { label: 'עמידה', speed: 0, vy: 0, anim: 0 },
  walk: { label: 'הליכה', speed: 1.5, vy: 0, anim: 0 },
  run: { label: 'ריצה', speed: 5, vy: 0, anim: MobAnim.FLEE },
  eat: { label: 'אכילה', speed: 0, vy: 0, anim: MobAnim.EAT },
  attack: { label: 'תקיפה', speed: 0.5, vy: 0, anim: MobAnim.ATTACK },
  ram: { label: 'נגיחה', speed: 5, vy: 0, anim: MobAnim.RAM },
  sleep: { label: 'שינה', speed: 0, vy: 0, anim: MobAnim.SLEEP },
  fall: { label: 'נפילה / קפיצה', speed: 1, vy: -3, anim: 0 },
  hop: { label: 'ניתור', speed: 2, vy: 4, anim: 0 },
  fuse: { label: 'פתיל', speed: 0, vy: 0, anim: MobAnim.FUSE },
};
const VIEWS = { front: { label: 'חזית', yaw: 0 }, side: { label: 'צד', yaw: Math.PI / 2 }, back: { label: 'גב', yaw: Math.PI }, quarter: { label: 'אלכסון', yaw: Math.PI / 4 } };
const FLAGS: Array<[number, string]> = [
  [MobFlag.BABY, 'גור'], [MobFlag.SHEARED, 'גזוז'], [MobFlag.TAMED, 'מאולף'], [MobFlag.SITTING, 'יושב'],
  [MobFlag.SADDLED, 'אוכף'], [MobFlag.ANGRY, 'כועס'],
];

let ids: number[] = [];

function variantsOf(kind: number): number[] {
  return SPECIES[kind]?.variants ?? (kind === 20 ? [0, 1, 2] : [0]);
}

function respawn(): void {
  for (const id of ids) {
    mobs.remove(id);
    mobs.motion.delete(id);
  }
  ids = [];
  const list = state.mode === 'all'
    ? ALL_MOBS.map((k) => ({ kind: k, variant: variantsOf(k)[0] }))
    : state.mode === 'herd' ? variantsOf(state.kind).map((v) => ({ kind: state.kind, variant: v }))
      : [{ kind: state.kind, variant: state.variant }];
  const spacing = state.mode === 'one' ? 0 : 1.8;
  list.forEach((e, i) => {
    const id = i + 1;
    const x = (i - (list.length - 1) / 2) * spacing;
    mobs.spawn({ id, kind: 'mob', mob: e.kind, x, y: 1, z: 0, yaw: 0, variant: e.variant, flags: state.flags });
    ids.push(id);
  });
  applyAnim();
  updateInfo();
  frameCamera();
}

function applyAnim(): void {
  const a = ANIMS[state.anim];
  const data: number[] = [];
  for (const id of ids) {
    const p = mobs.position(id)!;
    mobs.motion.set(id, { speed: a.speed, vy: a.vy });
    data.push(id, p.x, p.y, p.z, 0, a.anim);
  }
  mobs.move(data);
}

function updateInfo(): void {
  const d = mobDef(state.kind)!;
  const s = state.flags & MobFlag.BABY ? BABY_SCALE : 1;
  const species = SPECIES[state.kind];
  hitFrame.scale.set(d.width * s, d.height * s, d.width * s);
  hitFrame.position.set(0, (d.height * s) / 2 + 1, 0);
  hitFrame.visible = state.mode === 'one';
  playerFrame.position.set(state.mode === 'one' ? -Math.max(1.2, d.width) : -((ids.length - 1) / 2) * 1.8 - 1.4, 1.9, 0);
  document.getElementById('info')!.textContent = [
    `${d.name} (${d.key}) — ${d.hostile ? 'עוין' : d.trader ? 'סוחר' : 'בעל חיים'}`,
    `תיבת פגיעה: ${(d.width * s).toFixed(2)} × ${(d.height * s).toFixed(2)} בלוקים · חיים ${d.health}`,
    `מודל: ${species ? 'שלד ייעודי' : 'מודל תיבות (מפלצת)'} · ${variantsOf(state.kind).length} וריאנטים`,
    d.animal ? `אוכל: ${d.animal.food.length} פריטים${d.animal.tame ? ' · ניתן לאילוף' : ''}${d.animal.shear ? ' · גזיזה' : ''}${d.animal.milk ? ' · חליבה' : ''}${d.animal.eggs ? ' · ביצים' : ''}${d.animal.ride ? ' · רכיבה' : ''}` : '',
    d.habitat ? `ביומות: ${d.habitat.biomes.join(', ')} · קבוצה ${d.habitat.group.join('–')}` : '',
    'צהוב = גודל שחקן · אדום = תיבת פגיעה · גרירה = סיבוב',
  ].filter(Boolean).join('\n');
}

function frameCamera(): void {
  const d = mobDef(state.kind)!;
  const one = state.mode === 'one';
  const size = one ? Math.max(d.height, d.width * 1.4, 1.2) : (ids.length - 1) * 0.9 + 2;
  const dist = one ? size * 2.3 + 1.4 : size;
  const yaw = VIEWS[state.view].yaw + state.orbit;
  // The creatures face -z, so "front" looks at them from -z.
  camera.position.set(-Math.sin(yaw) * dist, one ? 1 + size * 0.55 : 2.6, -Math.cos(yaw) * dist);
  camera.lookAt(0, one ? 1 + Math.min(size, d.height) * 0.45 : 1.4, 0);
  // The player frame stands beside the creature, as seen from this view.
  if (state.mode === 'one') {
    const off = Math.max(1.1, d.width * 0.9 + 0.6);
    playerFrame.position.set(Math.cos(yaw) * off, 1.9, -Math.sin(yaw) * off);
  }
}

function buttons(id: string, items: Array<[string, () => void, () => boolean]>): void {
  const el = document.getElementById(id)!;
  el.textContent = '';
  for (const [label, act, on] of items) {
    const b = document.createElement('button');
    b.textContent = label;
    if (on()) b.className = 'on';
    b.onclick = () => {
      act();
      renderUi();
    };
    el.appendChild(b);
  }
}

function renderUi(): void {
  buttons('kinds', ALL_MOBS.map((k) => [mobDef(k)!.name, () => { state.kind = k; state.variant = variantsOf(k)[0]; state.mode = state.mode === 'all' ? 'one' : state.mode; respawn(); }, () => state.kind === k]));
  buttons('variants', variantsOf(state.kind).map((v) => [String(v), () => { state.variant = v; respawn(); }, () => state.variant === v]));
  buttons('flags', FLAGS.map(([bit, label]) => [label, () => { state.flags ^= bit; respawn(); }, () => (state.flags & bit) !== 0]));
  buttons('anims', (Object.keys(ANIMS) as Array<keyof typeof ANIMS>).map((a) => [ANIMS[a].label, () => { state.anim = a; applyAnim(); }, () => state.anim === a]));
  buttons('views', (Object.keys(VIEWS) as Array<keyof typeof VIEWS>).map((v) => [VIEWS[v].label, () => { state.view = v; state.orbit = 0; frameCamera(); }, () => state.view === v]));
  buttons('modes', [
    ['אחד', () => { state.mode = 'one'; respawn(); }, () => state.mode === 'one'],
    ['כל הווריאנטים', () => { state.mode = 'herd'; respawn(); }, () => state.mode === 'herd'],
    ['כל היצורים', () => { state.mode = 'all'; respawn(); }, () => state.mode === 'all'],
  ]);
}

let dragX: number | null = null;
renderer.domElement.addEventListener('pointerdown', (e) => { dragX = e.clientX; });
addEventListener('pointerup', () => { dragX = null; });
addEventListener('pointermove', (e) => {
  if (dragX === null) return;
  state.orbit += (e.clientX - dragX) * 0.01;
  dragX = e.clientX;
  frameCamera();
});

function resize(): void {
  const w = host.clientWidth;
  const h = host.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  mobs.update(dt, 1);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
renderUi();
respawn();
requestAnimationFrame(frame);
// Hidden panes stop requestAnimationFrame; tests can step frames by hand.
(window as unknown as { gallery: unknown }).gallery = { state, respawn, applyAnim, frameCamera, renderUi, step: (dt = 0.05) => { mobs.update(dt, 1); renderer.render(scene, camera); } };
