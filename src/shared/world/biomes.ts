export const Biome = {
  OCEAN: 0,
  FROZEN_OCEAN: 1,
  BEACH: 2,
  PLAINS: 3,
  FOREST: 4,
  DESERT: 5,
  SNOW: 6,
  MOUNTAINS: 7,
} as const;

export type BiomeId = (typeof Biome)[keyof typeof Biome];

export const BIOME_NAMES = ['Ocean', 'Frozen Ocean', 'Beach', 'Plains', 'Forest', 'Desert', 'Snowfield', 'Mountains'];
