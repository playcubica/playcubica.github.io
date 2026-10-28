import type { Bytes, Firestore } from 'firebase/firestore';
import type { ChunkStore, WorldMeta } from '../server/storage/WorldStorage';
import { firebaseApp } from './account';

// Cloud saves for signed-in players, in Firestore (see firestore.rules):
//   users/{uid}/worlds/{worldId}                  { meta: JSON string of WorldMeta, updatedAt }
//   users/{uid}/worlds/{worldId}/chunks/{cx}_{cz}  { d: Bytes (chunkCodec) }
// IndexedDB stays the working copy; the cloud is a mirror that is pushed every minute and on
// exit, and pulled when a world is opened and the cloud copy is newer.

export interface ChunkBlob {
  cx: number;
  cz: number;
  data: Uint8Array;
}

export interface CloudWorldInfo {
  meta: WorldMeta;
  updatedAt: number;
}

/** What the sync logic needs from the cloud (Firestore in the game, a Map in tests). */
export interface CloudBackend {
  listWorlds(): Promise<CloudWorldInfo[]>;
  putWorld(meta: WorldMeta, chunks: ChunkBlob[]): Promise<void>;
  getWorld(id: string): Promise<{ meta: WorldMeta; chunks: ChunkBlob[] } | null>;
  deleteWorld(id: string): Promise<void>;
}

/** Firestore batches: at most 500 writes and 10 MiB; stay well inside both. */
const BATCH_WRITES = 200;
const BATCH_BYTES = 4 << 20;

export class FirestoreWorlds implements CloudBackend {
  private constructor(private readonly db: Firestore, private readonly uid: string, private readonly fs: typeof import('firebase/firestore')) {}

  static async open(uid: string): Promise<FirestoreWorlds> {
    const app = await firebaseApp();
    const fs = await import('firebase/firestore');
    return new FirestoreWorlds(fs.getFirestore(app), uid, fs);
  }

  private worlds() {
    return this.fs.collection(this.db, 'users', this.uid, 'worlds');
  }

  async listWorlds(): Promise<CloudWorldInfo[]> {
    const snap = await this.fs.getDocs(this.worlds());
    const out: CloudWorldInfo[] = [];
    snap.forEach((d) => {
      try {
        const meta = JSON.parse(d.get('meta')) as WorldMeta;
        if (meta?.id === d.id) out.push({ meta, updatedAt: Number(d.get('updatedAt')) || meta.lastPlayed });
      } catch {
        // skip a damaged entry
      }
    });
    return out;
  }

  async putWorld(meta: WorldMeta, chunks: ChunkBlob[]): Promise<void> {
    const { writeBatch, doc, Bytes } = this.fs;
    const worldRef = doc(this.worlds(), meta.id);
    let batch = writeBatch(this.db);
    let writes = 0;
    let bytes = 0;
    for (const c of chunks) {
      if (writes >= BATCH_WRITES || bytes + c.data.length > BATCH_BYTES) {
        await batch.commit();
        batch = writeBatch(this.db);
        writes = 0;
        bytes = 0;
      }
      batch.set(doc(worldRef, 'chunks', `${c.cx}_${c.cz}`), { d: Bytes.fromUint8Array(c.data) });
      writes++;
      bytes += c.data.length;
    }
    // The world entry goes last, so a listed world never points at chunks that aren't there yet.
    batch.set(worldRef, { meta: JSON.stringify(meta), updatedAt: meta.lastPlayed });
    await batch.commit();
  }

  async getWorld(id: string): Promise<{ meta: WorldMeta; chunks: ChunkBlob[] } | null> {
    const { doc, getDoc, getDocs, collection } = this.fs;
    const worldRef = doc(this.worlds(), id);
    const w = await getDoc(worldRef);
    if (!w.exists()) return null;
    const meta = JSON.parse(w.get('meta')) as WorldMeta;
    const snap = await getDocs(collection(worldRef, 'chunks'));
    const chunks: ChunkBlob[] = [];
    snap.forEach((d) => {
      const [cx, cz] = d.id.split('_').map(Number);
      const bytes = d.get('d') as Bytes | undefined;
      if (bytes && Number.isInteger(cx) && Number.isInteger(cz)) chunks.push({ cx, cz, data: bytes.toUint8Array() });
    });
    return { meta, chunks };
  }

  async deleteWorld(id: string): Promise<void> {
    const { doc, getDocs, collection, writeBatch } = this.fs;
    const worldRef = doc(this.worlds(), id);
    const snap = await getDocs(collection(worldRef, 'chunks'));
    const refs = snap.docs.map((d) => d.ref);
    for (let i = 0; i < refs.length; i += 400) {
      const batch = writeBatch(this.db);
      refs.slice(i, i + 400).forEach((r) => batch.delete(r));
      await batch.commit();
    }
    const batch = writeBatch(this.db);
    batch.delete(worldRef);
    await batch.commit();
  }
}

export const CLOUD_PUSH_INTERVAL_MS = 60_000;

/**
 * A ChunkStore that writes to the local store and mirrors to the cloud. The first push of a
 * session uploads every saved chunk (so a world that was played offline catches up); later
 * pushes send only what changed. Failed pushes keep their chunks for the next attempt.
 */
export class SyncedStore implements ChunkStore {
  private pending = new Map<string, ChunkBlob>();
  private needFull = true;
  private meta: WorldMeta | null = null;
  private lastPush = -Infinity;
  private pushing: Promise<void> = Promise.resolve();
  /** Hebrew description of the last failure, or null when the cloud is up to date. */
  problem: string | null = null;

  constructor(
    private readonly local: ChunkStore,
    private readonly cloud: CloudBackend,
    private readonly allLocalChunks: () => Promise<ChunkBlob[]>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  loadChunk(cx: number, cz: number): Promise<Uint8Array | undefined> {
    return this.local.loadChunk(cx, cz);
  }

  async saveChunks(chunks: ChunkBlob[]): Promise<void> {
    await this.local.saveChunks(chunks);
    for (const c of chunks) this.pending.set(`${c.cx},${c.cz}`, c);
  }

  async saveMeta(meta: WorldMeta): Promise<void> {
    await this.local.saveMeta(meta);
    this.meta = meta;
    if (this.now() - this.lastPush >= CLOUD_PUSH_INTERVAL_MS) void this.flush();
  }

  /** Pushes everything not yet in the cloud. Pushes are serialized. */
  flush(): Promise<void> {
    this.pushing = this.pushing.then(() => this.push());
    return this.pushing;
  }

  private async push(): Promise<void> {
    const meta = this.meta;
    if (!meta) return;
    this.lastPush = this.now();
    const full = this.needFull;
    const sending = full ? await this.allLocalChunks() : [...this.pending.values()];
    const sent = new Map(this.pending);
    try {
      await this.cloud.putWorld(meta, sending);
      for (const [k, c] of sent) if (this.pending.get(k) === c) this.pending.delete(k);
      if (full) this.needFull = false;
      this.problem = null;
    } catch (err) {
      console.warn('cloud save failed', err);
      this.problem = 'השמירה בענן נכשלה — העולם שמור במחשב הזה וננסה שוב.';
    }
  }
}
