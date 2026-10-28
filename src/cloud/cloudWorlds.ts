import type { Bytes, Firestore } from 'firebase/firestore';
import type { ChunkStore, WorldMeta } from '../server/storage/WorldStorage';
import { firebaseApp } from './account';

// Shared cloud worlds for signed-in players, in Firestore (see firestore.rules):
//   worlds/{worldId}                  { meta: JSON string of WorldMeta, updatedAt, owner, members: [uid],
//                                       names: { uid: name }, host: { uid, name, until } | null }
//   worlds/{worldId}/chunks/{cx}_{cz}  { d: Bytes (chunkCodec) }
// Everyone who plays a world while signed in becomes a member: it shows up in their list and any
// member can open (host) it later, so the world goes on without its creator. Only the owner can
// delete it. IndexedDB stays the working copy; the cloud is pushed every minute and on exit, and
// pulled when a world is opened and the cloud copy is newer.
// Older saves lived in users/{uid}/worlds/…; they are still listed and move over when next saved.

export interface ChunkBlob {
  cx: number;
  cz: number;
  data: Uint8Array;
}

export interface CloudMember {
  uid: string;
  name: string;
}

/** Who is hosting the world right now (refreshed every push; stale after `until`). */
export interface CloudHost extends CloudMember {
  until: number;
}

export interface CloudWorldInfo {
  meta: WorldMeta;
  updatedAt: number;
  owner: string;
  /** uid → name of everyone the world is shared with. */
  members: Record<string, string>;
  host: CloudHost | null;
}

/** Extra fields written with a world: new members, and the hosting lock (null clears it). */
export interface WorldExtras {
  members?: CloudMember[];
  host?: CloudHost | null;
}

/** What the sync logic needs from the cloud (Firestore in the game, a Map in tests). */
export interface CloudBackend {
  readonly uid: string;
  listWorlds(): Promise<CloudWorldInfo[]>;
  putWorld(meta: WorldMeta, chunks: ChunkBlob[], extras?: WorldExtras): Promise<void>;
  getWorld(id: string): Promise<{ meta: WorldMeta; chunks: ChunkBlob[] } | null>;
  /** Owner only: deletes the world for everyone. */
  deleteWorld(id: string): Promise<void>;
  /** Removes the world from this player's list (it stays for the others). */
  leaveWorld(id: string): Promise<void>;
}

/** A host lock lasts this long without a refresh (pushes come every minute). */
export const HOST_LOCK_MS = 3 * 60_000;

/** Firestore batches: at most 500 writes and 10 MiB; stay well inside both. */
const BATCH_WRITES = 200;
const BATCH_BYTES = 4 << 20;

export class FirestoreWorlds implements CloudBackend {
  private constructor(private readonly db: Firestore, readonly uid: string, private readonly name: string, private readonly fs: typeof import('firebase/firestore')) {}

  static async open(uid: string, name: string): Promise<FirestoreWorlds> {
    const app = await firebaseApp();
    const fs = await import('firebase/firestore');
    return new FirestoreWorlds(fs.getFirestore(app), uid, name, fs);
  }

  private worldRef(id: string) {
    return this.fs.doc(this.db, 'worlds', id);
  }

  private legacyRef(id: string) {
    return this.fs.doc(this.db, 'users', this.uid, 'worlds', id);
  }

  async listWorlds(): Promise<CloudWorldInfo[]> {
    const { collection, getDocs, query, where } = this.fs;
    const [shared, legacy] = await Promise.all([
      getDocs(query(collection(this.db, 'worlds'), where('members', 'array-contains', this.uid))),
      getDocs(collection(this.db, 'users', this.uid, 'worlds')).catch(() => null),
    ]);
    const out = new Map<string, CloudWorldInfo>();
    const read = (d: { id: string; get(f: string): unknown }, isLegacy: boolean) => {
      try {
        const meta = JSON.parse(String(d.get('meta'))) as WorldMeta;
        if (meta?.id !== d.id || (isLegacy && out.has(d.id))) return;
        const names = (d.get('names') as Record<string, string> | undefined) ?? {};
        const memberIds = (d.get('members') as string[] | undefined) ?? [this.uid];
        const members: Record<string, string> = {};
        for (const m of memberIds) members[m] = names[m] ?? '';
        const host = d.get('host') as CloudHost | null | undefined;
        out.set(d.id, {
          meta,
          updatedAt: Number(d.get('updatedAt')) || meta.lastPlayed,
          owner: String(d.get('owner') ?? meta.owner ?? this.uid),
          members,
          host: host && typeof host.until === 'number' ? host : null,
        });
      } catch {
        // skip a damaged entry
      }
    };
    shared.forEach((d) => read(d, false));
    legacy?.forEach((d) => read(d, true));
    return [...out.values()];
  }

  async putWorld(meta: WorldMeta, chunks: ChunkBlob[], extras: WorldExtras = {}): Promise<void> {
    const { writeBatch, doc, Bytes, arrayUnion } = this.fs;
    const ref = this.worldRef(meta.id);
    const members = [{ uid: this.uid, name: this.name }, ...(extras.members ?? [])];
    // The world entry rides along in every batch (the rules check membership against it).
    const entry: Record<string, unknown> = {
      meta: JSON.stringify(meta),
      updatedAt: meta.lastPlayed,
      owner: meta.owner ?? this.uid,
      members: arrayUnion(...members.map((m) => m.uid)),
      names: Object.fromEntries(members.map((m) => [m.uid, m.name])),
    };
    if (extras.host !== undefined) entry.host = extras.host;
    let batch = writeBatch(this.db);
    let writes = 0;
    let bytes = 0;
    for (const c of chunks) {
      if (writes >= BATCH_WRITES || bytes + c.data.length > BATCH_BYTES) {
        batch.set(ref, entry, { merge: true });
        await batch.commit();
        batch = writeBatch(this.db);
        writes = 0;
        bytes = 0;
      }
      batch.set(doc(ref, 'chunks', `${c.cx}_${c.cz}`), { d: Bytes.fromUint8Array(c.data) });
      writes++;
      bytes += c.data.length;
    }
    batch.set(ref, entry, { merge: true });
    await batch.commit();
    void this.dropLegacy(meta.id);
  }

