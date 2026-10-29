import { describe, expect, it } from 'vitest';
import { HOST_LOCK_MS, SyncedStore, type ChunkBlob, type CloudBackend, type CloudHost, type CloudWorldInfo, type WorldExtras } from '../src/cloud/cloudWorlds';
import { verifyIdToken, type JwkSet } from '../src/cloud/verifyToken';
import { createLocalPair } from '../src/net/LocalTransport';
import { GameServer } from '../src/server/GameServer';
import type { ChunkGenerator } from '../src/server/ServerWorld';
import { newWorldMeta, type ChunkStore, type WorldMeta } from '../src/server/storage/WorldStorage';
import { B } from '../src/shared/blocks/registry';
import { GameMode, PROTOCOL_VERSION } from '../src/shared/constants';
import type { ClientMsg, ServerMsg } from '../src/shared/protocol/messages';
import { Chunk } from '../src/shared/world/Chunk';
import { computeChunkLight } from '../src/shared/world/lighting';

// --- ID token verification ------------------------------------------------------

const PROJECT = 'playcubica-test';
const NOW = 1_800_000_000;

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const b64json = (o: object) => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function signer() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const keys: JwkSet = { keys: [{ ...jwk, kid: 'k1' }] };
  const sign = async (payload: object, kid = 'k1') => {
    const head = `${b64json({ alg: 'RS256', kid, typ: 'JWT' })}.${b64json(payload)}`;
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(head)));
    return `${head}.${b64url(sig)}`;
  };
  return { keys, sign };
}

const claims = (over: object = {}) => ({
  iss: `https://securetoken.google.com/${PROJECT}`,
  aud: PROJECT,
  sub: 'uid-123',
  name: 'Noa Levi',
  email: 'noa@example.com',
  iat: NOW - 60,
  auth_time: NOW - 60,
  exp: NOW + 3000,
  ...over,
});

describe('Firebase ID token verification', () => {
  it('accepts a valid token and rejects forged or stale ones', async () => {
    const { keys, sign } = await signer();
    const get = async () => keys;
    expect(await verifyIdToken(await sign(claims()), PROJECT, get, NOW)).toEqual({ uid: 'uid-123', name: 'Noa Levi', email: 'noa@example.com' });
    expect(await verifyIdToken(await sign(claims({ aud: 'other' })), PROJECT, get, NOW)).toBeNull();
    expect(await verifyIdToken(await sign(claims({ iss: 'https://evil.example' })), PROJECT, get, NOW)).toBeNull();
    expect(await verifyIdToken(await sign(claims({ exp: NOW - 1 })), PROJECT, get, NOW)).toBeNull();
    expect(await verifyIdToken(await sign(claims({ sub: '' })), PROJECT, get, NOW)).toBeNull();
    expect(await verifyIdToken(await sign(claims(), 'unknown-kid'), PROJECT, get, NOW)).toBeNull();
    // Changing the payload breaks the signature.
    const [h, , sig] = (await sign(claims())).split('.');
    expect(await verifyIdToken(`${h}.${b64json(claims({ sub: 'someone-else' }))}.${sig}`, PROJECT, get, NOW)).toBeNull();
    // A different key with the same kid.
    const other = await signer();
    expect(await verifyIdToken(await other.sign(claims()), PROJECT, get, NOW)).toBeNull();
    expect(await verifyIdToken('not.a.token', PROJECT, get, NOW)).toBeNull();
  });
});

// --- Cloud mirror ---------------------------------------------------------------

interface MemWorld {
  meta: WorldMeta;
  chunks: Map<string, Uint8Array>;
  owner: string;
  members: Record<string, string>;
  host: CloudHost | null;
}

