// Host <-> client protocol. Every gameplay action goes through these messages,
// even in single player (over an in-memory transport), so multiplayer adds only a
// network transport. Messages marked (stage N) are reserved and not handled yet.

import type { InventoryState, Slot } from '../items/Inventory';
import type { ItemStack } from '../items/registry';
import type { Trade } from '../entities/trades';
import type { WindowKind } from '../items/Window';

export type Vec3 = [number, number, number];

/** Bit flags in ClientMsg 'move'. */
export const MoveFlag = {
  ON_GROUND: 1,
  SNEAK: 2,
  SPRINT: 4,
  FLYING: 8,
  /** Bounced off a bed since the last move (halves fall damage). */
  BOUNCED: 16,
} as const;

export type ClientMsg =
  /** `token`: Firebase ID token of a signed-in player (the host verifies it). */
  | { t: 'hello'; v: number; name: string; token?: string }
  | { t: 'move'; seq: number; x: number; y: number; z: number; yaw: number; pitch: number; flags: number }
  /** phase 0 = start, 1 = abort, 2 = finish */
  | { t: 'dig'; phase: 0 | 1 | 2; x: number; y: number; z: number; face: number }
  /**
   * (x, y, z) is the cell the new block goes into, `raw` the block value incl. state
   * (orientation); the item comes from hotbar `slot`.
   */
  | { t: 'place'; x: number; y: number; z: number; raw: number; slot: number }
  | { t: 'held'; slot: number }
  /** Right-click on an interactive block (workbench, furnace, chest, door, bedroll). */
  | { t: 'useBlock'; x: number; y: number; z: number }
  /** Eating: phase 0 = start, 1 = abort, 2 = finish. */
  | { t: 'useItem'; phase: 0 | 1 | 2; slot: number }
  /** Q: drop one (or the whole stack) of the held item. */
  | { t: 'drop'; all: boolean }
  | { t: 'attack'; entityId: number }
  /** Right-click on a creature (traders). */
  | { t: 'interact'; entityId: number }
  | { t: 'trade'; entityId: number; offer: number }
  /** Client settings the host needs. */
  | { t: 'settings'; viewDistance: number }
  /** Click in a window (see Window.ts); window 0 is the player's inventory. */
  | { t: 'inv'; window: number; action: number; slot: number; button: number; item?: number }
  | { t: 'closeWindow'; window: number }
  /** Host only. */
  | { t: 'setGameMode'; mode: number }
  | { t: 'chat'; text: string }
  | { t: 'pong'; id: number }
  | { t: 'respawn' };

export interface PlayerInfo {
  id: number;
  name: string;
}

export interface PlayerListEntry extends PlayerInfo {
  /** Round-trip time in ms (-1 = unknown). */
  ping: number;
  host: boolean;
  /** Signed in with a verified Google account. */
  verified?: boolean;
}

/** Bit flags in EntityState.anim. */
export const Anim = {
  SNEAK: 1,
  SWING: 2,
  FLYING: 4,
} as const;

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
  /** `id` is the raw block value (id + state). */
  | { t: 'blockChange'; x: number; y: number; z: number; id: number }
  | { t: 'entitySpawn'; entity: EntityInfo }
  | { t: 'entityDespawn'; id: number; pickedBy?: number }
  /** Positions of moving entities, flat [id, x, y, z, …]. */
  | { t: 'entityMove'; data: number[] }
  /** Creature movement, flat [id, x, y, z, yaw, anim, …] (10 Hz). */
  | { t: 'mobMove'; data: number[] }
  | { t: 'entityEvent'; id: number; event: 'hurt' | 'death' | 'spores' }
  /** A trader's offers (after 'interact'). */
  | { t: 'trades'; entityId: number; profession: number; offers: Trade[] }
  /** The host pushes this player (hit by a creature). */
  | { t: 'knockback'; vx: number; vy: number; vz: number }
  /** Other players' positions (10 Hz). */
  | { t: 'snapshot'; entities: EntityState[] }
  | { t: 'teleport'; x: number; y: number; z: number }
  | { t: 'inventory'; state: InventoryState }
  /** Contents of an open window's container slots (window 0 = own crafting grid). */
  | { t: 'window'; id: number; kind: WindowKind; slots: Slot[]; progress?: [number, number] }
  | { t: 'closeWindow'; id: number }
  | { t: 'gameMode'; mode: number }
  | { t: 'stats'; health: number; food: number; air: number }
  | { t: 'hurt'; amount: number }
  | { t: 'death'; message: string }
  | { t: 'time'; time: number }
  /** System messages use from = ''. */
  | { t: 'chat'; from: string; text: string }
  | { t: 'playerJoin'; player: PlayerInfo }
  | { t: 'playerLeave'; id: number }
  | { t: 'playerList'; players: PlayerListEntry[] }
  | { t: 'ping'; id: number }
  | { t: 'kick'; reason: string }
  /**
   * Who carries the world on if the host leaves: a shared (cloud) world, its fixed invite code, and the
   * signed-in players in the order they take over. Sent with every player list.
   */
  | { t: 'succession'; worldId: string; code: string; order: Array<{ id: number; name: string }> };

export type EntityInfo =
  | { id: number; kind: 'item'; x: number; y: number; z: number; item: ItemStack }
  | { id: number; kind: 'mob'; mob: number; x: number; y: number; z: number; yaw: number; variant?: number }
  /** A flying thorn; clients extrapolate it from its launch velocity. */
  | { id: number; kind: 'projectile'; x: number; y: number; z: number; vx: number; vy: number; vz: number }
  /** Falling sand/gravel (`raw` block value); moves arrive in entityMove like items. */
  | { id: number; kind: 'block'; raw: number; x: number; y: number; z: number };
