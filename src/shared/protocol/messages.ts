// Host <-> client protocol. Every gameplay action goes through these messages,
// even in single player (over an in-memory transport), so multiplayer adds only a
// network transport. Messages marked (stage N) are reserved and not handled yet.

import type { InventoryState } from '../items/Inventory';

export type Vec3 = [number, number, number];

/** Bit flags in ClientMsg 'move'. */
export const MoveFlag = {
  ON_GROUND: 1,
  SNEAK: 2,
  SPRINT: 4,
  FLYING: 8,
} as const;

export type ClientMsg =
  | { t: 'hello'; v: number; name: string }
  | { t: 'move'; seq: number; x: number; y: number; z: number; yaw: number; pitch: number; flags: number }
  /** phase 0 = start, 1 = abort, 2 = finish */
  | { t: 'dig'; phase: 0 | 1 | 2; x: number; y: number; z: number; face: number }
  /** (x, y, z) is the cell the new block goes into; it comes from the selected hotbar slot. */
  | { t: 'place'; x: number; y: number; z: number; face: number; slot: number }
  | { t: 'held'; slot: number }
  | { t: 'useBlock'; x: number; y: number; z: number; face: number } // (stage 3)
  | { t: 'useItem'; slot: number } // (stage 3)
  | { t: 'attack'; entityId: number } // (stage 5)
  /** See InvAction in shared/items/Inventory.ts. */
  | { t: 'inv'; action: number; slot: number; button: number; item?: number }
  /** Host only. */
  | { t: 'setGameMode'; mode: number }
  | { t: 'chat'; text: string } // (stage 4)
  | { t: 'respawn' }; // (stage 3)

export interface PlayerInfo {
  id: number;
  name: string;
}

export interface EntityState {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  anim: number;
}

export type ServerMsg =
  | {
      t: 'welcome';
      playerId: number;
      seed: number;
      time: number;
      /** Where this player appears (their saved position, or the world spawn). */
      spawn: Vec3;
      yaw: number;
      pitch: number;
      flying: boolean;
      gameMode: number;
      isHost: boolean;
      viewDistance: number;
      players: PlayerInfo[];
    }
  | { t: 'chunk'; cx: number; cz: number; data: Uint8Array }
  | { t: 'unloadChunk'; cx: number; cz: number }
  | { t: 'blockChange'; x: number; y: number; z: number; id: number }
  | { t: 'blockBatch'; changes: number[] } // (stage 3) flat [x, y, z, id, ...]
  | { t: 'digProgress'; playerId: number; x: number; y: number; z: number; stage: number } // (stage 4)
  | { t: 'snapshot'; entities: EntityState[] } // (stage 4)
  | { t: 'entitySpawn'; id: number; kind: string; data: unknown } // (stage 5)
  | { t: 'entityDespawn'; id: number } // (stage 5)
  | { t: 'correction'; x: number; y: number; z: number } // (stage 4)
  | { t: 'inventory'; state: InventoryState }
  | { t: 'gameMode'; mode: number }
  | { t: 'stats'; health: number; food: number; air: number } // (stage 3)
  | { t: 'time'; time: number }
  | { t: 'chat'; from: string; text: string } // (stage 4)
  | { t: 'playerJoin'; player: PlayerInfo } // (stage 4)
  | { t: 'playerLeave'; id: number } // (stage 4)
  | { t: 'kick'; reason: string };
