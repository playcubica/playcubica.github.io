import { GameClient, type ClientStatus } from '../client/GameClient';
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

  private constructor(server: GameServer | null, generator: WorkerChunkGenerator | null, client: GameClient, private readonly onLeave?: () => void) {
    this.server = server;
    this.generator = generator;
    this.client = client;
  }

  static host(container: HTMLElement, meta: WorldMeta, storage: WorldStorage | null, opts: SessionOptions, onStatus: (s: ClientStatus) => void): GameSession {
    const generator = new WorkerChunkGenerator(meta.seed);
    const server = new GameServer({ viewDistance: opts.viewDistance, meta, store: storage?.forWorld(meta.id) }, generator);
    const [serverEnd, clientEnd] = createLocalPair<ServerMsg, ClientMsg>();
    server.addConnection(serverEnd, { host: true });
    const client = new GameClient(container, clientEnd, { name: opts.playerName });
    client.onStatus = onStatus;
    server.start();
    client.start();
    return new GameSession(server, generator, client);
  }

  static remote(container: HTMLElement, transport: Transport<ClientMsg, ServerMsg>, opts: SessionOptions, onStatus: (s: ClientStatus) => void, onLeave: () => void): GameSession {
    const client = new GameClient(container, transport, { name: opts.playerName, remote: true });
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

  save(): Promise<void> {
    return this.server?.save() ?? Promise.resolve();
  }

  /** Saves (host) and tears everything down. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.network?.close();
    this.client.dispose();
    await this.server?.stop();
    this.generator?.terminate();
    this.onLeave?.();
  }
}
