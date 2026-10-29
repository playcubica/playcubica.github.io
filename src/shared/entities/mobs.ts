import { B } from '../blocks/registry';
import { I, type ItemStack } from '../items/registry';
import { Biome } from '../world/biomes';

// Cubica's creatures. Shared by host (AI, physics, drops) and client (models, hit boxes).
// Animals are real-world species drawn in Cubica's own style; monsters are Cubica's own designs.

export const Mob = {
  SHEEP: 1,
  PIG: 2,
  CHICKEN: 3,
  COW: 4,
  HORSE: 5,
  WOLF: 6,
  CAT: 7,
  RABBIT: 8,
  FOX: 9,
  GOAT: 15,
  FISH: 24,
  OCTOPUS: 25,
  SONGBIRD: 26,
  BAT: 27,
  TURTLE: 28,
  DONKEY: 29,
  GLOOMWALKER: 10,
  THORNSLINGER: 11,
  SKITTERLING: 12,
  SPORECAP: 13,
  DUSKWING: 16,
  MIREFIN: 17,
  CRAGBACK: 18,
  SHADE: 19,
  BRAMBLEHULK: 21,
  EMBER_MITE: 22,
  MATRIARCH: 23,
  TRADER: 20,
} as const;

export type MobKind = (typeof Mob)[keyof typeof Mob];

export interface MobDef {
  kind: MobKind;
  key: string;
  /** Hebrew name (death messages, debug). */
  name: string;
  hostile: boolean;
  width: number;
  height: number;
  health: number;
  /** Walking speed (blocks/s); passive mobs run 2× when fleeing. */
  speed: number;
  /** Melee damage (hostile). */
  damage: number;
  /** Walks up walls. */
  climber?: boolean;
  /** Takes damage in direct sunlight. */
  sunSensitive?: boolean;
  /** Settlement trader: never spawns naturally, stays near home, opens trades on right-click. */
  trader?: boolean;
  /** Natural spawning: relative weight within its pool (default 2) and group size [min, max]. */
  spawnWeight?: number;
  group?: [number, number];
  /** How far (blocks) a hostile notices a player (default 16). */
  followRange?: number;
  /** Farm animals and pets: feeding, breeding, babies and the rest (see AnimalInfo). */
  animal?: AnimalInfo;
  /** Where it appears in the world by itself (animals; hostiles use the night spawner). */
  habitat?: Habitat;
  /** Picks a look for a new creature (stable for its whole life). */
  variant?: (biome: number, rnd: () => number) => number;
  /**
   * Where a monster appears by itself: 'surface' (dark ground under the sky), 'cave' (dark floors
   * underground), 'deep' (the Ember Deep), 'water' (in water, any light), 'air' (above the night surface).
   * No zones = never spawns naturally (bosses, traders).
   */
  zones?: Zone[];
  /** Flies (no gravity, steers in 3D). */
  flier?: boolean;
  /** Swims in water in 3D and flops about on land. */
  swimmer?: boolean;
  /** Damage taken from the front (shell); a pickaxe cracks it (double damage from any side). */
  frontArmor?: number;
  /** Damage taken from behind (a weak spot). */
  backWeakness?: number;
  /** Keeps away from block light at or above this level. */
  fearsLight?: number;
  /** Heavy: barely pushed by hits. */
  heavy?: boolean;
  boss?: boolean;
  /**
   * Wildlife that comes and goes (fish, birds, bats): appears in its zones around players, wanders off
   * when they leave and isn't saved. Uses the same `zones` as monsters.
   */
  ambient?: boolean;
  /** Neutral: fights back (with its pack) when hurt instead of fleeing. */
  retaliates?: boolean;
  /** Falls slowly (flaps its wings). */
  slowFall?: boolean;
  drops: (rnd: () => number, flags: number) => ItemStack[];
}

export type Zone = 'surface' | 'cave' | 'deep' | 'water' | 'air';

