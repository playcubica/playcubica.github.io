import { B, OPAQUE, RENDER, REPLACEABLE, SOLID } from '../shared/blocks/registry';
import { DAY_LENGTH_TICKS, MAX_PLAYERS, PROTOCOL_VERSION, TICK_MS } from '../shared/constants';
import { HOTBAR_SIZE, InvAction, Inventory } from '../shared/items/Inventory';
import { breakTime, REACH } from '../shared/items/mining';
import { blockDrop, itemDef } from '../shared/items/registry';
import { boxOverlapsBlock } from '../shared/physics/collision';
import { EYE_HEIGHT, PLAYER_HEIGHT, PLAYER_WIDTH } from '../shared/physics/PlayerBody';
import type { ClientMsg, ServerMsg, Vec3 } from '../shared/protocol/messages';
import { MoveFlag } from '../shared/protocol/messages';
import { chunkKey } from '../shared/world/Chunk';
import type { Transport } from '../net/Transport';
import { WorldGenerator } from './worldgen/WorldGenerator';
import { ServerWorld, type ChunkGenerator } from './ServerWorld';
import { GameMode, type ChunkStore, type PlayerSave, type WorldMeta } from './storage/WorldStorage';

export interface ServerOptions {
  viewDistance: number;
  /** World metadata (seed, saved players, time…). Kept up to date and written on save. */
  meta: WorldMeta;
  /** Persistence; omit for a throw-away world. */
  store?: ChunkStore;
}

/** Chunks sent to one player per tick (keeps the channel and the client responsive). */
const MAX_CHUNKS_PER_TICK = 6;
const AUTOSAVE_TICKS = 30 * 20;
/** Slack for network latency when checking reach and dig time. */
const REACH_SLACK = 1.5;
const DIG_TIME_TOLERANCE = 0.7;

const CREATIVE_KIT = [B.GRASS, B.DIRT, B.STONE, B.ASHWOOD_PLANKS, B.ASHWOOD_LOG, B.GLASS, B.CUT_STONE, B.LUMEN_CRYSTAL, B.WATER];

/** Plants and cacti pop off when the block below them disappears. */
function needsSupport(id: number): boolean {
  return RENDER[id] === 2 || id === B.CACTUS;
}

class PlayerSession {
  name = '';
  joined = false;
  pos: Vec3 = [0, 0, 0];
  yaw = 0;
  pitch = 0;
  flying = false;
  gameMode: number = GameMode.SURVIVAL;
  readonly inventory = new Inventory();
  dig: { x: number; y: number; z: number; start: number } | null = null;
  /** Chunks this client currently holds. */
  readonly sent = new Map<string, [number, number]>();

  constructor(readonly id: number, readonly transport: Transport<ServerMsg, ClientMsg>, readonly isHost: boolean) {}

  send(msg: ServerMsg): void {
    this.transport.send(msg);
  }

  get creative(): boolean {
    return this.gameMode === GameMode.CREATIVE;
  }

  save(): PlayerSave {
    return {
      pos: [...this.pos],
      yaw: this.yaw,
      pitch: this.pitch,
      flying: this.flying,
      gameMode: this.gameMode,
      inventory: this.inventory.snapshot(),
    };
  }
}

/**
 * The authoritative game simulation. Runs in the host's page; never touches the
 * DOM or the renderer. Clients (including the host's own) talk to it only through
 * Transport + the protocol in shared/protocol, and every action is validated here.
 */
export class GameServer {
  readonly world: ServerWorld;
  readonly spawn: Vec3;
  readonly meta: WorldMeta;
  time: number;
  private readonly players = new Map<number, PlayerSession>();
  private nextPlayerId = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  private saving: Promise<void> = Promise.resolve();
  /** Chunk offsets within the streaming radius, nearest first. */
  private readonly offsets: Array<[number, number]>;
  private readonly radius: number;

