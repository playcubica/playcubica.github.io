// Block definitions shared by server, client and workers. Block ids are 12 bits
// (0..4095); the upper 4 bits of a stored block value ("raw") hold per-block state.

export type RenderKind = 'none' | 'cube' | 'cross' | 'liquid' | 'box';
export type ToolKind = 'pickaxe' | 'axe' | 'shovel' | 'sword';

/** An axis-aligned box in 1/16-block pixels: [x0, y0, z0, x1, y1, z1]. */
export type PxBox = readonly [number, number, number, number, number, number];

export interface BlockDef {
  id: number;
  key: string;
  name: string;
  render: RenderKind;
  tex: { top: string; bottom: string; side: string };
  /** Texture for the side the block faces (state & 3, see FACING_DIR). */
  front?: string;
  /** Side texture used instead when state bit 3 is set (upper door half). */
  alt?: string;
  /** Shape for 'box' blocks, by state. Also used for collision when solid. */
  shape?: (state: number) => PxBox[];
  /** Texture name by state and face (overrides tex/front/alt), for growth stages, on/off, facing. */
  texFn?: (state: number, dir: number) => string;
  /** Every texture name texFn can return (so they get array layers). */
  extraTex?: string[];
  /** Full opaque cube: blocks light and hides neighbouring faces. */
  opaque: boolean;
  /** Collides with entities. */
  solid: boolean;
  /** Drawn in the translucent pass (water, ice). Faces against the same block are culled. */
  translucent: boolean;
  /** Faces between two blocks of this kind are hidden (glass). */
  cullSame: boolean;
  /** Can be replaced by placing a block into it (air, water, plants). */
  replaceable: boolean;
  /** Extra light reduction when light passes through (0 = clear). */
  lightFilter: number;
  lightEmit: number;
  /** Break-time factor (see shared/items/mining.ts); negative = unbreakable in survival. */
  hardness: number;
  tool?: ToolKind;
  /** Minimum pickaxe tier needed to get a drop (0 = anything, even a hand). */
  harvest: number;
}

export const B = {
  AIR: 0,
  STONE: 1,
  DIRT: 2,
  GRASS: 3,
  SAND: 4,
  GRAVEL: 5,
  CLAY: 6,
  DUNESTONE: 7,
  SNOW: 8,
  FROST_TURF: 9,
  ICE: 10,
  COREROCK: 11,
  WATER: 12,
  ASHWOOD_LOG: 13,
  ASHWOOD_LEAVES: 14,
  FROSTPINE_LOG: 15,
  FROSTPINE_NEEDLES: 16,
  CACTUS: 17,
  COAL_ORE: 18,
  IRON_ORE: 19,
  GOLD_ORE: 20,
  DIAMOND_ORE: 21,
  LUMEN_CRYSTAL: 22,
  TALL_GRASS: 23,
  SUNBLOOM: 24,
  BLUEBELL: 25,
  DRY_SCRUB: 26,
  ASHWOOD_PLANKS: 27,
  FROSTPINE_PLANKS: 28,
  RUBBLESTONE: 29,
  GLASS: 30,
  CUT_STONE: 31,
  WORKBENCH: 32,
  FURNACE: 33,
  FURNACE_LIT: 34,
  CHEST: 35,
  BEDROLL: 36,
  TORCH: 37,
  ASHWOOD_DOOR: 38,
  ASHWOOD_SAPLING: 39,
  FROSTPINE_SAPLING: 40,
  FARMLAND: 41,
  SUNWHEAT: 42,
  GLOWWIRE: 43,
  LEVER: 44,
  PRESSURE_PLATE: 45,
  POWER_CRYSTAL: 46,
  RELAY: 47,
  INVERTER: 48,
  LAMP: 49,
  LAMP_ON: 50,
  PUSHER: 51,
  PUSHER_HEAD: 52,
  RIFT_STONE: 53,
  RIFT: 54,
  ASHSTONE: 55,
  EMBERSTONE: 56,
  EMBER_ORE: 57,
  MAGMA: 58,
  RUNE_TABLE: 59,
} as const;

// --- Block state helpers -----------------------------------------------------