export interface AnimalInfo {
  /** Items it eats: feeding an adult starts breeding, feeding a baby makes it grow faster. */
  food: number[];
  /** Taming: items and the chance per feeding (wolves, cats), or 'ride' (horses: mount until it accepts you). */
  tame?: { items: number[]; chance: number } | 'ride';
  /** Can be sheared (fleece) and grows it back by grazing. */
  shear?: boolean;
  /** A bucket turns into a milk bucket. */
  milk?: boolean;
  /** Lays an egg every 5–10 minutes. */
  eggs?: boolean;
  /** Carries a rider once tamed and saddled. */
  ride?: { speed: number; jump: number };
  /** Hunts these creatures (foxes: chickens and rabbits). */
  prey?: number[];
  /** Sleeps by day (foxes). */
  nocturnal?: boolean;
  /** Moves in hops (rabbits). */
  hops?: boolean;
  /** Charges at players now and then (goats). */
  rams?: boolean;
}

export interface Habitat {
  biomes: number[];
  /** Blocks it may spawn on. */
  ground: number[];
  group: [number, number];
  /** Relative weight among the animals of a biome. */
  weight: number;
}

/** State bits of a creature (EntityInfo.flags / mobState). */
export const MobFlag = {
  BABY: 1,
  SHEARED: 2,
  TAMED: 4,
  SITTING: 8,
  SADDLED: 16,
  RIDDEN: 32,
  ANGRY: 64,
  /** Ready to breed (hearts). */
  LOVE: 128,
} as const;

/** Bits of the anim value sent in mobMove. */
export const MobAnim = {
  ATTACK: 1, FUSE: 2, FLEE: 4, EAT: 8, SLEEP: 16, RAM: 32,
  /** Winding up a big attack (slam, charge). */
  WINDUP: 64,
  /** Stunned / curled up in its shell. */
  STUN: 128,
  /** Diving / charging. */
  DASH: 256,
} as const;

/** A creature kept in the world save (animals; hostiles and traders are not saved). */
export interface SavedMob {
  k: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  v?: number;
  /** MobFlag bits that last (baby, sheared, tamed, sitting, saddled). */
  f: number;
  age?: number;
  /** Owner's save key and name. */
  o?: string;
  on?: string;
  temper?: number;
  /** Name from a name tag. */
  n?: string;
}

/** Flags that are saved; the rest (ridden, angry, love) are momentary. */
export const SAVED_FLAGS = MobFlag.BABY | MobFlag.SHEARED | MobFlag.TAMED | MobFlag.SITTING | MobFlag.SADDLED;

/** Ticks: a baby grows up in 20 minutes; parents can breed again after 5. */
export const GROW_TICKS = 24000;
export const BREED_COOLDOWN = 6000;
export const LOVE_TICKS = 600;

const n = (rnd: () => number, min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));
const drop = (id: number, count: number): ItemStack[] => (count > 0 ? [{ id, count }] : []);