  async getWorld(id: string): Promise<{ meta: WorldMeta; chunks: ChunkBlob[] } | null> {
    for (const ref of [this.worldRef(id), this.legacyRef(id)]) {
      const got = await this.readWorld(ref).catch(() => null);
      if (got) return got;
    }
    return null;
  }

  private async readWorld(ref: ReturnType<FirestoreWorlds['worldRef']>): Promise<{ meta: WorldMeta; chunks: ChunkBlob[] } | null> {
    const { getDoc, getDocs, collection } = this.fs;
    const w = await getDoc(ref);
    if (!w.exists()) return null;
    const meta = JSON.parse(w.get('meta')) as WorldMeta;
    const snap = await getDocs(collection(ref, 'chunks'));
    const chunks: ChunkBlob[] = [];
    snap.forEach((d) => {
      const [cx, cz] = d.id.split('_').map(Number);
      const bytes = d.get('d') as Bytes | undefined;
      if (bytes && Number.isInteger(cx) && Number.isInteger(cz)) chunks.push({ cx, cz, data: bytes.toUint8Array() });
    });
    return { meta, chunks };
  }

  private async deleteWithChunks(ref: ReturnType<FirestoreWorlds['worldRef']>): Promise<void> {
    const { getDocs, collection, writeBatch } = this.fs;
    const snap = await getDocs(collection(ref, 'chunks'));
    const refs = snap.docs.map((d) => d.ref);
    for (let i = 0; i < refs.length; i += 400) {
      const batch = writeBatch(this.db);
      refs.slice(i, i + 400).forEach((r) => batch.delete(r));
      await batch.commit();
    }
    const batch = writeBatch(this.db);
    batch.delete(ref);
    await batch.commit();
  }

  /** Removes an old-style copy once the world is saved in the shared place. */
  private async dropLegacy(id: string): Promise<void> {
    try {
      if ((await this.fs.getDoc(this.legacyRef(id))).exists()) await this.deleteWithChunks(this.legacyRef(id));
    } catch {
      // harmless: it stays listed under the same id and is replaced on the next save
    }
  }

  async deleteWorld(id: string): Promise<void> {
    await this.dropLegacy(id);
    const w = await this.fs.getDoc(this.worldRef(id)).catch(() => null);
    if (w?.exists()) await this.deleteWithChunks(this.worldRef(id));
  }

  async leaveWorld(id: string): Promise<void> {
    const { updateDoc, arrayRemove } = this.fs;
    await updateDoc(this.worldRef(id), { members: arrayRemove(this.uid) });
  }
}

export const CLOUD_PUSH_INTERVAL_MS = 60_000;

/**
 * A ChunkStore that writes to the local store and mirrors to the cloud. The first push of a
 * session uploads every saved chunk (so a world that was played offline catches up) unless the
 * local copy was just downloaded; later pushes send only what changed. Failed pushes keep their
 * chunks for the next attempt. Each push also renews this host's lock and adds new members.
 */
export class SyncedStore implements ChunkStore {
  private pending = new Map<string, ChunkBlob>();
  private needFull: boolean;
  private meta: WorldMeta | null = null;
  private lastPush = -Infinity;
  private pushing: Promise<void> = Promise.resolve();
  private readonly newMembers = new Map<string, string>();
  private closing = false;
  /** Hebrew description of the last failure, or null when the cloud is up to date. */
  problem: string | null = null;

  constructor(
    private readonly local: ChunkStore,
    private readonly cloud: CloudBackend,
    private readonly allLocalChunks: () => Promise<ChunkBlob[]>,
    private readonly self: CloudMember,
    opts: { upToDate?: boolean; now?: () => number } = {},
  ) {
    this.needFull = !opts.upToDate;
    if (opts.now) this.now = opts.now;
  }

  private now: () => number = () => Date.now();

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

  /** A signed-in friend joined: share the world with them (pushed right away). */
  addMember(uid: string, name: string): void {
    if (uid === this.self.uid) return;
    this.newMembers.set(uid, name);
    void this.flush();
  }

  /** Pushes everything not yet in the cloud. With `final`, also gives up the hosting lock. */
  flush(final = false): Promise<void> {
    if (final) this.closing = true;
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
    const members = [...this.newMembers].map(([uid, name]) => ({ uid, name }));
    const host = this.closing ? null : { ...this.self, until: this.now() + HOST_LOCK_MS };
    try {
      await this.cloud.putWorld(meta, sending, { members, host });
      for (const [k, c] of sent) if (this.pending.get(k) === c) this.pending.delete(k);
      for (const m of members) this.newMembers.delete(m.uid);
      if (full) this.needFull = false;
      this.problem = null;
    } catch (err) {
      console.warn('cloud save failed', err);
      this.problem = 'השמירה בענן נכשלה — העולם שמור במחשב הזה וננסה שוב.';
    }
  }
}