  constructor(readonly options: ServerOptions, generator: ChunkGenerator) {
    this.meta = options.meta;
    this.time = this.meta.time;
    this.world = new ServerWorld(generator, options.store);
    this.spawn = new WorldGenerator(this.meta.seed).findSpawn();
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

  get seed(): number {
    return this.meta.seed;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /** Stops the simulation, saves, and disconnects everyone. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.save();
    for (const p of this.players.values()) p.transport.close('server stopped');
    this.players.clear();
  }

  addConnection(transport: Transport<ServerMsg, ClientMsg>, opts: { host?: boolean } = {}): void {
    const session = new PlayerSession(this.nextPlayerId++, transport, !!opts.host);
    transport.onMessage = (msg) => {
      try {
        this.handle(session, msg);
      } catch (err) {
        console.error('bad message from player', session.id, msg, err);
      }
    };
    transport.onClose = () => {
      if (session.joined) this.meta.players[session.name] = session.save();
      this.players.delete(session.id);
    };
  }

  // --- Message handling ------------------------------------------------------

  private handle(p: PlayerSession, msg: ClientMsg): void {
    if (!p.joined && msg.t !== 'hello') return;
    switch (msg.t) {
      case 'hello':
        this.join(p, msg.v, msg.name);
        break;
      case 'move':
        // Stage 4: validate speed against the previous position before accepting.
        if ([msg.x, msg.y, msg.z, msg.yaw, msg.pitch].every(Number.isFinite)) {
          p.pos = [msg.x, msg.y, msg.z];
          p.yaw = msg.yaw;
          p.pitch = msg.pitch;
          p.flying = p.creative && (msg.flags & MoveFlag.FLYING) !== 0;
        }
        break;
      case 'dig':
        this.dig(p, msg.phase, msg.x | 0, msg.y | 0, msg.z | 0);
        break;
      case 'place':
        this.place(p, msg.x | 0, msg.y | 0, msg.z | 0, msg.slot | 0);
        break;
      case 'held':
        if (Number.isInteger(msg.slot) && msg.slot >= 0 && msg.slot < HOTBAR_SIZE) p.inventory.selected = msg.slot;
        break;
      case 'inv':
        p.inventory.apply(msg.action, msg.slot, msg.button, msg.item, p.creative);
        this.sendInventory(p);
        break;
      case 'setGameMode':
        if (p.isHost && (msg.mode === GameMode.SURVIVAL || msg.mode === GameMode.CREATIVE)) {
          p.gameMode = msg.mode;
          if (!p.creative) p.flying = false;
          p.send({ t: 'gameMode', mode: p.gameMode });
        }
        break;
      default:
        // Remaining messages arrive in later stages.
        break;
    }
  }

  private join(p: PlayerSession, version: number, name: string): void {
    if (p.joined) return;
    if (version !== PROTOCOL_VERSION) {
      p.send({ t: 'kick', reason: `גרסת משחק לא תואמת (שרת ${PROTOCOL_VERSION}, לקוח ${version})` });
      p.transport.close('version mismatch');
      return;
    }
    if (this.players.size >= MAX_PLAYERS) {
      p.send({ t: 'kick', reason: 'העולם מלא' });
      p.transport.close('full');
      return;
    }
    p.name = String(name).slice(0, 16) || `Player${p.id}`;
    const saved = this.meta.players[p.name];
    if (saved) {
      p.pos = [...saved.pos];
      p.yaw = saved.yaw;
      p.pitch = saved.pitch;
      p.flying = saved.flying;
      p.gameMode = saved.gameMode;
      p.inventory.load(saved.inventory);
    } else {
      p.pos = [...this.spawn];
      p.yaw = Math.PI * 0.75;
      p.gameMode = this.meta.gameMode;
      if (p.creative) CREATIVE_KIT.forEach((id, i) => p.inventory.apply(InvAction.CREATIVE_SLOT, i, 0, id, true));
    }
    p.joined = true;
    this.players.set(p.id, p);
    p.send({
      t: 'welcome',
      playerId: p.id,
      seed: this.seed,
      time: this.time,
      spawn: p.pos,
      yaw: p.yaw,
      pitch: p.pitch,
      flying: p.flying,
      gameMode: p.gameMode,
      isHost: p.isHost,
      viewDistance: this.options.viewDistance,
      players: [...this.players.values()].map((q) => ({ id: q.id, name: q.name })),
    });
    this.sendInventory(p);
  }

  private sendInventory(p: PlayerSession): void {
    p.send({ t: 'inventory', state: p.inventory.snapshot() });
  }

  /** Re-sends the true state of a block to a client whose prediction was rejected. */
  private revert(p: PlayerSession, x: number, y: number, z: number): void {
    const id = this.world.getBlock(x, y, z);
    if (id >= 0) p.send({ t: 'blockChange', x, y, z, id });
  }

  private inReach(p: PlayerSession, x: number, y: number, z: number): boolean {
    const dx = x + 0.5 - p.pos[0];
    const dy = y + 0.5 - (p.pos[1] + EYE_HEIGHT);
    const dz = z + 0.5 - p.pos[2];
    return Math.hypot(dx, dy, dz) <= REACH + REACH_SLACK;
  }

  private dig(p: PlayerSession, phase: number, x: number, y: number, z: number): void {
    if (phase === 0) {
      p.dig = { x, y, z, start: performance.now() };
      return;
    }
    if (phase === 1) {
      p.dig = null;
      return;
    }
    const id = this.world.getBlock(x, y, z);
    const target = id > 0 && RENDER[id] !== 0 && RENDER[id] !== 3;
    let ok = target && this.inReach(p, x, y, z);
    if (ok && !p.creative) {
      const need = breakTime(id, p.inventory.held ? itemDef(p.inventory.held.id) : undefined, false);
      const d = p.dig;
      const elapsed = d && d.x === x && d.y === y && d.z === z ? (performance.now() - d.start) / 1000 : 0;
      ok = Number.isFinite(need) && elapsed >= need * DIG_TIME_TOLERANCE - 0.1;
    }
    p.dig = null;
    if (!ok) {
      this.revert(p, x, y, z);
      return;
    }
    this.breakBlock(p, x, y, z, id);
    const above = this.world.getBlock(x, y + 1, z);
    if (above > 0 && needsSupport(above)) this.breakBlock(p, x, y + 1, z, above);
  }

  private breakBlock(p: PlayerSession, x: number, y: number, z: number, id: number): void {
    this.setBlockAndBroadcast(x, y, z, B.AIR);
    if (!p.creative) {
      const drop = blockDrop(id);
      if (drop) {
        p.inventory.add(drop, 1); // stage 3: items that don't fit drop on the ground
        this.sendInventory(p);
      }
    }
  }

  private place(p: PlayerSession, x: number, y: number, z: number, slot: number): void {
    if (slot >= 0 && slot < HOTBAR_SIZE) p.inventory.selected = slot;
    const stack = p.inventory.held;
    const block = stack ? itemDef(stack.id)?.block : undefined;
    const current = this.world.getBlock(x, y, z);
    let ok = block !== undefined && current >= 0 && REPLACEABLE[current] === 1 && current !== block && this.inReach(p, x, y, z);
    if (ok) {
      // Must be placed against something.
      const around = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
      ok = around.some(([dx, dy, dz]) => {
        const n = this.world.getBlock(x + dx, y + dy, z + dz);
        return n > 0 && !REPLACEABLE[n];
      });
    }
    if (ok && needsSupport(block!)) {
      const below = this.world.getBlock(x, y - 1, z);
      ok = below > 0 && OPAQUE[below] === 1;
    }
    if (ok && SOLID[block!]) {
      const h = PLAYER_WIDTH / 2;
      for (const q of this.players.values()) {
        const min = [q.pos[0] - h, q.pos[1], q.pos[2] - h];
        const max = [q.pos[0] + h, q.pos[1] + PLAYER_HEIGHT, q.pos[2] + h];
        if (boxOverlapsBlock(min, max, x, y, z)) ok = false;
      }
    }
    if (!ok) {
      this.revert(p, x, y, z);
      this.sendInventory(p);
      return;
    }
    this.setBlockAndBroadcast(x, y, z, block!);
    if (!p.creative) {
      p.inventory.take(p.inventory.selected, 1);
      this.sendInventory(p);
    }
  }

  private setBlockAndBroadcast(x: number, y: number, z: number, id: number): void {
    if (!this.world.setBlock(x, y, z, id)) return;
    const key = chunkKey(x >> 4, z >> 4);
    for (const q of this.players.values()) {
      if (q.sent.has(key)) q.send({ t: 'blockChange', x, y, z, id });
    }
  }

  // --- Tick ------------------------------------------------------------------

  private tick(): void {
    this.tickCount++;
    this.time++;
    if (this.tickCount % 20 === 0) {
      for (const p of this.players.values()) p.send({ t: 'time', time: this.time });
    }
    for (const p of this.players.values()) this.stream(p);
    if (this.tickCount % 100 === 0) this.unloadFarChunks();
    if (this.tickCount % AUTOSAVE_TICKS === 0) void this.save();
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
    const unsaved = this.world.unloadWhere((cx, cz) => centers.some(([px, pz]) => (cx - px) ** 2 + (cz - pz) ** 2 <= keepR));
    const store = this.options.store;
    if (unsaved.length > 0 && store) {
      this.saving = this.saving
        .then(() => store.saveChunks(unsaved))
        .then(() => this.world.markSaved(unsaved))
        .catch((err) => console.error('saving unloaded chunks failed', err));
    }
  }

  /** Writes changed chunks, players and world time. Saves are serialized. */
  save(): Promise<void> {
    const store = this.options.store;
    if (!store) return Promise.resolve();
    const chunks = this.world.takeModified();
    for (const p of this.players.values()) this.meta.players[p.name] = p.save();
    this.meta.time = this.time;
    this.meta.lastPlayed = Date.now();
    const meta: WorldMeta = JSON.parse(JSON.stringify(this.meta));
    this.saving = this.saving
      .then(() => store.saveChunks(chunks))
      .then(() => store.saveMeta(meta))
      .catch((err) => {
        console.error('save failed', err);
        this.world.markModified(chunks); // try again on the next save
      });
    return this.saving;
  }

  get dayTime(): number {
    return this.time % DAY_LENGTH_TICKS;
  }

  get playerCount(): number {
    return this.players.size;
  }
}
