import { GameMode } from '../../shared/constants';
import type { InventoryState } from '../../shared/items/Inventory';
import type { Vec3 } from '../../shared/protocol/messages';
import { decodeChunk } from '../../shared/world/chunkCodec';
import { packWorldFile, unpackWorldFile } from '../../shared/world/worldFile';

// Worlds live in IndexedDB on the host's machine:
//   store 'worlds': WorldMeta by id
//   store 'chunks': chunkCodec bytes by "<worldId>:<cx>,<cz>" (only chunks that were changed;
//                   untouched chunks are regenerated from the seed)

export { GameMode };

export interface PlayerSave {
  pos: Vec3;
  yaw: number;
  pitch: number;
  flying: boolean;
  gameMode: number;
  inventory: InventoryState;
  // Added in stage 3 (optional so older saves still load).
  health?: number;
  food?: number;
  saturation?: number;
  air?: number;
  /** Bedroll respawn point. */
  spawnPoint?: Vec3;
}

export interface WorldMeta {
  version: 1;
  id: string;
  name: string;
  seed: number;
  gameMode: number;
  created: number;
  lastPlayed: number;
  time: number;
  players: Record<string, PlayerSave>;
}

/** Minimal persistence interface the server needs (lets tests run without IndexedDB). */
export interface ChunkStore {
  loadChunk(cx: number, cz: number): Promise<Uint8Array | undefined>;
  saveChunks(chunks: Array<{ cx: number; cz: number; data: Uint8Array }>): Promise<void>;
  saveMeta(meta: WorldMeta): Promise<void>;
}

const DB_NAME = 'cubica';
const DB_VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

const chunkRange = (worldId: string) => IDBKeyRange.bound(`${worldId}:`, `${worldId}:￿`);

export class WorldStorage {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(): Promise<WorldStorage> {
    if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is not available');
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('worlds')) db.createObjectStore('worlds', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks');
    };
    return new WorldStorage(await req(open));
  }

  async listWorlds(): Promise<WorldMeta[]> {
    const tx = this.db.transaction('worlds', 'readonly');
    const all = (await req(tx.objectStore('worlds').getAll())) as WorldMeta[];
    return all.sort((a, b) => b.lastPlayed - a.lastPlayed);
  }

  async getWorld(id: string): Promise<WorldMeta | undefined> {
    const tx = this.db.transaction('worlds', 'readonly');
    return (await req(tx.objectStore('worlds').get(id))) as WorldMeta | undefined;
  }

  async saveMeta(meta: WorldMeta): Promise<void> {
    const tx = this.db.transaction('worlds', 'readwrite');
    tx.objectStore('worlds').put(meta);
    await done(tx);
  }

  async deleteWorld(id: string): Promise<void> {
    const tx = this.db.transaction(['worlds', 'chunks'], 'readwrite');
    tx.objectStore('worlds').delete(id);
    tx.objectStore('chunks').delete(chunkRange(id));
    await done(tx);
  }

  /** A ChunkStore bound to one world. */
  forWorld(worldId: string): ChunkStore {
    return {
      loadChunk: async (cx, cz) => {
        const tx = this.db.transaction('chunks', 'readonly');
        return (await req(tx.objectStore('chunks').get(`${worldId}:${cx},${cz}`))) as Uint8Array | undefined;
      },
      saveChunks: async (chunks) => {
        if (chunks.length === 0) return;
        const tx = this.db.transaction('chunks', 'readwrite');
        const store = tx.objectStore('chunks');
        for (const c of chunks) store.put(c.data, `${worldId}:${c.cx},${c.cz}`);
        await done(tx);
      },
      saveMeta: (meta) => this.saveMeta(meta),
    };
  }

  /** Every saved chunk of a world, with its coordinates (for cloud uploads). */
  async allChunks(worldId: string): Promise<Array<{ cx: number; cz: number; data: Uint8Array }>> {
    const tx = this.db.transaction('chunks', 'readonly');
    const store = tx.objectStore('chunks');
    const [keys, values] = await Promise.all([req(store.getAllKeys(chunkRange(worldId))), req(store.getAll(chunkRange(worldId)))]);
    return keys.map((k, i) => {
      const [cx, cz] = String(k).slice(worldId.length + 1).split(',').map(Number);
      return { cx, cz, data: values[i] as Uint8Array };
    });
  }

  /** Replaces a world (meta + all chunks) with a copy from elsewhere (cloud download). */
  async replaceWorld(meta: WorldMeta, chunks: Array<{ cx: number; cz: number; data: Uint8Array }>): Promise<void> {
    const tx = this.db.transaction(['worlds', 'chunks'], 'readwrite');
    const store = tx.objectStore('chunks');
    store.delete(chunkRange(meta.id));
    for (const c of chunks) store.put(c.data, `${meta.id}:${c.cx},${c.cz}`);
    tx.objectStore('worlds').put(meta);
    await done(tx);
  }

  async exportWorld(id: string): Promise<Blob> {
    const meta = await this.getWorld(id);
    if (!meta) throw new Error('העולם לא נמצא');
    const tx = this.db.transaction('chunks', 'readonly');
    const chunks = (await req(tx.objectStore('chunks').getAll(chunkRange(id)))) as Uint8Array[];
    const file = packWorldFile(meta, chunks);
    return new Blob([file], { type: 'application/octet-stream' });
  }

  async importWorld(data: Uint8Array): Promise<WorldMeta> {
    const { header, chunks } = unpackWorldFile(data);
    const h = header as Partial<WorldMeta>;
    if (h.version !== 1 || typeof h.seed !== 'number' || typeof h.name !== 'string') {
      throw new Error('קובץ עולם לא תקין (כותרת חסרה)');
    }
    const existing = new Set((await this.listWorlds()).map((w) => w.name));
    let name = h.name;
    for (let n = 2; existing.has(name); n++) name = `${h.name} (${n})`;
    const meta: WorldMeta = {
      version: 1,
      id: newWorldId(),
      name,
      seed: h.seed,
      gameMode: h.gameMode ?? GameMode.SURVIVAL,
      created: h.created ?? Date.now(),
      lastPlayed: Date.now(),
      time: h.time ?? 1000,
      players: h.players ?? {},
    };
    const tx = this.db.transaction(['worlds', 'chunks'], 'readwrite');
    const store = tx.objectStore('chunks');
    for (const bytes of chunks) {
      const c = decodeChunk(bytes); // validates every chunk before it is stored
      store.put(bytes, `${meta.id}:${c.cx},${c.cz}`);
    }
    tx.objectStore('worlds').put(meta);
    await done(tx);
    return meta;
  }
}

export function newWorldId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function newWorldMeta(name: string, seed: number, gameMode: number): WorldMeta {
  const now = Date.now();
  return { version: 1, id: newWorldId(), name, seed, gameMode, created: now, lastPlayed: now, time: 1000, players: {} };
}
