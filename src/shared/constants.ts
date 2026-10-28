export const CHUNK_SIZE = 16;
export const CHUNK_HEIGHT = 256;
export const CHUNK_AREA = CHUNK_SIZE * CHUNK_SIZE;
export const CHUNK_VOLUME = CHUNK_AREA * CHUNK_HEIGHT;
export const SEA_LEVEL = 62;

export const TICKS_PER_SECOND = 20;
export const TICK_MS = 1000 / TICKS_PER_SECOND;
/** One full day/night cycle: 20 minutes. */
export const DAY_LENGTH_TICKS = 24000;

export const PROTOCOL_VERSION = 1;
export const DEFAULT_VIEW_DISTANCE = 8;
export const MAX_PLAYERS = 8;