class MemCloud implements CloudBackend {
  worlds = new Map<string, MemWorld>();
  puts: number[] = [];
  failNext = false;
  constructor(readonly uid = 'me') {}
  async listWorlds(): Promise<CloudWorldInfo[]> {
    return [...this.worlds.values()]
      .filter((w) => this.uid in w.members)
      .map((w) => ({ meta: w.meta, updatedAt: w.meta.lastPlayed, owner: w.owner, members: { ...w.members }, host: w.host }));
  }
  async putWorld(meta: WorldMeta, chunks: ChunkBlob[], extras: WorldExtras = {}): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('offline');
    }
    const w: MemWorld = this.worlds.get(meta.id) ?? { meta, chunks: new Map(), owner: meta.owner ?? this.uid, members: {}, host: null };
    w.meta = meta;
    w.members[this.uid] = 'me';
    for (const m of extras.members ?? []) w.members[m.uid] = m.name;
    if (extras.host !== undefined) w.host = extras.host;
    for (const c of chunks) w.chunks.set(`${c.cx},${c.cz}`, c.data);
    this.worlds.set(meta.id, w);
    this.puts.push(chunks.length);
  }
  async leaveWorld(id: string): Promise<void> {
    delete this.worlds.get(id)?.members[this.uid];
  }
  async getWorld(id: string) {
    const w = this.worlds.get(id);
    return w ? { meta: w.meta, chunks: [...w.chunks].map(([k, data]) => ({ cx: +k.split(',')[0], cz: +k.split(',')[1], data })) } : null;
  }
  async deleteWorld(id: string): Promise<void> {
    this.worlds.delete(id);
  }
}

class MemStore implements ChunkStore {
  chunks = new Map<string, Uint8Array>();
  meta: WorldMeta | null = null;
  async loadChunk(cx: number, cz: number) {
    return this.chunks.get(`${cx},${cz}`);
  }
  async saveChunks(chunks: ChunkBlob[]) {
    for (const c of chunks) this.chunks.set(`${c.cx},${c.cz}`, c.data);
  }
  async saveMeta(meta: WorldMeta) {
    this.meta = meta;
  }
  all(): ChunkBlob[] {
    return [...this.chunks].map(([k, data]) => ({ cx: +k.split(',')[0], cz: +k.split(',')[1], data }));
  }
}

describe('cloud mirror (SyncedStore)', () => {
  it('uploads the whole world once, then only changes, and retries after a failure', async () => {
    const local = new MemStore();
    local.chunks.set('5,5', new Uint8Array([5])); // played offline before
    const cloud = new MemCloud();
    let now = 0;
    const store = new SyncedStore(local, cloud, async () => local.all(), { uid: 'me', name: 'Me' }, { now: () => now });
    const meta = newWorldMeta('w', 1, GameMode.SURVIVAL);

    await store.saveChunks([{ cx: 0, cz: 0, data: new Uint8Array([1]) }]);
    await store.saveMeta(meta); // first save of the session pushes by itself
    await new Promise((r) => setTimeout(r, 0));
    expect(cloud.puts).toEqual([2]); // full upload: both chunks
    expect(local.meta).toBe(meta); // local copy still written

    // Within the interval, saves stay local until an explicit flush.
    now = 10_000;
    await store.saveChunks([{ cx: 1, cz: 0, data: new Uint8Array([2]) }]);
    await store.saveMeta(meta);
    expect(cloud.puts.length).toBe(1);
    cloud.failNext = true;
    await store.flush();
    expect(store.problem).not.toBeNull();
    await store.flush();
    expect(store.problem).toBeNull();
    expect(cloud.puts.at(-1)).toBe(1); // only the changed chunk
    expect([...cloud.worlds.get(meta.id)!.chunks.keys()].sort()).toEqual(['0,0', '1,0', '5,5']);

    // After the interval a save pushes by itself.
    now = 200_000;
    await store.saveChunks([{ cx: 2, cz: 0, data: new Uint8Array([3]) }]);
    await store.saveMeta(meta);
    await store.flush();
    expect(cloud.worlds.get(meta.id)!.chunks.has('2,0')).toBe(true);
  });

  it('shares the world with friends who join and holds a hosting lock while open', async () => {
    const local = new MemStore();
    const cloud = new MemCloud('me');
    let now = 1000;
    const store = new SyncedStore(local, cloud, async () => local.all(), { uid: 'me', name: 'Me' }, { upToDate: true, now: () => now });
    const meta = newWorldMeta('shared', 1, GameMode.SURVIVAL);
    meta.owner = 'me';
    await store.saveMeta(meta);
    await store.flush();
    const w = cloud.worlds.get(meta.id)!;
    expect(cloud.puts[0]).toBe(0); // just downloaded: nothing to re-upload
    expect(w.host).toMatchObject({ uid: 'me', until: 1000 + HOST_LOCK_MS });
    store.addMember('friend-1', 'Noa');
    await store.flush();
    expect(w.members).toMatchObject({ me: 'me', 'friend-1': 'Noa' });
    // The friend now sees it in their list and can host it later; the owner stays the creator.
    const friendView = new MemCloud('friend-1');
    friendView.worlds = cloud.worlds;
    const listed = await friendView.listWorlds();
    expect(listed.map((x) => x.meta.id)).toEqual([meta.id]);
    expect(listed[0].owner).toBe('me');
    // Leaving the game gives up the lock.
    now = 5000;
    await store.flush(true);
    expect(w.host).toBeNull();
    // A friend removing it from their list doesn't delete it.
    await friendView.leaveWorld(meta.id);
    expect(await friendView.listWorlds()).toEqual([]);
    expect(cloud.worlds.has(meta.id)).toBe(true);
  });
});