export const blockId = (raw: number): number => raw & 0xfff;
export const blockState = (raw: number): number => raw >>> 12;
export const withState = (id: number, state: number): number => id | ((state & 15) << 12);

/** Facing (state & 3) -> mesher face direction (0 +x, 1 -x, 2 +y, 3 -y, 4 +z, 5 -z). 0 = south (+z). */
export const FACING_DIR = [4, 1, 5, 0];

/** Door state: bits 0-1 facing, bit 2 open, bit 3 upper half. */
export const DOOR_OPEN = 4;
export const DOOR_UPPER = 8;

/** Torch state: 0 standing, 1..4 on a wall towards -x, +x, -z, +z. */
export const TORCH_WALL: ReadonlyArray<readonly [number, number, number]> = [[0, -1, 0], [-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1]];

// Thin panels along each edge, indexed by facing (0 +z, 1 -x, 2 -z, 3 +x).
const DOOR_PANELS: PxBox[] = [[0, 0, 13, 16, 16, 16], [0, 0, 0, 3, 16, 16], [0, 0, 0, 16, 16, 3], [13, 0, 0, 16, 16, 16]];
/** Mesher face directions (0 +x, 1 -x, 2 +y, 3 -y, 4 +z, 5 -z) as vectors; used by pushers (state & 7). */
export const DIR_VEC: ReadonlyArray<readonly [number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
export const OPPOSITE_DIR = [1, 0, 3, 2, 5, 4];
/** Power state bits: relay/inverter output on; lever on / plate pressed; pusher extended. */
export const POWER_ON = 4;
export const PUSHER_EXTENDED = 8;

/** A box from a0 to a1 px measured inwards from the face in direction dir, spanning c0..c1 across the other axes. */
function axisBox(dir: number, a0: number, a1: number, c0 = 0, c1 = 16): PxBox {
  const axis = dir >> 1;
  const lo = [c0, c0, c0];
  const hi = [c1, c1, c1];
  const positive = dir % 2 === 0;
  lo[axis] = positive ? 16 - a1 : a0;
  hi[axis] = positive ? 16 - a0 : a1;
  return [lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]];
}

/** Relay / inverter: a thin slab with posts showing which way the signal goes (facing 0..3 as FACING_DIR). */
function gateShape(state: number, inverter: boolean): PxBox[] {
  const v = DIR_VEC[FACING_DIR[state & 3]];
  const post = (d: number, h: number): PxBox => {
    const cx = 8 + v[0] * d;
    const cz = 8 + v[2] * d;
    return [cx - 1, 2, cz - 1, cx + 1, h, cz + 1];
  };
  return inverter ? [[0, 0, 0, 16, 2, 16], post(4, 8)] : [[0, 0, 0, 16, 2, 16], post(-4, 5), post(4, 8)];
}

const TORCH_BOXES: PxBox[] = [[7, 0, 7, 9, 10, 9], [0, 3, 7, 2, 13, 9], [14, 3, 7, 16, 13, 9], [7, 3, 0, 9, 13, 2], [7, 3, 14, 9, 13, 16]];

// --- Definitions -----------------------------------------------------------

type Props = Partial<Omit<BlockDef, 'id' | 'key' | 'name' | 'tex'>> & {
  tex?: string | { top: string; bottom: string; side: string };
};

const defs: BlockDef[] = [];

function def(id: number, key: string, name: string, props: Props = {}): void {
  const tex = typeof props.tex === 'string' || props.tex === undefined
    ? { top: (props.tex as string) ?? key, bottom: (props.tex as string) ?? key, side: (props.tex as string) ?? key }
    : props.tex;
  defs[id] = {
    id,
    key,
    name,
    render: props.render ?? 'cube',
    tex,
    front: props.front,
    alt: props.alt,
    shape: props.shape,
    texFn: props.texFn,
    extraTex: props.extraTex,
    opaque: props.opaque ?? true,
    solid: props.solid ?? true,
    translucent: props.translucent ?? false,
    cullSame: props.cullSame ?? false,
    replaceable: props.replaceable ?? false,
    lightFilter: props.lightFilter ?? 0,
    lightEmit: props.lightEmit ?? 0,
    hardness: props.hardness ?? 1,
    tool: props.tool,
    harvest: props.harvest ?? 0,
  };
}

