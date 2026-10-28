// Block definitions shared by server, client and workers. Block ids are 12 bits
// (0..4095); the upper 4 bits of a stored block value hold per-block state.

export type RenderKind = 'none' | 'cube' | 'cross' | 'liquid';
export type ToolKind = 'pickaxe' | 'axe' | 'shovel';

export interface BlockDef {
  id: number;
  key: string;
  name: string;
  render: RenderKind;
  tex: { top: string; bottom: string; side: string };
  /** Full opaque cube: blocks light and hides neighbouring faces. */
  opaque: boolean;
  /** Collides with entities (used from stage 2). */
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
} as const;

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
    opaque: props.opaque ?? true,
    solid: props.solid ?? true,
    translucent: props.translucent ?? false,
    cullSame: props.cullSame ?? false,
    replaceable: props.replaceable ?? false,
    lightFilter: props.lightFilter ?? 0,
    lightEmit: props.lightEmit ?? 0,
    hardness: props.hardness ?? 1,
    tool: props.tool,
  };
}

const plant: Props = { render: 'cross', opaque: false, solid: false, replaceable: true, hardness: 0 };
const log = (k: string): Props => ({ tex: { top: `${k}_log_top`, bottom: `${k}_log_top`, side: `${k}_log_side` }, hardness: 2, tool: 'axe' });
const leaves: Props = { opaque: false, lightFilter: 1, hardness: 0.2 };
const ore: Props = { hardness: 3, tool: 'pickaxe' };

def(B.AIR, 'air', 'Air', { render: 'none', opaque: false, solid: false, replaceable: true, hardness: 0 });
def(B.STONE, 'stone', 'Stone', { hardness: 1.5, tool: 'pickaxe' });
def(B.DIRT, 'dirt', 'Dirt', { hardness: 0.5, tool: 'shovel' });
def(B.GRASS, 'grass', 'Meadow Turf', { tex: { top: 'grass_top', bottom: 'dirt', side: 'grass_side' }, hardness: 0.6, tool: 'shovel' });
def(B.SAND, 'sand', 'Sand', { hardness: 0.5, tool: 'shovel' });
def(B.GRAVEL, 'gravel', 'Gravel', { hardness: 0.6, tool: 'shovel' });
def(B.CLAY, 'clay', 'Clay', { hardness: 0.6, tool: 'shovel' });
def(B.DUNESTONE, 'dunestone', 'Dunestone', { tex: { top: 'dunestone_top', bottom: 'dunestone_top', side: 'dunestone_side' }, hardness: 0.8, tool: 'pickaxe' });
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
def(B.COAL_ORE, 'coal_ore', 'Coal Ore', ore);
def(B.IRON_ORE, 'iron_ore', 'Iron Ore', ore);
def(B.GOLD_ORE, 'gold_ore', 'Gold Ore', ore);
def(B.DIAMOND_ORE, 'diamond_ore', 'Diamond Ore', ore);
def(B.LUMEN_CRYSTAL, 'lumen_crystal', 'Lumen Crystal', { lightEmit: 15, hardness: 0.3 });
def(B.TALL_GRASS, 'tall_grass', 'Tall Grass', plant);
def(B.SUNBLOOM, 'sunbloom', 'Sunbloom', plant);
def(B.BLUEBELL, 'bluebell', 'Bluebell', plant);
def(B.DRY_SCRUB, 'dry_scrub', 'Dry Scrub', plant);
def(B.ASHWOOD_PLANKS, 'ashwood_planks', 'Ashwood Planks', { hardness: 2, tool: 'axe' });
def(B.FROSTPINE_PLANKS, 'frostpine_planks', 'Frostpine Planks', { hardness: 2, tool: 'axe' });
def(B.RUBBLESTONE, 'rubblestone', 'Rubblestone', { hardness: 2, tool: 'pickaxe' });
def(B.GLASS, 'glass', 'Glass', { opaque: false, cullSame: true, hardness: 0.3 });
def(B.CUT_STONE, 'cut_stone', 'Cut Stone', { hardness: 1.5, tool: 'pickaxe' });

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
/** 0 none, 1 cube, 2 cross, 3 liquid */
export const RENDER = new Uint8Array(MAX_ID);
export const TEX_TOP = new Uint8Array(MAX_ID);
export const TEX_BOTTOM = new Uint8Array(MAX_ID);
export const TEX_SIDE = new Uint8Array(MAX_ID);

const RENDER_CODE: Record<RenderKind, number> = { none: 0, cube: 1, cross: 2, liquid: 3 };

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
