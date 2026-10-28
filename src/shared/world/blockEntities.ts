import type { Slot } from '../items/Inventory';

/** Extra per-block data stored with a chunk (keyed by block index in the chunk). */
export type BlockEntity =
  | { kind: 'chest'; slots: Slot[] }
  | { kind: 'furnace'; slots: Slot[]; burn: number; burnMax: number; cook: number };
