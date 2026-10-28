import { DAY_LENGTH_TICKS, MAX_PLAYERS, PROTOCOL_VERSION, TICK_MS } from '../shared/constants';
import type { ClientMsg, ServerMsg, Vec3 } from '../shared/protocol/messages';
import { chunkKey } from '../shared/world/Chunk';
import type { Transport } from '../net/Transport';
import { WorldGenerator } from './worldgen/WorldGenerator';
import { ServerWorld, type ChunkGenerator } from './ServerWorld';

export interface ServerOptions {
  seed: number;
  viewDistance: number;
}

/** Chunks sent to one player per tick (keeps the channel and the client responsive). */
const MAX_CHUNKS_PER_TICK = 6;

class PlayerSession {
  name = '';
  joined = false;
  pos: Vec3 = [0, 0, 0];
  yaw = 0;
  pitch = 0;
  /** Chunks this client currently holds. */
  readonly sent = new Map<string, [number, number]>();

  constructor(readonly id: number, readonly transport: Transport<ServerMsg, ClientMsg>) {}

  send(msg: ServerMsg): void {
    this.transport.send(msg);
  }
}

/**
 * The authoritative game simulation. Runs in the host's page; never touches the
 * DOM or the renderer. Clients (including the host's own) talk to it only through
 * Transport + the protocol in shared/protocol.
 */
export class GameServer {
  readonly world: ServerWorld;
  readonly spawn: Vec3;
  time = 1000;
  private readonly players = new Map<number, PlayerSession>();
  private nextPlayerId = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  /** Chunk offsets within the streaming radius, nearest first. */
  private readonly offsets: Array<[number, number]>;
  private readonly radius: number;

  constructor(readonly options: ServerOptions, generator: ChunkGenerator) {
    this.world = new ServerWorld(generator);
    this.spawn = new WorldGenerator(options.seed).findSpawn();
    // One ring beyond the view distance so clients can mesh the visible edge.
    this.radius = options.viewDistance + 1;
    const offsets: Array<[number, number]> = [];
    for (let dz = -this.radius; dz <= this.radius; dz++) {
      for (let dx = -this.radius; dx <= this.radius; dx++) {
        if (dx * dx + dz * dz <= this.radius * this.radius + this.radius) offsets.push([dx, dz]);
      }
    }
    offsets.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));
    this.offsets = offsets;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const p of this.players.values()) p.transport.close('server stopped');
    this.players.clear();
  }

  addConnection(transport: Transport<ServerMsg, ClientMsg>): void {
    const session = new PlayerSession(this.nextPlayerId++, transport);
    transport.onMessage = (msg) => this.handle(session, msg);
    transport.onClose = () => this.players.delete(session.id);
  }

  private handle(p: PlayerSession, msg: ClientMsg): void {
    if (!p.joined && msg.t !== 'hello') return;
    switch (msg.t) {
      case 'hello': {
        if (p.joined) return;
        if (msg.v !== PROTOCOL_VERSION) {
          p.send({ t: 'kick', reason: `גרסת משחק לא תואמת (שרת ${PROTOCOL_VERSION}, לקוח ${msg.v})` });
          p.transport.close('version mismatch');
          return;
        }
        if (this.players.size >= MAX_PLAYERS) {
          p.send({ t: 'kick', reason: 'העולם מלא' });
          p.transport.close('full');
          return;
        }
        p.name = String(msg.name).slice(0, 16) || `Player${p.id}`;
        p.joined = true;
        p.pos = [...this.spawn];
        this.players.set(p.id, p);
        p.send({
          t: 'welcome',
          playerId: p.id,
          seed: this.options.seed,
          time: this.time,
          spawn: this.spawn,
          gameMode: 1,
          viewDistance: this.options.viewDistance,
          players: [...this.players.values()].map((q) => ({ id: q.id, name: q.name })),
        });
        break;
      }
      case 'move':
        // Stage 4: validate speed against the previous position before accepting.
        if ([msg.x, msg.y, msg.z, msg.yaw, msg.pitch].every(Number.isFinite)) {
          p.pos = [msg.x, msg.y, msg.z];
          p.yaw = msg.yaw;
          p.pitch = msg.pitch;
        }
        break;
      default:
        // Remaining messages arrive in later stages.
        break;
    }
  }

  private tick(): void {
    this.tickCount++;
    this.time++;
    if (this.tickCount % 20 === 0) {
      for (const p of this.players.values()) p.send({ t: 'time', time: this.time });
    }
    for (const p of this.players.values()) this.stream(p);
    if (this.tickCount % 100 === 0) this.unloadFarChunks();
  }

  /** Sends nearby chunks (nearest first) and tells the client to drop far ones. */
  private stream(p: PlayerSession): void {
    const pcx = Math.floor(p.pos[0] / 16);
    const pcz = Math.floor(p.pos[2] / 16);
    let sent = 0;
    let saturated = false;
    for (const [dx, dz] of this.offsets) {
      const cx = pcx + dx;
      const cz = pcz + dz;
      const key = chunkKey(cx, cz);
      if (p.sent.has(key)) continue;
      const c = this.world.getChunk(cx, cz);
      if (c) {
        if (sent < MAX_CHUNKS_PER_TICK) {
          p.send({ t: 'chunk', cx, cz, data: this.world.encodedBytes(c) });
          p.sent.set(key, [cx, cz]);
          sent++;
        }
      } else if (!saturated && !this.world.request(cx, cz)) {
        saturated = true;
      }
      if (saturated && sent >= MAX_CHUNKS_PER_TICK) break;
    }

    const limit = (this.radius + 1) * (this.radius + 1);
    for (const [key, [cx, cz]] of p.sent) {
      const dx = cx - pcx;
      const dz = cz - pcz;
      if (dx * dx + dz * dz > limit) {
        p.sent.delete(key);
        p.send({ t: 'unloadChunk', cx, cz });
      }
    }
  }

  private unloadFarChunks(): void {
    const keepR = (this.radius + 2) * (this.radius + 2);
    const centers = [...this.players.values()].map((p) => [Math.floor(p.pos[0] / 16), Math.floor(p.pos[2] / 16)]);
    this.world.unloadWhere((cx, cz) => centers.some(([px, pz]) => (cx - px) ** 2 + (cz - pz) ** 2 <= keepR));
  }

  get dayTime(): number {
    return this.time % DAY_LENGTH_TICKS;
  }

  get playerCount(): number {
    return this.players.size;
  }
}