const DEFS: MobDef[] = [
  {
    kind: Mob.SHEEP, key: 'sheep', name: 'כבשה', hostile: false, width: 0.9, height: 1.3, health: 8, speed: 1.6, damage: 0,
    animal: { food: [I.SUNWHEAT], shear: true },
    habitat: { biomes: [Biome.PLAINS, Biome.FOREST, Biome.MOUNTAINS, Biome.SNOW], ground: [B.GRASS, B.FROST_TURF], group: [2, 4], weight: 12 },
    // Natural fleece colours: mostly white, sometimes grey, dark or brown, very rarely pink.
    variant: (_b, r) => { const x = r(); return x < 0.81 ? 0 : x < 0.86 ? 1 : x < 0.91 ? 2 : x < 0.96 ? 3 : x < 0.998 ? 4 : 5; },
    drops: (r, f) => [...(f & MobFlag.SHEARED ? [] : drop(I.FLEECE, 1)), ...drop(I.RAW_MEAT, n(r, 1, 2))],
  },
  {
    kind: Mob.PIG, key: 'pig', name: 'חזיר', hostile: false, width: 0.9, height: 0.9, health: 10, speed: 1.7, damage: 0,
    animal: { food: [I.ASHFRUIT, I.FROSTBERRIES, I.SUNWHEAT] },
    habitat: { biomes: [Biome.PLAINS, Biome.FOREST, Biome.SNOW], ground: [B.GRASS, B.FROST_TURF], group: [2, 4], weight: 10 },
    // Climate coats: temperate pink, cold woolly brown, warm spotted.
    variant: (b) => (b === Biome.SNOW || b === Biome.MOUNTAINS ? 1 : b === Biome.DESERT || b === Biome.BEACH ? 2 : 0),
    drops: (r) => drop(I.RAW_MEAT, n(r, 1, 3)),
  },
  {
    kind: Mob.CHICKEN, key: 'chicken', name: 'תרנגולת', hostile: false, width: 0.4, height: 0.7, health: 4, speed: 1.4, damage: 0,
    slowFall: true,
    animal: { food: [I.SEEDS], eggs: true },
    habitat: { biomes: [Biome.PLAINS, Biome.FOREST], ground: [B.GRASS], group: [2, 4], weight: 10 },
    variant: (b) => (b === Biome.SNOW || b === Biome.MOUNTAINS ? 1 : b === Biome.DESERT ? 2 : 0),
    drops: (r) => [...drop(I.RAW_FOWL, 1), ...drop(I.FEATHER, n(r, 0, 2))],
  },
  {
    kind: Mob.COW, key: 'cow', name: 'פרה', hostile: false, width: 0.9, height: 1.4, health: 10, speed: 1.4, damage: 0,
    animal: { food: [I.SUNWHEAT], milk: true },
    habitat: { biomes: [Biome.PLAINS, Biome.FOREST, Biome.MOUNTAINS], ground: [B.GRASS], group: [2, 4], weight: 8 },
    variant: (b) => (b === Biome.SNOW || b === Biome.MOUNTAINS ? 1 : b === Biome.DESERT ? 2 : 0),
    drops: (r) => [...drop(I.HIDE, n(r, 0, 2)), ...drop(I.RAW_MEAT, n(r, 1, 3))],
  },
  {
    kind: Mob.HORSE, key: 'horse', name: 'סוס', hostile: false, width: 1.3, height: 1.6, health: 22, speed: 2.2, damage: 0,
    animal: { food: [I.SUNWHEAT, I.ASHFRUIT], tame: 'ride', ride: { speed: 8.5, jump: 10.5 } },
    habitat: { biomes: [Biome.PLAINS], ground: [B.GRASS], group: [2, 5], weight: 4 },
    // Coat (0-5) + markings (0-3) × 8.
    variant: (_b, r) => Math.floor(r() * 6) + Math.floor(r() * 4) * 8,
    drops: (r) => drop(I.HIDE, n(r, 0, 2)),
  },
  {
    kind: Mob.WOLF, key: 'wolf', name: 'זאב', hostile: false, width: 0.6, height: 0.85, health: 8, speed: 2.4, damage: 3,
    retaliates: true,
    animal: { food: [I.RAW_MEAT, I.COOKED_MEAT, I.RAW_FOWL, I.COOKED_FOWL], tame: { items: [I.RAW_MEAT], chance: 1 / 3 } },
    habitat: { biomes: [Biome.FOREST, Biome.SNOW], ground: [B.GRASS, B.FROST_TURF, B.SNOW], group: [2, 4], weight: 3 },
    variant: (b, r) => (b === Biome.SNOW ? 1 : r() < 0.25 ? 2 : 0),
    drops: () => [],
  },
  {
    kind: Mob.CAT, key: 'cat', name: 'חתול', hostile: false, width: 0.6, height: 0.7, health: 10, speed: 2.0, damage: 0,
    animal: { food: [I.RAW_FOWL, I.COOKED_FOWL, I.RAW_FISH, I.COOKED_FISH], tame: { items: [I.RAW_FOWL, I.RAW_FISH], chance: 1 / 3 } },
    variant: (_b, r) => Math.floor(r() * 6),
    drops: () => [],
  },
  {
    kind: Mob.RABBIT, key: 'rabbit', name: 'ארנב', hostile: false, width: 0.4, height: 0.5, health: 3, speed: 2.6, damage: 0,
    animal: { food: [I.FROSTBERRIES, I.ASHFRUIT], hops: true },
    habitat: { biomes: [Biome.PLAINS, Biome.DESERT, Biome.SNOW, Biome.FOREST], ground: [B.GRASS, B.SAND, B.SNOW, B.FROST_TURF], group: [2, 3], weight: 4 },
    // Brown, white in the snow, golden in the desert, or speckled.
    variant: (b, r) => (b === Biome.SNOW ? 1 : b === Biome.DESERT ? 2 : r() < 0.3 ? 3 : 0),
    drops: (r) => [...drop(I.RAW_MEAT, n(r, 0, 1)), ...drop(I.HIDE, r() < 0.3 ? 1 : 0)],
  },
  {
    kind: Mob.FOX, key: 'fox', name: 'שועל', hostile: false, width: 0.6, height: 0.7, health: 10, speed: 2.2, damage: 2,
    animal: { food: [I.FROSTBERRIES], prey: [Mob.CHICKEN, Mob.RABBIT], nocturnal: true },
    habitat: { biomes: [Biome.FOREST, Biome.SNOW], ground: [B.GRASS, B.FROST_TURF, B.SNOW], group: [1, 3], weight: 3 },
    variant: (b) => (b === Biome.SNOW ? 1 : 0),
    drops: () => [],
  },
  {
    kind: Mob.GOAT, key: 'goat', name: 'עז', hostile: false, width: 0.9, height: 1.3, health: 10, speed: 1.8, damage: 2,
    animal: { food: [I.SUNWHEAT], milk: true, rams: true },
    habitat: { biomes: [Biome.MOUNTAINS, Biome.SNOW], ground: [B.STONE, B.SNOW, B.FROST_TURF, B.GRASS], group: [1, 3], weight: 6 },
    variant: (_b, r) => (r() < 0.5 ? 0 : 1),
    drops: (r) => drop(I.RAW_MEAT, n(r, 1, 2)),
  },
  {
    kind: Mob.GLOOMWALKER, key: 'gloomwalker', name: 'הולך-אפלה', hostile: true, width: 0.6, height: 1.9, health: 20, speed: 2.6, damage: 3,
    sunSensitive: true, spawnWeight: 4, group: [2, 4], followRange: 32, zones: ['surface', 'cave'],
    drops: (r) => drop(I.GLOOM_ASH, n(r, 0, 2)),
  },
  {
    kind: Mob.THORNSLINGER, key: 'thornslinger', name: 'קוצן', hostile: true, width: 0.8, height: 1.1, health: 16, speed: 2.0, damage: 2,
    zones: ['surface', 'cave'],
    drops: (r) => drop(I.STICK, n(r, 1, 3)),
  },
  {
    kind: Mob.SKITTERLING, key: 'skitterling', name: 'זחלן', hostile: true, width: 1.2, height: 0.6, health: 12, speed: 3.8, damage: 2,
    climber: true, zones: ['surface', 'cave'],
    drops: (r) => drop(I.SILK, n(r, 0, 2)),
  },
  {
    kind: Mob.SPORECAP, key: 'sporecap', name: 'פטריון', hostile: true, width: 0.8, height: 1.3, health: 14, speed: 2.2, damage: 0,
    zones: ['surface', 'cave'],
    drops: (r) => drop(I.SPORE_POWDER, n(r, 1, 2)),
  },
  // --- Stage C: wildlife, a turtle and a donkey ---
  {
    // Schools of fish: perch in temperate water, salmon in the cold, colourful reef fish in warm water.
    kind: Mob.FISH, key: 'fish', name: 'דג', hostile: false, width: 0.5, height: 0.35, health: 3, speed: 3.2, damage: 0,
    ambient: true, swimmer: true, zones: ['water'], spawnWeight: 8, group: [3, 5],
    variant: (b, r) => (b === Biome.SNOW || b === Biome.FROZEN_OCEAN || b === Biome.MOUNTAINS ? 1 : b === Biome.BEACH || b === Biome.DESERT || r() < 0.25 ? 2 + Math.floor(r() * 4) : 0),
    drops: () => [{ id: I.RAW_FISH, count: 1 }],
  },
  {
    // Drifts along the bottom; squirts ink and jets away when touched.
    kind: Mob.OCTOPUS, key: 'octopus', name: 'תמנון', hostile: false, width: 0.8, height: 0.8, health: 10, speed: 1.6, damage: 0,
    ambient: true, swimmer: true, zones: ['water'], spawnWeight: 2, group: [1, 1],
    variant: (_b, r) => (r() < 0.6 ? 0 : 1),
    drops: (r) => drop(I.RAW_FISH, n(r, 0, 1)),
  },
  {
    // Small flocks that perch, hop and peck, and burst into the air when someone comes close.
    kind: Mob.SONGBIRD, key: 'songbird', name: 'ציפור שיר', hostile: false, width: 0.35, height: 0.35, health: 2, speed: 5, damage: 0,
    ambient: true, flier: true, zones: ['surface'], spawnWeight: 6, group: [2, 4],
    variant: (b, r) => (b === Biome.SNOW ? 2 : Math.floor(r() * 4)),
    drops: (r) => drop(I.FEATHER, r() < 0.5 ? 1 : 0),
  },
  {
    // Flutters about caves at random and roosts upside down under ceilings.
    kind: Mob.BAT, key: 'bat', name: 'עטלף', hostile: false, width: 0.5, height: 0.6, health: 4, speed: 3.6, damage: 0,
    ambient: true, flier: true, zones: ['cave'], spawnWeight: 3, group: [1, 3],
    variant: (_b, r) => (r() < 0.5 ? 0 : 1),
    drops: () => [],
  },
  {
    kind: Mob.TURTLE, key: 'turtle', name: 'צב ים', hostile: false, width: 1.0, height: 0.5, health: 20, speed: 0.9, damage: 0,
    swimmer: true,
    animal: { food: [I.FROSTBERRIES] },
    habitat: { biomes: [Biome.BEACH], ground: [B.SAND], group: [2, 4], weight: 6 },
    variant: (_b, r) => (r() < 0.7 ? 0 : 1),
    drops: () => [],
  },
  {
    kind: Mob.DONKEY, key: 'donkey', name: 'חמור', hostile: false, width: 1.2, height: 1.45, health: 18, speed: 1.9, damage: 0,
    animal: { food: [I.SUNWHEAT, I.ASHFRUIT], tame: 'ride', ride: { speed: 6.5, jump: 8.6 } },
    habitat: { biomes: [Biome.PLAINS, Biome.DESERT], ground: [B.GRASS, B.SAND], group: [1, 3], weight: 3 },
    variant: (_b, r) => (r() < 0.6 ? 0 : 1),
    drops: (r) => drop(I.HIDE, n(r, 0, 2)),
  },
  // --- Stage B monsters (Cubica's own) ---
  {
    // A night flier with wide membrane wings: circles high, then dives. Torchlight keeps it away; sunlight burns it.
    kind: Mob.DUSKWING, key: 'duskwing', name: 'כנף-דמדומים', hostile: true, width: 0.9, height: 0.6, health: 10, speed: 5.5, damage: 3,
    flier: true, sunSensitive: true, fearsLight: 9, followRange: 28, zones: ['air'], spawnWeight: 2, group: [1, 2],
    drops: (r) => drop(I.DUSK_MEMBRANE, n(r, 0, 2)),
  },
  {
    // A lurking eel with a glowing lure; bites swimmers, flops helplessly on land.
    kind: Mob.MIREFIN, key: 'mirefin', name: 'סנפיר-ביצה', hostile: true, width: 0.7, height: 0.5, health: 12, speed: 4.2, damage: 3,
    swimmer: true, followRange: 16, zones: ['water'], spawnWeight: 2, group: [1, 2],
    drops: (r) => drop(I.RAW_FISH, n(r, 1, 2)),
  },
  {
    // A slow cave crawler under a stone shell: blows from the front barely scratch it (a pickaxe cracks it).
    kind: Mob.CRAGBACK, key: 'cragback', name: 'גב-סלע', hostile: true, width: 1.1, height: 0.9, health: 24, speed: 1.6, damage: 5,
    frontArmor: 0.2, heavy: true, zones: ['cave'], spawnWeight: 3, group: [1, 1],
    drops: (r) => [...drop(B.RUBBLESTONE, n(r, 1, 3)), ...drop(I.RAW_IRON, n(r, 0, 2))],
  },
  {
    // A hooded wraith, almost invisible until close; blinks behind its prey. Bright light drives it off.
    kind: Mob.SHADE, key: 'shade', name: 'צל-חלול', hostile: true, width: 0.6, height: 1.9, health: 16, speed: 2.4, damage: 4,
    fearsLight: 10, followRange: 24, zones: ['surface', 'cave'], spawnWeight: 1, group: [1, 1],
    drops: (r) => drop(I.LUMEN_DUST, n(r, 1, 2)),
  },
  {
    // A rare hulking giant of rock and roots: winds up and slams the ground. Its glowing core on the back is soft.
    kind: Mob.BRAMBLEHULK, key: 'bramblehulk', name: 'ענק-קוצים', hostile: true, width: 1.4, height: 2.7, health: 60, speed: 1.7, damage: 8,
    backWeakness: 2, heavy: true, followRange: 24, zones: ['surface'], spawnWeight: 0.4, group: [1, 1],
    drops: (r) => [...drop(B.LUMEN_CRYSTAL, n(r, 1, 2)), ...drop(I.IRON_INGOT, n(r, 1, 3)), ...drop(I.STICK, n(r, 2, 5))],
  },
  {
    // Glowing beetles of the Ember Deep that swarm and leap.
    kind: Mob.EMBER_MITE, key: 'ember_mite', name: 'קרדית-גחלים', hostile: true, width: 0.5, height: 0.4, health: 4, speed: 3.4, damage: 1,
    followRange: 20, zones: ['deep'], spawnWeight: 4, group: [3, 5],
    drops: (r) => drop(I.EMBER_SHARD, r() < 0.4 ? 1 : 0),
  },
  {
    // Boss of the Ember Deep, woken at an ember altar: charges (and stuns itself on walls), spits embers,
    // and calls mites when hurt.
    kind: Mob.MATRIARCH, key: 'matriarch', name: 'אם-הגחלים', hostile: true, width: 2.6, height: 2.0, health: 300, speed: 2.0, damage: 9,
    boss: true, heavy: true, followRange: 48,
    drops: (r) => [{ id: I.MATRIARCH_HEART, count: 1 }, ...drop(I.EMBER_SHARD, n(r, 10, 16)), ...drop(I.DIAMOND, n(r, 2, 4))],
  },
];