const plant: Props = { render: 'cross', opaque: false, solid: false, replaceable: true, hardness: 0 };
const sapling: Props = { render: 'cross', opaque: false, solid: false, hardness: 0 };
const log = (k: string): Props => ({ tex: { top: `${k}_log_top`, bottom: `${k}_log_top`, side: `${k}_log_side` }, hardness: 2, tool: 'axe' });
const leaves: Props = { opaque: false, lightFilter: 1, hardness: 0.2 };
const stoneLike = (hardness: number): Props => ({ hardness, tool: 'pickaxe', harvest: 1 });
const furnace = (front: string, lightEmit: number): Props => ({
  tex: { top: 'furnace_top', bottom: 'furnace_top', side: 'furnace_side' }, front, lightEmit, hardness: 3.5, tool: 'pickaxe', harvest: 1,
});

def(B.AIR, 'air', 'Air', { render: 'none', opaque: false, solid: false, replaceable: true, hardness: 0 });
def(B.STONE, 'stone', 'Stone', stoneLike(1.5));
def(B.DIRT, 'dirt', 'Dirt', { hardness: 0.5, tool: 'shovel' });
def(B.GRASS, 'grass', 'Meadow Turf', { tex: { top: 'grass_top', bottom: 'dirt', side: 'grass_side' }, hardness: 0.6, tool: 'shovel' });
def(B.SAND, 'sand', 'Sand', { hardness: 0.5, tool: 'shovel' });
def(B.GRAVEL, 'gravel', 'Gravel', { hardness: 0.6, tool: 'shovel' });
def(B.CLAY, 'clay', 'Clay', { hardness: 0.6, tool: 'shovel' });
def(B.DUNESTONE, 'dunestone', 'Dunestone', { ...stoneLike(0.8), tex: { top: 'dunestone_top', bottom: 'dunestone_top', side: 'dunestone_side' } });
def(B.SNOW, 'snow', 'Packed Snow', { hardness: 0.2, tool: 'shovel' });
def(B.FROST_TURF, 'frost_turf', 'Frost Turf', { tex: { top: 'snow', bottom: 'dirt', side: 'frost_turf_side' }, hardness: 0.6, tool: 'shovel' });
def(B.ICE, 'ice', 'Ice', { opaque: false, translucent: true, lightFilter: 1, hardness: 0.5, tool: 'pickaxe' });
def(B.COREROCK, 'corerock', 'Corerock', { hardness: -1 });
def(B.WATER, 'water', 'Water', { render: 'liquid', opaque: false, solid: false, translucent: true, replaceable: true, lightFilter: 2, hardness: -1 });
def(B.ASHWOOD_LOG, 'ashwood_log', 'Ashwood Log', log('ashwood'));
def(B.ASHWOOD_LEAVES, 'ashwood_leaves', 'Ashwood Leaves', leaves);
def(B.FROSTPINE_LOG, 'frostpine_log', 'Frostpine Log', log('frostpine'));
def(B.FROSTPINE_NEEDLES, 'frostpine_needles', 'Frostpine Needles', leaves);
def(B.CACTUS, 'cactus', 'Cactus', { tex: { top: 'cactus_top', bottom: 'cactus_top', side: 'cactus_side' }, hardness: 0.4 });
def(B.COAL_ORE, 'coal_ore', 'Coal Ore', stoneLike(3));
def(B.IRON_ORE, 'iron_ore', 'Iron Ore', { ...stoneLike(3), harvest: 2 });
def(B.GOLD_ORE, 'gold_ore', 'Gold Ore', { ...stoneLike(3), harvest: 3 });
def(B.DIAMOND_ORE, 'diamond_ore', 'Diamond Ore', { ...stoneLike(3), harvest: 3 });
def(B.LUMEN_CRYSTAL, 'lumen_crystal', 'Lumen Crystal', { lightEmit: 15, hardness: 0.3 });
def(B.TALL_GRASS, 'tall_grass', 'Tall Grass', plant);
def(B.SUNBLOOM, 'sunbloom', 'Sunbloom', plant);
def(B.BLUEBELL, 'bluebell', 'Bluebell', plant);
def(B.DRY_SCRUB, 'dry_scrub', 'Dry Scrub', plant);
def(B.ASHWOOD_PLANKS, 'ashwood_planks', 'Ashwood Planks', { hardness: 2, tool: 'axe' });
def(B.FROSTPINE_PLANKS, 'frostpine_planks', 'Frostpine Planks', { hardness: 2, tool: 'axe' });
def(B.RUBBLESTONE, 'rubblestone', 'Rubblestone', stoneLike(2));
def(B.GLASS, 'glass', 'Glass', { opaque: false, cullSame: true, hardness: 0.3 });
def(B.CUT_STONE, 'cut_stone', 'Cut Stone', stoneLike(1.5));
def(B.WORKBENCH, 'workbench', 'Workbench', {
  tex: { top: 'workbench_top', bottom: 'ashwood_planks', side: 'workbench_side' }, hardness: 2.5, tool: 'axe',
});
def(B.FURNACE, 'furnace', 'Furnace', furnace('furnace_front', 0));
def(B.FURNACE_LIT, 'furnace_lit', 'Lit Furnace', furnace('furnace_front_lit', 13));
def(B.CHEST, 'chest', 'Chest', {
  render: 'box', opaque: false, tex: { top: 'chest_top', bottom: 'chest_top', side: 'chest_side' }, front: 'chest_front',
  shape: () => [[1, 0, 1, 15, 14, 15]], hardness: 2.5, tool: 'axe',
});
def(B.BEDROLL, 'bedroll', 'Bedroll', {
  render: 'box', opaque: false, tex: { top: 'bedroll_top', bottom: 'ashwood_planks', side: 'bedroll_side' },
  shape: () => [[0, 0, 0, 16, 9, 16]], hardness: 0.2,
});
def(B.TORCH, 'torch', 'Torch', {
  render: 'box', opaque: false, solid: false, lightEmit: 14, hardness: 0, shape: (s) => [TORCH_BOXES[s] ?? TORCH_BOXES[0]],
});
def(B.ASHWOOD_DOOR, 'ashwood_door', 'Ashwood Door', {
  render: 'box', opaque: false, tex: { top: 'ashwood_planks', bottom: 'ashwood_planks', side: 'door_lower' }, alt: 'door_upper',
  shape: (s) => [DOOR_PANELS[s & DOOR_OPEN ? ((s & 3) + 1) % 4 : s & 3]], hardness: 2, tool: 'axe',
});
def(B.ASHWOOD_SAPLING, 'ashwood_sapling', 'Ashwood Sapling', sapling);
def(B.FROSTPINE_SAPLING, 'frostpine_sapling', 'Frostpine Sapling', sapling);
def(B.FARMLAND, 'farmland', 'Farmland', {
  tex: 'dirt', hardness: 0.6, tool: 'shovel',
  texFn: (s, d) => (d === 2 ? (s & 1 ? 'farmland_wet' : 'farmland_dry') : 'dirt'), extraTex: ['farmland_dry', 'farmland_wet'],
});
const STAGES = Array.from({ length: 8 }, (_, i) => `sunwheat_${i}`);
def(B.SUNWHEAT, 'sunwheat_crop', 'Sunwheat', { ...plant, replaceable: false, tex: 'sunwheat_0', texFn: (s) => STAGES[s & 7], extraTex: STAGES });
const thin: Props = { render: 'box', opaque: false, solid: false, hardness: 0 };
def(B.GLOWWIRE, 'glowwire', 'Glowwire', {
  ...thin, tex: 'glowwire_off', shape: () => [[0, 0, 0, 16, 1, 16]],
  texFn: (s) => (s > 0 ? 'glowwire_on' : 'glowwire_off'), extraTex: ['glowwire_off', 'glowwire_on'],
});
def(B.LEVER, 'lever', 'Lever', {
  ...thin, tex: 'lever', hardness: 0.5,
  shape: (s) => [[4, 0, 4, 12, 2, 12], s & POWER_ON ? [7, 2, 9, 9, 10, 11] : [7, 2, 5, 9, 10, 7]],
});
def(B.PRESSURE_PLATE, 'pressure_plate', 'Pressure Plate', {
  ...thin, tex: 'pressure_plate', hardness: 0.5, shape: (s) => [[1, 0, 1, 15, s & POWER_ON ? 1 : 2, 15]],
});
def(B.POWER_CRYSTAL, 'power_crystal', 'Power Crystal', { lightEmit: 7, hardness: 1, tool: 'pickaxe' });
const gateTex = (s: number) => (s & POWER_ON ? 'gate_on' : 'gate_off');
def(B.RELAY, 'relay', 'Relay', { ...thin, tex: 'gate_off', shape: (s) => gateShape(s, false), texFn: gateTex, extraTex: ['gate_off', 'gate_on'] });
def(B.INVERTER, 'inverter', 'Inverter', { ...thin, tex: 'gate_off', shape: (s) => gateShape(s, true), texFn: gateTex, extraTex: ['gate_off', 'gate_on'] });
def(B.LAMP, 'lamp', 'Glow Lamp', { tex: 'lamp_off', hardness: 0.5 });
def(B.LAMP_ON, 'lamp_on', 'Lit Glow Lamp', { tex: 'lamp_on', lightEmit: 15, hardness: 0.5 });
def(B.PUSHER, 'pusher', 'Pusher', {
  tex: 'pusher_side', hardness: 2, tool: 'pickaxe',
  texFn: (s, d) => (d === (s & 7) ? (s & PUSHER_EXTENDED ? 'pusher_front_open' : 'pusher_front') : d === OPPOSITE_DIR[s & 7] ? 'pusher_back' : 'pusher_side'),
  extraTex: ['pusher_side', 'pusher_front', 'pusher_front_open', 'pusher_back'],
});
def(B.PUSHER_HEAD, 'pusher_head', 'Pusher Head', {
  render: 'box', opaque: false, tex: 'pusher_front', hardness: 2,
  shape: (s) => [axisBox(s & 7, 0, 4), axisBox(s & 7, 4, 16, 6, 10)], // plate at the far face, rod back to the pusher
});
def(B.RIFT_STONE, 'rift_stone', 'Rift Stone', { tex: { top: 'rift_stone_top', bottom: 'rift_stone', side: 'rift_stone' }, hardness: 5, tool: 'pickaxe', harvest: 3 });
def(B.RIFT, 'rift', 'Rift', { opaque: false, solid: false, translucent: true, lightEmit: 11, hardness: -1 });
def(B.ASHSTONE, 'ashstone', 'Ashstone', stoneLike(1.5));
def(B.EMBERSTONE, 'emberstone', 'Emberstone', { ...stoneLike(1.2), lightEmit: 10 });
def(B.EMBER_ORE, 'ember_ore', 'Ember Ore', { ...stoneLike(3), harvest: 2 });
def(B.MAGMA, 'magma', 'Magma', { render: 'liquid', opaque: false, solid: false, translucent: true, replaceable: true, lightEmit: 15, hardness: -1 });
def(B.RUNE_TABLE, 'rune_table', 'Rune Table', { tex: { top: 'rune_table_top', bottom: 'cut_stone', side: 'rune_table_side' }, hardness: 3, tool: 'pickaxe', harvest: 1 });

