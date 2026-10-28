import { firebaseConfig } from '../cloud/firebaseConfig';
import { SyncedStore, type CloudBackend } from '../cloud/cloudWorlds';
import { verifyIdToken } from '../cloud/verifyToken';
import { GameClient, type ClientStatus } from '../client/GameClient';
import type { Settings } from '../client/settings';
import { createLocalPair } from '../net/LocalTransport';
import { HostNetwork } from '../net/peerNetwork';
import type { Transport } from '../net/Transport';
import { GameServer } from '../server/GameServer';
import type { WorldMeta, WorldStorage } from '../server/storage/WorldStorage';
import { WorkerChunkGenerator } from '../server/WorkerChunkGenerator';
import type { ClientMsg, ServerMsg } from '../shared/protocol/messages';

export interface SessionOptions {
  viewDistance: number;
  playerName: string;
  settings: Settings;
  /** Signed-in Google account (Firebase uid), if any. */
  account?: string | null;
  /** Remote only: ID token that proves `account` to the host. */
  token?: string | null;
  /** Host only: mirror the world to this cloud (signed-in players). */
  cloud?: CloudBackend | null;
}

/**
 * A world being played in this page. Either:
 *  - host: this page runs the GameServer, its own GameClient connects in memory, and
 *    friends can connect over WebRTC after openToFriends(); or
 *  - remote: only a GameClient, connected to a friend's host.
 */
export class GameSession {
  readonly server: GameServer | null;
  readonly client: GameClient;
  private readonly generator: WorkerChunkGenerator | null;
  private network: HostNetwork | null = null;
  private stopped = false;
  private synced: SyncedStore | null = null;

  private constructor(server: GameServer | null, generator: WorkerChunkGenerator | null, client: GameClient, private readonly onLeave?: () => void) {
    this.server = server;
    this.generator = generator;
    this.client = client;
  }

  static host(container: HTMLElement, meta: WorldMeta, storage: WorldStorage | null, opts: SessionOptions, onStatus: (s: ClientStatus) => void): GameSession {
    const generator = new WorkerChunkGenerator(meta.seed);
    const local = storage?.forWorld(meta.id);
    const synced = local && storage && opts.cloud ? new SyncedStore(local, opts.cloud, () => storage.allChunks(meta.id)) : null;
    const projectId = firebaseConfig?.projectId;
    const server = new GameServer({
      viewDistance: opts.viewDistance,
      meta,
      store: synced ?? local,
      verifyAccount: projectId ? (token) => verifyIdToken(token, projectId) : undefined,
    }, generator);
    const [serverEnd, clientEnd] = createLocalPair<ServerMsg, ClientMsg>();
    server.addConnection(serverEnd, { host: true, account: opts.account });
    const client = new GameClient(container, clientEnd, { name: opts.playerName, settings: opts.settings });
    client.onStatus = onStatus;
    server.start();
    client.start();
    const session = new GameSession(server, generator, client);
    session.synced = synced;
    return session;
  }

  static remote(container: HTMLElement, transport: Transport<ClientMsg, ServerMsg>, opts: SessionOptions, onStatus: (s: ClientStatus) => void, onLeave: () => void): GameSession {
    const client = new GameClient(container, transport, { name: opts.playerName, settings: opts.settings, remote: true, token: opts.token });
    client.onStatus = onStatus;
    client.start();
    return new GameSession(null, null, client, onLeave);
  }

  get isHost(): boolean {
    return this.server !== null;
  }

  /** The invite code once the world is open to friends. */
  get inviteCode(): string | null {
    return this.network?.code || null;
  }

  get networkProblem(): string | null {
    return this.network?.problem ?? null;
  }

  /** Starts accepting friends; resolves with the invite code. */
  async openToFriends(): Promise<string> {
    if (!this.server) throw new Error('only the host can open the world');
    if (!this.network) {
      const server = this.server;
      this.network = new HostNetwork((t) => server.addConnection(t));
    }
    try {
      return await this.network.open();
    } catch (err) {
      this.network = null;
      throw err;
    }
  }

  /** Hebrew note when the last cloud save failed (signed-in host only). */
  get cloudProblem(): string | null {
    return this.synced?.problem ?? null;
  }

  /** Saves locally; with `cloud`, also pushes to the cloud right away. */
  async save(cloud = false): Promise<void> {
    await this.server?.save();
    if (cloud) await this.synced?.flush();
  }

  /** Saves (host) and tears everything down. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.network?.close();
    this.client.dispose();
    await this.server?.stop();
    await this.synced?.flush();
    this.generator?.terminate();
    this.onLeave?.();
  }
}