DEFS.push({
  kind: Mob.TRADER, key: 'trader', name: 'סוחר', hostile: false, width: 0.6, height: 1.9, health: 20, speed: 1.2, damage: 0,
  trader: true, drops: () => [],
});

const byKind = new Map<number, MobDef>(DEFS.map((d) => [d.kind, d]));

export function mobDef(kind: number): MobDef | undefined {
  return byKind.get(kind);
}

export const PASSIVE_MOBS = DEFS.filter((d) => !d.hostile && !d.trader && !d.ambient).map((d) => d.kind);
/** Every creature kind, for the gallery and the summon command. */
export const ALL_MOBS = DEFS.map((d) => d.kind);

/** Animals that may appear by themselves in a biome (with their weights). */
export function animalsFor(biome: number): MobDef[] {
  return DEFS.filter((d) => d.habitat?.biomes.includes(biome));
}

/** Monsters that may appear by themselves in a zone. */
export function monstersFor(zone: Zone): number[] {
  return DEFS.filter((d) => d.hostile && d.zones?.includes(zone)).map((d) => d.kind);
}

/** Wildlife that may appear by itself in a zone. */
export function ambientFor(zone: Zone): number[] {
  return DEFS.filter((d) => d.ambient && d.zones?.includes(zone)).map((d) => d.kind);
}