export const BLOCKS: readonly BlockDef[] = defs;

// --- Texture layers ---------------------------------------------------------

/** Every texture name, in layer order of the texture array. */
export const TEXTURE_NAMES: string[] = [];
const layerOf = new Map<string, number>();
function layer(name: string): number {
  let l = layerOf.get(name);
  if (l === undefined) {
    l = TEXTURE_NAMES.length;
    TEXTURE_NAMES.push(name);
    layerOf.set(name, l);
  }
  return l;
}

// --- Flat lookup tables for hot loops (meshing, lighting) ------------------

const MAX_ID = 4096;
export const OPAQUE = new Uint8Array(MAX_ID);
export const LIGHT_FILTER = new Uint8Array(MAX_ID);
export const LIGHT_EMIT = new Uint8Array(MAX_ID);
export const TRANSLUCENT = new Uint8Array(MAX_ID);
export const CULL_SAME = new Uint8Array(MAX_ID);
export const SOLID = new Uint8Array(MAX_ID);
export const REPLACEABLE = new Uint8Array(MAX_ID);
/** 0 none, 1 cube, 2 cross, 3 liquid, 4 box */
export const RENDER = new Uint8Array(MAX_ID);
export const TEX_TOP = new Uint8Array(MAX_ID);
export const TEX_BOTTOM = new Uint8Array(MAX_ID);
export const TEX_SIDE = new Uint8Array(MAX_ID);
/** Front texture layer + 1 (0 = none). */
export const TEX_FRONT = new Uint8Array(MAX_ID);
/** Alternate (upper-half) side layer + 1 (0 = none). */
export const TEX_ALT = new Uint8Array(MAX_ID);
const TEX_FN: Array<((state: number, dir: number) => string) | undefined> = [];