// --- Verified accounts on the host ----------------------------------------------

function flatChunk(cx: number, cz: number): Chunk {
  const c = new Chunk(cx, cz);
  for (let i = 0; i < 10 * 256; i++) c.blocks[i] = B.STONE;
  c.recomputeHeights();
  computeChunkLight(c);
  return c;
}
const flatGen: ChunkGenerator = { concurrency: 64, generate: async (cx, cz) => flatChunk(cx, cz) };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('accounts on the host', () => {
  it('keys signed-in players by account, rejects a second login, and falls back to guest', async () => {
    const meta = newWorldMeta('acc', 1, GameMode.SURVIVAL);
    const shared: string[] = [];
    let open = false;
    const server = new GameServer({
      viewDistance: 2,
      meta,
      verifyAccount: async (t) => (t.startsWith('good:') ? { uid: t.slice(5) } : null),
      onAccountJoin: (uid, name) => shared.push(`${uid}:${name}`),
      succession: () => (open ? { worldId: meta.id, code: 'ABCD-2345' } : null),
    }, flatGen);
    // Progress made earlier as a guest named Noa.
    meta.players.Noa = { pos: [3, 10, 3], yaw: 0, pitch: 0, flying: false, gameMode: GameMode.CREATIVE, inventory: { slots: [], held: 0 } as never };
    const join = async (name: string, token?: string) => {
      const [s, c] = createLocalPair<ServerMsg, ClientMsg>();
      const got: ServerMsg[] = [];
      let closed = '';
      c.onMessage = (m) => got.push(m);
      c.onClose = (r) => (closed = r);
      server.addConnection(s);
      c.send({ t: 'hello', v: PROTOCOL_VERSION, name, ...(token ? { token } : {}) });
      for (let i = 0; i < 5; i++) await flush();
      return { got, close: () => c.close(), get closed() { return closed; } };
    };

    const noa = await join('Noa', 'good:uid-noa');
    const welcome = noa.got.find((m) => m.t === 'welcome');
    expect(welcome && welcome.t === 'welcome' && welcome.gameMode).toBe(GameMode.CREATIVE); // took over the guest save
    expect(meta.players['g:uid-noa']).toBeDefined();
    expect(meta.players.Noa).toBeUndefined();
    expect(shared).toEqual(['uid-noa:Noa']); // the world gets shared with her
    // A browser's automatic account (no email) shares worlds too, but gets no ✓ (that's for Google).
    const shown = [...noa.got].reverse().find((m) => m.t === 'playerList');
    expect(shown && shown.t === 'playerList' && shown.players.find((p) => p.name === 'Noa')?.verified).toBe(false);

    const again = await join('Noa2', 'good:uid-noa');
    expect(again.got.some((m) => m.t === 'kick' && m.reason.includes('כבר מחובר'))).toBe(true);

    const forged = await join('Dan', 'bad-token');
    expect(forged.got.some((m) => m.t === 'welcome')).toBe(true);
    expect(forged.got.some((m) => m.t === 'chat' && m.text.includes('אורח'))).toBe(true);

    // Once the world is open to friends, everyone learns who carries it on: signed-in players only.
    open = true;
    server.announcePlayers();
    await flush();
    const last = [...forged.got].reverse().find((m) => m.t === 'succession');
    expect(last && last.t === 'succession' && last.order.map((o) => o.name)).toEqual(['Noa']);
    expect(last && last.t === 'succession' && last.code).toBe('ABCD-2345');

    await server.save();
    noa.close();
    await flush();
    expect(meta.players['g:uid-noa']).toBeDefined();
    const list = (server as unknown as { players: Map<number, { account: string | null; name: string }> }).players;
    expect([...list.values()].find((p) => p.name === 'Dan')?.account).toBeNull();
  });
});