/** What a creature may be called (name tags): 1–24 letters, digits, spaces, - _ ' . */
export function sanitizeMobName(name: unknown): string | null {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (s.length < 1 || s.length > 24 || !/^[\p{L}\p{N} _'.-]+$/u.test(s)) return null;
  return s;
}

/** Boss/elite fights: the matriarch's projectiles. */
export const EMBER_DAMAGE = 4;

/** Size factor of a baby's body and hit box. */
export const BABY_SCALE = 0.5;
export const HOSTILE_MOBS = DEFS.filter((d) => d.hostile).map((d) => d.kind);

/** A creature kind from `pool` by spawn weight; `r` in [0, 1). Gloomwalkers are the most common night threat. */
export function pickSpawnKind(pool: readonly number[], r: number): number {
  const w = (k: number) => mobDef(k)?.spawnWeight ?? 2;
  let left = r * pool.reduce((sum, k) => sum + w(k), 0);
  for (const k of pool) if ((left -= w(k)) < 0) return k;
  return pool[pool.length - 1];
}


/** Melee range (blocks between bodies) and cooldown. */
export const MOB_REACH = 1.6;
export const MOB_ATTACK_TICKS = 20;
/** Player melee reach and cooldown (seconds). */
export const PLAYER_ATTACK_REACH = 4;
export const PLAYER_ATTACK_COOLDOWN = 0.4;
/** Sporecap: puff warning time (ticks), cloud radius and damage at the centre. */
export const SPORE_FUSE_TICKS = 30;
export const SPORE_RADIUS = 4;
export const SPORE_DAMAGE = 7;