const RENDER_CODE: Record<RenderKind, number> = { none: 0, cube: 1, cross: 2, liquid: 3, box: 4 };

for (const d of defs) {
  if (!d) continue;
  OPAQUE[d.id] = d.opaque ? 1 : 0;
  LIGHT_FILTER[d.id] = d.lightFilter;
  LIGHT_EMIT[d.id] = d.lightEmit;
  TRANSLUCENT[d.id] = d.translucent ? 1 : 0;
  CULL_SAME[d.id] = d.cullSame ? 1 : 0;
  SOLID[d.id] = d.solid ? 1 : 0;
  REPLACEABLE[d.id] = d.replaceable ? 1 : 0;
  RENDER[d.id] = RENDER_CODE[d.render];
  if (d.render !== 'none') {
    TEX_TOP[d.id] = layer(d.tex.top);
    TEX_BOTTOM[d.id] = layer(d.tex.bottom);
    TEX_SIDE[d.id] = layer(d.tex.side);
    if (d.front) TEX_FRONT[d.id] = layer(d.front) + 1;
    if (d.alt) TEX_ALT[d.id] = layer(d.alt) + 1;
    for (const t of d.extraTex ?? []) layer(t);
    TEX_FN[d.id] = d.texFn;
  }
}
// Unknown ids behave as opaque so corrupted data never produces holes.
for (let i = defs.length; i < MAX_ID; i++) {
  OPAQUE[i] = 1;
  SOLID[i] = 1;
}

