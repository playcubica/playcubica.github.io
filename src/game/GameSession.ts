import { GameClient, type ClientStatus } from '../client/GameClient';
import { createLocalPair } from '../net/LocalTransport';
import { GameServer } from '../server/GameServer';
import type { WorldMeta, WorldStorage } from '../server/storage/WorldStorage';
import { WorkerChunkGenerator } from '../server/WorkerChunkGenerator';
import type { ClientMsg, ServerMsg } from '../shared/protocol/messages';

export interface SessionOptions {
  viewDistance: number;
  playerName: string;
}

/**
 * A world being played on this machine: the host's GameServer plus this page's own
 * GameClient, connected in memory. (Stage 4 lets friends connect to the same server.)
 */
export class GameSession {
  readonly server: GameServer;
  readonly client: GameClient;
  private readonly generator: WorkerChunkGenerator;
  private stopped = false;

  constructor(container: HTMLElement, meta: WorldMeta, storage: WorldStorage | null, opts: SessionOptions, onStatus: (s: ClientStatus) => void) {
    this.generator = new WorkerChunkGenerator(meta.seed);
    this.server = new GameServer(
      { viewDistance: opts.viewDistance, meta, store: storage?.forWorld(meta.id) },
      this.generator,
    );
    const [serverEnd, clientEnd] = createLocalPair<ServerMsg, ClientMsg>();
    this.server.addConnection(serverEnd, { host: true });
    this.client = new GameClient(container, clientEnd, { name: opts.playerName });
    this.client.onStatus = onStatus;
    this.server.start();
    this.client.start();
  }

  save(): Promise<void> {
    return this.server.save();
  }

  /** Saves the world and tears everything down. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.client.dispose();
    await this.server.stop();
    this.generator.terminate();
  }
}
