import { firebaseConfig } from '../cloud/firebaseConfig';
import { SyncedStore, type CloudBackend } from '../cloud/cloudWorlds';
import { verifyIdToken } from '../cloud/verifyToken';
import { GameClient, type ClientStatus } from '../client/GameClient';
import type { Settings } from '../client/settings';
import { createLocalPair } from '../net/LocalTransport';
import { HostNetwork, newInviteCode } from '../net/peerNetwork';
import type { Transport } from '../net/Transport';
import { GameServer } from '../server/GameServer';
import type { WorldMeta, WorldStorage } from '../server/storage/WorldStorage';
import { WorkerChunkGenerator } from '../server/WorkerChunkGenerator';
import type { ClientMsg, ServerMsg } from '../shared/protocol/messages';

export interface SessionOptions {
  viewDistance: number;
  playerName: string;
  settings: Settings;
  /** This player's account (Firebase uid: automatic or Google), if any. */
  account?: string | null;
  /** The account is a Google sign-in. */
  google?: boolean;
  /** Remote only: ID token that proves `account` to the host. */
  token?: string | null;
  /** Host only: mirror the world to this cloud (signed-in players). */
  cloud?: CloudBackend | null;
  /** Host only: the local copy was just downloaded from the cloud (no need to upload it all again). */
  cloudUpToDate?: boolean;
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
  private opening: Promise<string> | null = null;
  private stopping: Promise<void> | null = null;

  private constructor(server: GameServer | null, generator: WorkerChunkGenerator | null, client: GameClient, private readonly onLeave?: () => void) {
    this.server = server;
    this.generator = generator;
    this.client = client;
  }

  static host(container: HTMLElement, meta: WorldMeta, storage: WorldStorage | null, opts: SessionOptions, onStatus: (s: ClientStatus) => void): GameSession {
    const generator = new WorkerChunkGenerator(meta.seed);
    const local = storage?.forWorld(meta.id);
    const cloud = opts.cloud;
    if (cloud) meta.owner ??= cloud.uid;
    const synced = local && storage && cloud
      ? new SyncedStore(local, cloud, () => storage.allChunks(meta.id), { uid: cloud.uid, name: opts.playerName }, { upToDate: opts.cloudUpToDate })
      : null;
    const projectId = firebaseConfig?.projectId;
    const server = new GameServer({
      viewDistance: opts.viewDistance,
      meta,
      store: synced ?? local,
      verifyAccount: projectId ? (token) => verifyIdToken(token, projectId) : undefined,
      onAccountJoin: synced ? (uid, name) => synced.addMember(uid, name) : undefined,
    }, generator);
    const [serverEnd, clientEnd] = createLocalPair<ServerMsg, ClientMsg>();
    server.addConnection(serverEnd, { host: true, account: opts.account, google: opts.google });
    const client = new GameClient(container, clientEnd, { name: opts.playerName, settings: opts.settings });
    client.onStatus = onStatus;
    server.start();
    client.start();
    const session = new GameSession(server, generator, client);
    session.synced = synced;
    // Signed-in friends can carry a shared world on when this host leaves (see App.carryOn).
    server.options.succession = () => (synced && session.network?.code && !session.stopped ? { worldId: meta.id, code: session.network.code } : null);
    // Claim the world right away, so others see it's being played.
    if (synced) void server.save();
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

  /**
   * Starts accepting friends; resolves with the invite code. Each world keeps one code (saved with it),
   * so the same code and link work every time it is opened. `newCode` replaces it.
   */
  openToFriends(newCode = false, patient = false): Promise<string> {
    // One opening at a time (the automatic one and a click must not race for the same code).
    if (this.opening && !newCode) return this.opening;
    const run = this.openNow(newCode, patient);
    this.opening = run;
    const done = () => {
      if (this.opening === run) this.opening = null;
    };
    run.then(done, done);
    return run;
  }

  /** True while the world is being opened to friends. */
  get openingToFriends(): boolean {
    return this.opening !== null;
  }

  /** `patient`: taking over from a host that just left, whose page may hold the code for a while. */
  private async openNow(newCode: boolean, patient: boolean): Promise<string> {
    const server = this.server;
    if (!server) throw new Error('only the host can open the world');
    if (newCode) {
      this.network?.close();
      this.network = null;
      server.meta.inviteCode = newInviteCode();
    }
    if (!this.network) this.network = new HostNetwork((t) => server.addConnection(t));
    const network = this.network;
    server.meta.inviteCode ??= newInviteCode();
    try {
      const code = await network.open(server.meta.inviteCode, patient);
      void server.save();
      server.announcePlayers();
      return code;
    } catch (err) {
      if (this.network === network) this.network = null;
      throw err;
    }
  }

  /** The world is mirrored to the cloud, so signed-in friends can carry on with it. */
  get shared(): boolean {
    return this.synced !== null;
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
  stop(): Promise<void> {
    this.stopping ??= this.shutDown();
    return this.stopping;
  }

  private async shutDown(): Promise<void> {
    // A shared world reaches the cloud before friends are let go, so whoever carries it on has it all.
    if (this.server && this.synced) {
      await this.server.save();
      await this.synced.flush(true);
    }
    this.stopped = true;
    this.client.dispose();
    await this.server?.stop();
    this.network?.close();
    await this.synced?.flush(true);
    this.generator?.terminate();
    this.onLeave?.();
  }
}