export function blockDef(id: number): BlockDef | undefined {
  return defs[id];
}

/** Texture layer for one face (0 +x, 1 -x, 2 +y, 3 -y, 4 +z, 5 -z) of a block value. */
export function faceLayer(raw: number, dir: number): number {
  const id = raw & 0xfff;
  const fn = TEX_FN[id];
  if (fn) return layerOf.get(fn(raw >>> 12, dir)) ?? TEX_SIDE[id];
  if (dir === 2) return TEX_TOP[id];
  if (dir === 3) return TEX_BOTTOM[id];
  const state = raw >>> 12;
  if (TEX_FRONT[id] && FACING_DIR[state & 3] === dir) return TEX_FRONT[id] - 1;
  if (TEX_ALT[id] && state & DOOR_UPPER) return TEX_ALT[id] - 1;
  return TEX_SIDE[id];
}

const shapeCache = new Map<number, PxBox[]>();
/** Render boxes (pixels) of a 'box' block value. */
export function blockShape(raw: number): PxBox[] {
  let s = shapeCache.get(raw);
  if (!s) {
    s = defs[raw & 0xfff]?.shape?.(raw >>> 12) ?? [[0, 0, 0, 16, 16, 16]];
    shapeCache.set(raw, s);
  }
  return s;
}

const FULL: readonly number[] = [0, 0, 0, 1, 1, 1];
const collisionCache = new Map<number, readonly number[] | null>();
/** Collision boxes of a block value as flat [x0,y0,z0,x1,y1,z1,…] in block units, or null. */
export function collisionBoxes(raw: number): readonly number[] | null {
  const id = raw & 0xfff;
  if (!SOLID[id]) return null;
  if (RENDER[id] !== 4) return FULL;
  let c = collisionCache.get(raw);
  if (c === undefined) {
    c = blockShape(raw).flatMap((b) => b.map((v) => v / 16));
    collisionCache.set(raw, c);
  }
  return c;
}
