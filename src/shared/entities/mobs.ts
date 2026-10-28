import { B } from '../blocks/registry';
import { I, type ItemStack } from '../items/registry';

// Cubica's own creatures. Shared by host (AI, physics, drops) and client (models, hit boxes).

export const Mob = {
  GRAZER: 1,
  TUSKLING: 2,
  STILTFOWL: 3,
  HORNOX: 4,
  GLOOMWALKER: 10,
  THORNSLINGER: 11,
  SKITTERLING: 12,
  SPORECAP: 13,
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
  drops: (rnd: () => number) => ItemStack[];
}

const n = (rnd: () => number, min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));
const drop = (id: number, count: number): ItemStack[] => (count > 0 ? [{ id, count }] : []);

const DEFS: MobDef[] = [
  {
    kind: Mob.GRAZER, key: 'grazer', name: 'צמרן', hostile: false, width: 0.9, height: 1.1, health: 8, speed: 1.5, damage: 0,
    drops: (r) => [...drop(I.FLEECE, n(r, 1, 2)), ...drop(I.RAW_MEAT, n(r, 1, 2))],
  },
  {
    kind: Mob.TUSKLING, key: 'tuskling', name: 'חטון', hostile: false, width: 0.8, height: 0.8, health: 10, speed: 1.7, damage: 0,
    drops: (r) => drop(I.RAW_MEAT, n(r, 1, 3)),
  },
  {
    kind: Mob.STILTFOWL, key: 'stiltfowl', name: 'רגלון', hostile: false, width: 0.5, height: 1.3, health: 4, speed: 2.0, damage: 0,
    drops: (r) => drop(I.RAW_MEAT, n(r, 0, 1) + 1),
  },
  {
    kind: Mob.HORNOX, key: 'hornox', name: 'קרנוף', hostile: false, width: 1.2, height: 1.5, health: 14, speed: 1.3, damage: 0,
    drops: (r) => [...drop(I.HIDE, n(r, 1, 2)), ...drop(I.RAW_MEAT, n(r, 2, 3))],
  },
  {
    kind: Mob.GLOOMWALKER, key: 'gloomwalker', name: 'הולך-אפלה', hostile: true, width: 0.6, height: 1.9, health: 20, speed: 2.6, damage: 3,
    sunSensitive: true,
    drops: (r) => drop(I.GLOOM_ASH, n(r, 0, 2)),
  },
  {
    kind: Mob.THORNSLINGER, key: 'thornslinger', name: 'קוצן', hostile: true, width: 0.8, height: 1.1, health: 16, speed: 2.0, damage: 2,
    drops: (r) => drop(I.STICK, n(r, 1, 3)),
  },
  {
    kind: Mob.SKITTERLING, key: 'skitterling', name: 'זחלן', hostile: true, width: 1.2, height: 0.6, health: 12, speed: 3.8, damage: 2,
    climber: true,
    drops: (r) => drop(I.SILK, n(r, 0, 2)),
  },
  {
    kind: Mob.SPORECAP, key: 'sporecap', name: 'פטריון', hostile: true, width: 0.8, height: 1.3, health: 14, speed: 2.2, damage: 0,
    drops: (r) => drop(I.SPORE_POWDER, n(r, 1, 2)),
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

export const PASSIVE_MOBS = DEFS.filter((d) => !d.hostile && !d.trader).map((d) => d.kind);
export const HOSTILE_MOBS = DEFS.filter((d) => d.hostile).map((d) => d.kind);

/** Where passive herds may appear. */
export const PASTURE_BLOCKS = new Set<number>([B.GRASS, B.FROST_TURF]);

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
