import { B, DIR_VEC, DOOR_OPEN, DOOR_UPPER, OPAQUE, POWER_ON, RENDER, REPLACEABLE, SOLID, withState } from '../shared/blocks/registry';
import { isInteractive } from '../shared/blocks/placement';
import { runeLevel, RUNE_BOUNTY, RUNE_ENDURE, RUNE_KEEN, RUNE_SWIFT } from '../shared/items/runes';
import { isPowerBlock, isSignalBlock, PowerGrid } from './power';
import { isSupported } from '../shared/blocks/placement';
import { DAY_LENGTH_TICKS, GameMode, MAX_PLAYERS, PROTOCOL_VERSION, SEA_LEVEL, TICK_MS } from '../shared/constants';
import { DEEP_ORIGIN, isDeep } from '../shared/world/dimensions';
import { SMELT_TICKS, SMELTING } from '../shared/items/crafting';
import { canMerge, copyStack, HOTBAR_SIZE, InvAction } from '../shared/items/Inventory';
import { blockDrops, breakTime, EAT_TIME, REACH } from '../shared/items/mining';
import { I, itemDef, maxStack, type ItemStack } from '../shared/items/registry';
import { emptySlots, FURNACE_FUEL, FURNACE_INPUT, FURNACE_OUTPUT } from '../shared/items/Window';
import { boxOverlapsBlock } from '../shared/physics/collision';
import { EYE_HEIGHT, PLAYER_HEIGHT, PLAYER_WIDTH } from '../shared/physics/PlayerBody';
import type { ClientMsg, ServerMsg, Vec3 } from '../shared/protocol/messages';
import { Anim, MoveFlag } from '../shared/protocol/messages';
import type { BlockEntity } from '../shared/world/blockEntities';
import { Chunk, chunkKey, idx } from '../shared/world/Chunk';
import type { Transport } from '../net/Transport';
import { ItemEntities } from './ItemEntities';
import { settlementsTouching } from './worldgen/settlements';
import { TRADES, type Trade } from '../shared/entities/trades';
import { MobManager, type MobTarget } from './mobs/MobManager';
import { Mob, mobDef, PLAYER_ATTACK_COOLDOWN, PLAYER_ATTACK_REACH } from '../shared/entities/mobs';
import { MAX_AIR, MAX_FOOD, MAX_HEALTH, PlayerSession, type OpenWindow } from './PlayerSession';
import { WorldGenerator } from './worldgen/WorldGenerator';
import { ashwoodTree, frostpineTree, TREE_HEIGHT } from './worldgen/trees';
import { ServerWorld, type ChunkGenerator } from './ServerWorld';
import type { ChunkStore, WorldMeta } from './storage/WorldStorage';

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
/** Slack for network latency when checking reach and timings. */
const REACH_SLACK = 1.5;
const TIME_TOLERANCE = 0.7;
const RANDOM_TICKS_PER_SECTION = 3;
const NIGHT_START = 12500;
const NIGHT_END = 23500;

const CREATIVE_KIT = [B.GRASS, B.DIRT, B.STONE, B.ASHWOOD_PLANKS, B.ASHWOOD_LOG, B.GLASS, B.TORCH, B.LUMEN_CRYSTAL, B.WATER];
const DEATH_MESSAGES: Record<string, string> = {
  fall: 'נפלת מגובה רב',
  drown: 'טבעת',
  starve: 'גוועת ברעב',
  thorn: 'נדקרת מקוץ של קוצן',
  spores: 'נחנקת בענן נבגים של פטריון',
  magma: 'נשרפת במאגמה',
};

function deathMessage(cause: string): string {
  if (cause.startsWith('mob:')) {
    const key = cause.slice(4);
    const def = Object.values(Mob).map((k) => mobDef(k)!).find((d) => d.key === key);
    return `הובסת על ידי ${def?.name ?? 'יצור'}`;
  }
  return DEATH_MESSAGES[cause] ?? 'מתת';
}

const posKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** Blocks whose drops a bounty rune can multiply. */
const BOUNTY_BLOCKS = new Set<number>([B.COAL_ORE, B.IRON_ORE, B.GOLD_ORE, B.DIAMOND_ORE, B.EMBER_ORE, B.LUMEN_CRYSTAL, B.SUNWHEAT]);

/** 1–16 characters: letters (any script), digits, space, _ and -. */
export function sanitizeName(name: unknown): string | null {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (s.length < 1 || s.length > 16 || !/^[\p{L}\p{N} _-]+$/u.test(s)) return null;
  return s;
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
  readonly items: ItemEntities;
  readonly mobs: MobManager;
  /** Spawning can be switched off (tests, peaceful worlds later). */
  mobSpawning = true;
  time: number;
  private nextEntityId = 1;
  readonly power: PowerGrid;
  /** Same generator the workers use, for pure lookups (surface heights, settlements). */
  private readonly generator: WorldGenerator;
  private inPower = 0;
  /** Relay/inverter evaluations due at a tick. */
  private readonly scheduled = new Map<number, Vec3[]>();
  /** Pressure plates currently pressed, by "x,y,z". */
  private readonly pressedPlates = new Map<string, Vec3>();
  private readonly players = new Map<number, PlayerSession>();
  /** Furnaces that are burning or have work queued, by "x,y,z". */
  private readonly furnaces = new Map<string, Vec3>();
  /** Players looking into a chest/furnace, by "x,y,z". */
  private readonly viewers = new Map<string, Set<PlayerSession>>();
  private nextPlayerId = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  private saving: Promise<void> = Promise.resolve();
  /** Chunk offsets within the streaming radius, nearest first. */
  private readonly offsetCache = new Map<number, Array<[number, number]>>();

  constructor(readonly options: ServerOptions, generator: ChunkGenerator) {
    this.meta = options.meta;
    this.time = this.meta.time;
    this.world = new ServerWorld(generator, options.store);
    this.world.onLoad = (c) => this.chunkLoaded(c);
    this.generator = new WorldGenerator(this.meta.seed);
    this.spawn = this.generator.findSpawn();
    this.power = new PowerGrid({
      getRaw: (x, y, z) => this.world.getRaw(x, y, z),
      setRaw: (x, y, z, raw) => {
        this.inPower++;
        try {
          this.setBlockAndBroadcast(x, y, z, raw);
        } finally {
          this.inPower--;
        }
      },
      hasBlockEntity: (x, y, z) => !!this.world.getBlockEntity(x, y, z),
      schedule: (ticks, x, y, z) => {
        const at = this.tickCount + ticks;
        const list = this.scheduled.get(at) ?? [];
        if (!list.some(([a, b, c]) => a === x && b === y && c === z)) list.push([x, y, z]);
        this.scheduled.set(at, list);
      },
    });
    const allocId = () => this.nextEntityId++;
    this.mobs = new MobManager(this.world, allocId, {
      spawned: (info) => this.toChunkViewers(info.x, info.z, { t: 'entitySpawn', entity: info }),
      despawned: (id) => this.broadcast({ t: 'entityDespawn', id }),
      moved: (list) => {
        for (const p of this.players.values()) {
          const data: number[] = [];
          for (const m of list) {
            if (p.sent.has(chunkKey(Math.floor(m.x) >> 4, Math.floor(m.z) >> 4))) data.push(m.id, m.x, m.y, m.z, m.yaw, m.anim);
          }
          if (data.length > 0) p.send({ t: 'mobMove', data });
        }
      },
      event: (id, event, x, z) => this.toChunkViewers(x, z, { t: 'entityEvent', id, event }),
      drops: (items, x, y, z) => this.items.spawnDrops(items, x, y, z),
    });
    this.items = new ItemEntities(this.world, allocId, {
      spawned: (e) => this.toChunkViewers(e.x, e.z, { t: 'entitySpawn', entity: ItemEntities.info(e) }),
      despawned: (e, pickedBy) => this.broadcast({ t: 'entityDespawn', id: e.id, pickedBy }),
      moved: (list) => {
        for (const p of this.players.values()) {
          const data: number[] = [];
          for (const e of list) {
            if (p.sent.has(chunkKey(Math.floor(e.x) >> 4, Math.floor(e.z) >> 4))) data.push(e.id, e.x, e.y, e.z);
          }
          if (data.length > 0) p.send({ t: 'entityMove', data });
        }
      },
    });
  }

  /** Chunk offsets within a streaming radius, nearest first. */
  private offsets(radius: number): Array<[number, number]> {
    let list = this.offsetCache.get(radius);
    if (!list) {
      list = [];
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) if (dx * dx + dz * dz <= radius * radius + radius) list.push([dx, dz]);
      }
      list.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));
      this.offsetCache.set(radius, list);
    }
    return list;
  }

  /** Streaming radius for a player: one ring beyond their view distance so the visible edge can be meshed. */
  private radiusOf(p: PlayerSession): number {
    return (p.viewDistance || this.options.viewDistance) + 1;
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
    for (const p of this.players.values()) this.closeWindows(p);
    await this.save();
    for (const p of [...this.players.values()]) {
      if (!p.isHost) p.send({ t: 'kick', reason: 'המארח סגר את העולם' });
      p.transport.close('server stopped');
    }
    this.players.clear();
  }

  addConnection(transport: Transport<ServerMsg, ClientMsg>, opts: { host?: boolean } = {}): void {
    const session = new PlayerSession(this.nextPlayerId++, transport, !!opts.host);
    transport.onMessage = (msg) => {
      session.lastSeen = performance.now();
      try {
        if (msg && typeof msg === 'object') this.handle(session, msg);
      } catch (err) {
        console.error('bad message from player', session.id, msg, err);
      }
    };
    transport.onClose = () => {
      if (!this.players.has(session.id)) return;
      this.players.delete(session.id);
      if (session.joined) {
        this.closeWindows(session);
        this.meta.players[session.name] = session.save();
        this.broadcast({ t: 'playerLeave', id: session.id });
        this.broadcastChat(`${session.name} יצא/ה מהעולם`);
        this.sendPlayerList();
      }
    };
  }

  private broadcast(msg: ServerMsg): void {
    for (const p of this.players.values()) p.send(msg);
  }

  private toChunkViewers(x: number, z: number, msg: ServerMsg): void {
    const key = chunkKey(Math.floor(x) >> 4, Math.floor(z) >> 4);
    for (const p of this.players.values()) if (p.sent.has(key)) p.send(msg);
  }

  private chat(p: PlayerSession, text: string): void {
    p.send({ t: 'chat', from: '', text });
  }

  private broadcastChat(text: string, from = ''): void {
    this.broadcast({ t: 'chat', from, text });
  }

  private sendPlayerList(): void {
    const players = [...this.players.values()].filter((q) => q.joined).map((q) => ({ id: q.id, name: q.name, ping: Math.round(q.rtt), host: q.isHost }));
    this.broadcast({ t: 'playerList', players });
  }

  /** Disconnects a player with a reason shown to them. */
  kick(p: PlayerSession, reason: string): void {
    p.send({ t: 'kick', reason });
    p.transport.close(reason);
  }

  // --- Message handling ------------------------------------------------------

  private handle(p: PlayerSession, msg: ClientMsg): void {
    if (!p.joined && msg.t !== 'hello') return;
    if (p.dead && msg.t !== 'respawn' && msg.t !== 'inv' && msg.t !== 'closeWindow') return;
    switch (msg.t) {
      case 'hello':
        this.join(p, msg.v, msg.name);
        break;
      case 'move':
        this.move(p, msg.x, msg.y, msg.z, msg.yaw, msg.pitch, msg.flags);
        break;
      case 'dig':
        this.dig(p, msg.phase, msg.x | 0, msg.y | 0, msg.z | 0);
        break;
      case 'place':
        this.place(p, msg.x | 0, msg.y | 0, msg.z | 0, msg.raw | 0, msg.slot | 0);
        break;
      case 'held':
        if (Number.isInteger(msg.slot) && msg.slot >= 0 && msg.slot < HOTBAR_SIZE) p.inventory.selected = msg.slot;
        p.eating = null;
        break;
      case 'useBlock':
        this.useBlock(p, msg.x | 0, msg.y | 0, msg.z | 0);
        break;
      case 'useItem':
        this.eat(p, msg.phase, msg.slot | 0);
        break;
      case 'drop':
        this.dropHeld(p, !!msg.all);
        break;
      case 'inv':
        this.invAction(p, msg.window | 0, msg.action, msg.slot, msg.button, msg.item);
        break;
      case 'closeWindow':
        this.closeWindow(p, msg.window | 0);
        break;
      case 'setGameMode':
        if (p.isHost && (msg.mode === GameMode.SURVIVAL || msg.mode === GameMode.CREATIVE)) {
          p.gameMode = msg.mode;
          if (!p.creative) p.flying = false;
          p.send({ t: 'gameMode', mode: p.gameMode });
          p.sendStats(true);
        }
        break;
      case 'respawn':
        this.respawn(p);
        break;
      case 'chat':
        this.chatMessage(p, String(msg.text ?? ''));
        break;
      case 'attack':
        this.attack(p, msg.entityId | 0);
        break;
      case 'interact':
        this.interact(p, msg.entityId | 0);
        break;
      case 'trade':
        this.trade(p, msg.entityId | 0, msg.offer | 0);
        break;
      case 'settings':
        if (Number.isFinite(msg.viewDistance)) p.viewDistance = Math.max(2, Math.min(12, Math.round(msg.viewDistance)));
        break;
      case 'pong':
        if (p.pendingPing && p.pendingPing.id === msg.id) {
          p.rtt = performance.now() - p.pendingPing.at;
          p.pendingPing = null;
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
    const clean = sanitizeName(name);
    if (!clean) {
      this.kick(p, 'שם לא חוקי (1–16 תווים: אותיות, ספרות, רווח, _ או -)');
      return;
    }
    if ([...this.players.values()].some((q) => q.joined && q.name.toLowerCase() === clean.toLowerCase())) {
      this.kick(p, `השם "${clean}" כבר בשימוש בעולם הזה. בחרו שם אחר.`);
      return;
    }
    p.name = clean;
    // Single-player saves from before names existed belong to the host.
    if (p.isHost && !this.meta.players[p.name] && this.meta.players.Player) {
      this.meta.players[p.name] = this.meta.players.Player;
      delete this.meta.players.Player;
    }
    const saved = this.meta.players[p.name];
    if (saved) {
      p.load(saved);
    } else {
      p.pos = [...this.spawn];
      p.yaw = Math.PI * 0.75;
      p.gameMode = this.meta.gameMode;
      if (p.creative) CREATIVE_KIT.forEach((id, i) => p.inventory.applyCreative(InvAction.CREATIVE_SLOT, i, 0, id));
    }
    p.fallStartY = p.pos[1];
    p.lastMoveAt = performance.now();
    p.joined = true;
    this.players.set(p.id, p);
    for (const q of this.players.values()) if (q !== p && q.joined) q.send({ t: 'playerJoin', player: { id: p.id, name: p.name } });
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
      players: [...this.players.values()].filter((q) => q.joined).map((q) => ({ id: q.id, name: q.name })),
    });
    p.sendInventory();
    this.sendWindow(p, null);
    p.sendStats(true);
    if (this.players.size > 1) this.broadcastChat(`${p.name} נכנס/ה לעולם`);
    this.sendPlayerList();
  }

  private inReach(p: PlayerSession, x: number, y: number, z: number): boolean {
    const dx = x + 0.5 - p.pos[0];
    const dy = y + 0.5 - (p.pos[1] + EYE_HEIGHT);
    const dz = z + 0.5 - p.pos[2];
    return Math.hypot(dx, dy, dz) <= REACH + REACH_SLACK;
  }

  /** Re-sends the true state of a block to a client whose prediction was rejected. */
  private revert(p: PlayerSession, x: number, y: number, z: number): void {
    const raw = this.world.getRaw(x, y, z);
    if (raw >= 0) p.send({ t: 'blockChange', x, y, z, id: raw });
  }

  private setBlockAndBroadcast(x: number, y: number, z: number, raw: number): void {
    const old = this.world.getRaw(x, y, z);
    if (!this.world.setBlock(x, y, z, raw)) return;
    this.toChunkViewers(x, z, { t: 'blockChange', x, y, z, id: raw });
    if (this.inPower === 0 && this.nearPower(x, y, z, old, raw)) {
      this.inPower++;
      try {
        this.power.update(x, y, z, isSignalBlock(old & 0xfff) || isSignalBlock(raw & 0xfff));
      } finally {
        this.inPower--;
      }
    }
  }

  /** True if a change at (x, y, z) can affect a signal (the block or a neighbour is power-related). */
  private nearPower(x: number, y: number, z: number, old: number, raw: number): boolean {
    if (isPowerBlock(old & 0xfff) || isPowerBlock(raw & 0xfff)) return true;
    for (const [dx, dy, dz] of DIR_VEC) if (isPowerBlock(this.world.getBlock(x + dx, y + dy, z + dz))) return true;
    return false;
  }

  /** Wears a tool by `amount`; endurance runes may spare it. */
  private wearTool(p: PlayerSession, amount: number): void {
    const held = p.inventory.held;
    const tool = held ? itemDef(held.id)?.tool : undefined;
    if (!held || !tool || p.creative) return;
    if (Math.random() >= 1 / (runeLevel(held, RUNE_ENDURE) + 1)) return;
    held.dmg = (held.dmg ?? 0) + amount;
    if (held.dmg >= tool.durability) {
      p.inventory.slots[p.inventory.selected] = null;
      this.chat(p, `${itemDef(held.id)?.name} נשבר!`);
    }
    p.sendInventory();
  }

  // --- Movement, health, hunger --------------------------------------------------

  private move(p: PlayerSession, x: number, y: number, z: number, yaw: number, pitch: number, flags: number): void {
    if (![x, y, z, yaw, pitch].every(Number.isFinite) || y < -64 || y > 512) return;
    const now = performance.now();
    if (p.teleportTarget) {
      // Ignore moves the client sent before it saw the teleport.
      const [tx, ty, tz] = p.teleportTarget;
      if (Math.hypot(x - tx, y - ty, z - tz) > 2 && now - p.teleportAt < 5000) return;
      p.teleportTarget = null;
      p.lastMoveAt = now;
    }
    const [ox, oy, oz] = p.pos;
    // Speed check: generous limits (latency bursts, sprint-jumping); a cheat client moving
    // faster is pulled back to its last accepted position.
    const dt = Math.min(1, Math.max(0.05, (now - p.lastMoveAt) / 1000));
    const fly = p.creative && (flags & MoveFlag.FLYING) !== 0;
    const maxH = (fly ? 24 : 8) * dt + 1.5;
    const maxUp = (fly ? 20 : 10) * dt + 1.5;
    if (Math.hypot(x - ox, z - oz) > maxH || y - oy > maxUp) {
      p.violations++;
      this.teleport(p, [ox, oy, oz]);
      return;
    }
    p.violations = Math.max(0, p.violations - 0.02);
    p.lastMoveAt = now;
    p.sneaking = (flags & MoveFlag.SNEAK) !== 0;
    const onGround = (flags & MoveFlag.ON_GROUND) !== 0;
    p.flying = p.creative && (flags & MoveFlag.FLYING) !== 0;
    if (!p.creative && !p.flying) {
      const dist = Math.min(10, Math.hypot(x - ox, z - oz));
      const sprint = (flags & MoveFlag.SPRINT) !== 0;
      p.addExhaustion(dist * (sprint ? 0.1 : 0.01));
      if (p.onGround && !onGround && y > oy) p.addExhaustion(sprint ? 0.2 : 0.05);
    }
    const inWater = this.world.getBlock(Math.floor(x), Math.floor(y + 0.2), Math.floor(z)) === B.WATER;
    if (p.flying || p.creative || inWater) p.fallStartY = y;
    else if (!onGround) p.fallStartY = p.onGround ? Math.max(oy, y) : Math.max(p.fallStartY, y);
    else {
      if (!p.onGround) {
        const fall = p.fallStartY - y;
        if (fall > 3.5) this.damage(p, Math.floor(fall - 3), 'fall');
      }
      p.fallStartY = y;
    }
    p.onGround = onGround;
    p.pos = [x, y, z];
    p.yaw = yaw;
    p.pitch = pitch;
  }

  private tickPlayer(p: PlayerSession): void {
    if (!p.alive) return;
    if (p.hurtCooldown > 0) p.hurtCooldown--;
    if (p.creative) {
      p.air = MAX_AIR;
      p.sendStats();
      return;
    }
    const feetBlock = this.world.getBlock(Math.floor(p.pos[0]), Math.floor(p.pos[1] + 0.2), Math.floor(p.pos[2]));
    // Rifts: stand inside one for two seconds to cross over.
    if (p.riftCooldown > 0) p.riftCooldown--;
    if (feetBlock === B.RIFT && p.riftCooldown === 0 && !p.travelling) {
      if (++p.riftTicks >= 40) void this.travel(p);
    } else p.riftTicks = 0;
    if (feetBlock === B.MAGMA && this.tickCount % 10 === 0) this.damage(p, 3, 'magma');
    if (!p.alive) return;
    const eye = this.world.getBlock(Math.floor(p.pos[0]), Math.floor(p.pos[1] + EYE_HEIGHT), Math.floor(p.pos[2]));
    if (eye === B.WATER) {
      p.air = Math.max(-1, p.air - 1);
      if (p.air < 0 && ++p.drownTimer >= 20) {
        p.drownTimer = 0;
        this.damage(p, 2, 'drown');
      }
    } else {
      p.air = Math.min(MAX_AIR, p.air + 5);
      p.drownTimer = 0;
    }
    if (p.food >= 18 && p.health < MAX_HEALTH) {
      if (++p.regenTimer >= 80) {
        p.regenTimer = 0;
        p.health++;
        p.addExhaustion(6);
      }
    } else p.regenTimer = 0;
    if (p.food <= 0) {
      if (++p.starveTimer >= 80) {
        p.starveTimer = 0;
        if (p.health > 1) this.damage(p, 1, 'starve');
      }
    } else p.starveTimer = 0;
    p.sendStats();
  }

  /** Adapter the creature AI uses to find and hurt players. */
  private mobTargets(): MobTarget[] {
    return [...this.players.values()].filter((p) => p.joined).map((p) => ({
      id: p.id,
      pos: p.pos,
      alive: p.alive,
      creative: p.creative,
      hurt: (amount: number, cause: string, from: readonly number[]) => {
        if (p.hurtCooldown > 0 || !p.alive || p.creative) return;
        p.hurtCooldown = 10;
        const dx = p.pos[0] - from[0];
        const dz = p.pos[2] - from[2];
        const len = Math.hypot(dx, dz) || 1;
        p.send({ t: 'knockback', vx: (dx / len) * 7, vy: 5, vz: (dz / len) * 7 });
        this.damage(p, amount, cause);
      },
    }));
  }

  private attack(p: PlayerSession, mobId: number): void {
    const now = performance.now();
    if (now - p.lastAttackAt < PLAYER_ATTACK_COOLDOWN * 1000 * TIME_TOLERANCE) return;
    const m = this.mobs.mobs.get(mobId);
    if (!m) return;
    const b = m.body;
    const ex = p.pos[0];
    const ey = p.pos[1] + EYE_HEIGHT;
    const ez = p.pos[2];
    // Distance from the eye to the nearest point of the creature's box.
    const cx = Math.max(b.x - b.width / 2, Math.min(ex, b.x + b.width / 2));
    const cy = Math.max(b.y, Math.min(ey, b.y + b.height));
    const cz = Math.max(b.z - b.width / 2, Math.min(ez, b.z + b.width / 2));
    if (Math.hypot(cx - ex, cy - ey, cz - ez) > PLAYER_ATTACK_REACH + REACH_SLACK) return;
    p.lastAttackAt = now;
    p.swingUntil = now + 300;
    const held = p.inventory.held;
    const tool = held ? itemDef(held.id)?.tool : undefined;
    const base = !tool ? 1 : tool.kind === 'sword' ? tool.damage : tool.kind === 'axe' ? tool.damage - 1 : 2;
    const dmg = base + runeLevel(held, RUNE_KEEN);
    if (!this.mobs.hit(mobId, dmg, p.pos)) return;
    p.addExhaustion(0.1);
    if (tool) this.wearTool(p, tool.kind === 'sword' ? 1 : 2);
  }

  private traderFor(p: PlayerSession, id: number): { offers: Trade[]; profession: number } | null {
    const m = this.mobs.mobs.get(id);
    if (!m || !m.def.trader || m.deadTicks > 0) return null;
    if (Math.hypot(m.body.x - p.pos[0], m.body.y - p.pos[1], m.body.z - p.pos[2]) > PLAYER_ATTACK_REACH + REACH_SLACK + 1) return null;
    const profession = m.variant ?? 0;
    return { offers: TRADES[profession] ?? [], profession };
  }

  private interact(p: PlayerSession, id: number): void {
    const t = this.traderFor(p, id);
    if (t) p.send({ t: 'trades', entityId: id, profession: t.profession, offers: t.offers });
  }

  private trade(p: PlayerSession, id: number, offer: number): void {
    const t = this.traderFor(p, id);
    const o = t?.offers[offer];
    if (!o || p.dead) return;
    const inv = p.inventory;
    const have = (item: number) => inv.slots.reduce((n, s) => n + (s && s.id === item && !s.dmg && !s.runes ? s.count : 0), 0);
    if (!o.give.every((g) => have(g.id) >= g.count)) {
      p.sendInventory();
      return;
    }
    for (const g of o.give) {
      let left = g.count;
      for (let i = 0; i < inv.slots.length && left > 0; i++) {
        const s = inv.slots[i];
        if (!s || s.id !== g.id || s.dmg || s.runes) continue;
        const n = Math.min(left, s.count);
        inv.take(i, n);
        left -= n;
      }
    }
    const extra = inv.addStack({ ...o.get });
    if (extra > 0) this.throwItem(p, { ...o.get, count: extra });
    p.sendInventory();
  }

  private damage(p: PlayerSession, amount: number, cause: string): void {
    if (!p.alive || p.creative || amount <= 0) return;
    p.health = Math.max(0, p.health - amount);
    p.send({ t: 'hurt', amount });
    if (p.health <= 0) this.die(p, cause);
    p.sendStats();
  }

  private die(p: PlayerSession, cause: string): void {
    p.dead = true;
    p.health = 0;
    p.eating = null;
    p.dig = null;
    this.closeWindows(p);
    const eye = [p.pos[0], p.pos[1] + 1, p.pos[2]];
    for (const s of p.inventory.takeAll()) {
      const a = Math.random() * Math.PI * 2;
      const v = 1 + Math.random() * 2;
      this.items.spawn(s, eye[0], eye[1], eye[2], Math.cos(a) * v, 2 + Math.random() * 2, Math.sin(a) * v, 40);
    }
    p.sendInventory();
    p.sendStats(true);
    p.send({ t: 'death', message: deathMessage(cause) });
    if (this.players.size > 1) this.broadcastChat(`${p.name}: ${deathMessage(cause)}`);
  }

  private respawn(p: PlayerSession): void {
    if (!p.dead) return;
    p.dead = false;
    p.health = MAX_HEALTH;
    p.food = MAX_FOOD;
    p.saturation = 5;
    p.exhaustion = 0;
    p.air = MAX_AIR;
    let target = this.spawn;
    if (p.spawnPoint) {
      const [bx, by, bz] = p.spawnPoint;
      if (this.world.getBlock(Math.floor(bx), Math.floor(by) - 1, Math.floor(bz)) === B.BEDROLL) target = p.spawnPoint;
      else {
        p.spawnPoint = null;
        this.chat(p, 'שק השינה שלך חסר — חזרת לנקודת ההתחלה של העולם');
      }
    }
    this.teleport(p, target);
    p.sendStats(true);
    p.sendInventory();
  }

  private teleport(p: PlayerSession, pos: Vec3): void {
    p.pos = [...pos];
    p.teleportTarget = [...pos];
    p.teleportAt = performance.now();
    p.fallStartY = pos[1];
    p.onGround = true;
    p.send({ t: 'teleport', x: pos[0], y: pos[1], z: pos[2] });
  }

  // --- Breaking and placing ------------------------------------------------------

  private dig(p: PlayerSession, phase: number, x: number, y: number, z: number): void {
    if (phase !== 1) p.swingUntil = performance.now() + 300;
    if (phase === 0) {
      p.dig = { x, y, z, start: performance.now() };
      return;
    }
    if (phase === 1) {
      p.dig = null;
      return;
    }
    const raw = this.world.getRaw(x, y, z);
    const id = raw & 0xfff;
    const target = raw > 0 && RENDER[id] !== 0 && RENDER[id] !== 3;
    const held = p.inventory.held;
    const heldDef = held ? itemDef(held.id) : undefined;
    let ok = target && this.inReach(p, x, y, z);
    if (ok && !p.creative) {
      const need = breakTime(id, heldDef, false, runeLevel(held, RUNE_SWIFT));
      const d = p.dig;
      const elapsed = d && d.x === x && d.y === y && d.z === z ? (performance.now() - d.start) / 1000 : 0;
      ok = Number.isFinite(need) && elapsed >= need * TIME_TOLERANCE - 0.1;
    }
    p.dig = null;
    if (!ok) {
      this.revert(p, x, y, z);
      return;
    }
    this.breakBlock(x, y, z, raw, !p.creative, heldDef, runeLevel(held, RUNE_BOUNTY));
    if (!p.creative) {
      p.addExhaustion(0.005);
      if (heldDef?.tool && breakTime(id, undefined, false) > 0) this.wearTool(p, heldDef.tool.kind === 'sword' ? 2 : 1);
    }
  }

  /** Removes a block, drops what it yields (and its contents), and pops blocks it was holding up. */
  private breakBlock(x: number, y: number, z: number, raw: number, drops: boolean, held: ReturnType<typeof itemDef>, bounty = 0): void {
    this.setBlockAndBroadcast(x, y, z, B.AIR);
    const be = this.world.getBlockEntity(x, y, z);
    if (be) {
      // Container contents always spill out, even in creative.
      this.items.spawnDrops(be.slots.filter((s): s is ItemStack => !!s), x, y, z);
      this.world.setBlockEntity(x, y, z, null);
      this.furnaces.delete(posKey(x, y, z));
      for (const v of this.viewers.get(posKey(x, y, z)) ?? []) this.closeWindow(v, v.window?.id ?? -1, true);
      this.viewers.delete(posKey(x, y, z));
    }
    if (drops) {
      const items = blockDrops(raw, held, Math.random);
      // Bounty runes: ores and ripe crops may give extra.
      if (bounty > 0 && BOUNTY_BLOCKS.has(raw & 0xfff)) for (const it of items) it.count += Math.floor(Math.random() * (bounty + 1));
      this.items.spawnDrops(items, x, y, z);
    }
    this.cascadeSupport(x, y, z, drops);
  }

  private cascadeSupport(x: number, y: number, z: number, drops: boolean): void {
    const queue: Vec3[] = [[x, y, z]];
    const get = (a: number, b: number, c: number) => this.world.getRaw(a, b, c);
    for (let guard = 0; queue.length > 0 && guard < 256; guard++) {
      const [qx, qy, qz] = queue.shift()!;
      for (const [dx, dy, dz] of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
        const nx = qx + dx;
        const ny = qy + dy;
        const nz = qz + dz;
        const raw = get(nx, ny, nz);
        if (raw <= 0 || isSupported(get, nx, ny, nz, raw)) continue;
        this.setBlockAndBroadcast(nx, ny, nz, B.AIR);
        if (drops) this.items.spawnDrops(blockDrops(raw, undefined, Math.random), nx, ny, nz);
        queue.push([nx, ny, nz]);
      }
    }
  }

  private place(p: PlayerSession, x: number, y: number, z: number, raw: number, slot: number): void {
    p.swingUntil = performance.now() + 300;
    if (slot >= 0 && slot < HOTBAR_SIZE) p.inventory.selected = slot;
    const stack = p.inventory.held;
    const block = stack ? itemDef(stack.id)?.block : undefined;
    const id = raw & 0xfff;
    const state = raw >>> 12;
    const door = id === B.ASHWOOD_DOOR;
    const current = this.world.getBlock(x, y, z);
    let ok = block !== undefined && block === id && current >= 0 && REPLACEABLE[current] === 1 && current !== id && this.inReach(p, x, y, z);
    // Only orientations a player could produce.
    if (ok) {
      if (id === B.TORCH) ok = state <= 4;
      else if (id === B.RELAY || id === B.INVERTER) ok = state <= 3;
      else if (id === B.PUSHER) ok = state <= 5;
      else if (id === B.FURNACE || id === B.CHEST) ok = state <= 3;
      else if (door) ok = state <= 3;
      else ok = state === 0;
    }
    if (ok) {
      const around = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
      ok = around.some(([dx, dy, dz]) => {
        const n = this.world.getBlock(x + dx, y + dy, z + dz);
        return n > 0 && !REPLACEABLE[n];
      });
    }
    const get = (a: number, b: number, c: number) => this.world.getRaw(a, b, c);
    if (ok && door) {
      const above = this.world.getBlock(x, y + 1, z);
      ok = OPAQUE[this.world.getBlock(x, y - 1, z) & 0xfff] === 1 && above >= 0 && REPLACEABLE[above] === 1;
    } else if (ok) {
      ok = isSupported(get, x, y, z, raw);
    }
    if (ok && SOLID[id]) {
      const h = PLAYER_WIDTH / 2;
      for (const q of this.players.values()) {
        if (!q.alive) continue;
        const min = [q.pos[0] - h, q.pos[1], q.pos[2] - h];
        const max = [q.pos[0] + h, q.pos[1] + PLAYER_HEIGHT, q.pos[2] + h];
        if (boxOverlapsBlock(min, max, x, y, z) || (door && boxOverlapsBlock(min, max, x, y + 1, z))) ok = false;
      }
    }
    if (!ok) {
      this.revert(p, x, y, z);
      if (door) this.revert(p, x, y + 1, z);
      p.sendInventory();
      return;
    }
    this.setBlockAndBroadcast(x, y, z, raw);
    if (door) this.setBlockAndBroadcast(x, y + 1, z, withState(id, state | DOOR_UPPER));
    if (!p.creative) {
      p.inventory.take(p.inventory.selected, 1);
      p.sendInventory();
    }
  }

  // --- Interactive blocks --------------------------------------------------------

  private useBlock(p: PlayerSession, x: number, y: number, z: number): void {
    p.swingUntil = performance.now() + 300;
    if (!this.inReach(p, x, y, z)) return;
    const raw = this.world.getRaw(x, y, z);
    const id = raw & 0xfff;
    switch (id) {
      case B.WORKBENCH:
        this.closeWindows(p);
        p.openWindow('workbench', emptySlots('workbench'), [x, y, z]);
        this.sendWindow(p, p.window);
        break;
      case B.FURNACE:
      case B.FURNACE_LIT:
      case B.CHEST: {
        this.closeWindows(p);
        const kind = id === B.CHEST ? 'chest' : 'furnace';
        let be = this.world.getBlockEntity(x, y, z);
        if (!be || be.kind !== kind) {
          be = kind === 'chest'
            ? { kind: 'chest', slots: emptySlots('chest') }
            : { kind: 'furnace', slots: emptySlots('furnace'), burn: 0, burnMax: 0, cook: 0 };
          this.world.setBlockEntity(x, y, z, be);
        }
        p.openWindow(kind, be.slots, [x, y, z]);
        const key = posKey(x, y, z);
        if (!this.viewers.has(key)) this.viewers.set(key, new Set());
        this.viewers.get(key)!.add(p);
        this.sendWindow(p, p.window);
        break;
      }
      case B.ASHWOOD_DOOR: {
        const state = raw >>> 12;
        const lower = state & DOOR_UPPER ? y - 1 : y;
        for (const yy of [lower, lower + 1]) {
          const r = this.world.getRaw(x, yy, z);
          if ((r & 0xfff) === B.ASHWOOD_DOOR) this.setBlockAndBroadcast(x, yy, z, r ^ (DOOR_OPEN << 12));
        }
        break;
      }
      case B.BEDROLL:
        this.sleep(p, x, y, z);
        break;
      case B.LEVER:
        this.setBlockAndBroadcast(x, y, z, raw ^ (POWER_ON << 12));
        break;
      case B.RUNE_TABLE:
        this.closeWindows(p);
        p.openWindow('runetable', emptySlots('runetable'), [x, y, z]);
        this.sendWindow(p, p.window);
        break;
      case B.RIFT_STONE:
        this.igniteRift(p, x, y, z);
        break;
      case B.SUNWHEAT: {
        // Spore powder makes crops grow.
        const held = p.inventory.held;
        if (held?.id !== I.SPORE_POWDER || (raw >>> 12) >= 7) break;
        this.setBlockAndBroadcast(x, y, z, withState(B.SUNWHEAT, Math.min(7, (raw >>> 12) + 2 + Math.floor(Math.random() * 3))));
        if (!p.creative) {
          p.inventory.take(p.inventory.selected, 1);
          p.sendInventory();
        }
        break;
      }
      default: {
        // Tilling: a shovel turns grass or dirt with air above into farmland.
        const held = p.inventory.held;
        if (!held || !isInteractive(id, held.id)) break;
        if (this.world.getBlock(x, y + 1, z) !== B.AIR) break;
        this.setBlockAndBroadcast(x, y, z, B.FARMLAND);
        this.wearTool(p, 1);
        break;
      }
    }
  }

  // --- Rifts and the Ember Deep -------------------------------------------------

  /** Lumen dust on a rift stone ringed by four lumen crystals (diagonal corners) opens a rift. */
  private igniteRift(p: PlayerSession, x: number, y: number, z: number): void {
    const held = p.inventory.held;
    if (held?.id !== I.LUMEN_DUST) return;
    const corners = [[1, 1], [1, -1], [-1, 1], [-1, -1]].every(([dx, dz]) => this.world.getBlock(x + dx, y, z + dz) === B.LUMEN_CRYSTAL);
    if (!corners) {
      this.chat(p, 'הטקס דורש גביש לומן בכל אחת מארבע הפינות האלכסוניות של אבן הבקע.');
      return;
    }
    for (const dy of [1, 2]) {
      const b = this.world.getBlock(x, y + dy, z);
      if (b !== B.AIR && !REPLACEABLE[b]) {
        this.chat(p, 'צריך שני בלוקים פנויים מעל אבן הבקע.');
        return;
      }
    }
    this.setBlockAndBroadcast(x, y + 1, z, B.RIFT);
    this.setBlockAndBroadcast(x, y + 2, z, B.RIFT);
    if (!p.creative) {
      p.inventory.take(p.inventory.selected, 1);
      p.sendInventory();
    }
    this.chat(p, isDeep(x) ? 'הבקע נפתח! עמדו בתוכו כדי לחזור אל פני השטח.' : 'הבקע נפתח! עמדו בתוכו כדי לרדת אל עמקי הגחלים.');
  }

  /** Moves a player through a rift to the matching place in the other world, building a rift there if needed. */
  private async travel(p: PlayerSession): Promise<void> {
    p.travelling = true;
    p.riftTicks = 0;
    try {
      const toDeep = !isDeep(p.pos[0]);
      const tx = Math.floor(p.pos[0]) + (toDeep ? DEEP_ORIGIN : -DEEP_ORIGIN);
      const tz = Math.floor(p.pos[2]);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) await this.world.ensureChunk((tx >> 4) + dx, (tz >> 4) + dz);
      if (!this.players.has(p.id) || !p.alive) return;
      const dest = this.findRift(tx, tz) ?? this.buildAltar(tx, tz, toDeep, p.pos[1]);
      p.riftCooldown = 100;
      this.closeWindows(p);
      this.teleport(p, dest);
      this.chat(p, toDeep ? 'ירדת אל עמקי הגחלים. היזהרו מהמאגמה!' : 'חזרת אל פני השטח.');
    } finally {
      p.travelling = false;
    }
  }

  /** An existing rift near (x, z): returns a free spot next to it. */
  private findRift(x: number, z: number): Vec3 | null {
    for (let dz = -6; dz <= 6; dz++) for (let dx = -6; dx <= 6; dx++) {
      for (let y = 1; y < 250; y++) {
        if (this.world.getBlock(x + dx, y, z + dz) !== B.RIFT || this.world.getBlock(x + dx, y - 1, z + dz) !== B.RIFT_STONE) continue;
        for (const [ox, oz] of [[0, 2], [0, -2], [2, 0], [-2, 0], [1, 2], [-1, -2]]) {
          const ax = x + dx + ox;
          const az = z + dz + oz;
          if (this.world.boxes(ax, y, az) === null && this.world.boxes(ax, y + 1, az) === null && this.world.boxes(ax, y - 1, az) !== null) {
            return [ax + 0.5, y, az + 0.5];
          }
        }
      }
    }
    return null;
  }

  /** Builds a lit rift altar at (x, z) in the destination world and returns where to stand. */
  private buildAltar(x: number, z: number, deep: boolean, fromY: number): Vec3 {
    const floor = deep ? B.ASHSTONE : B.CUT_STONE;
    let y: number;
    if (deep) {
      y = Math.max(30, Math.min(100, Math.floor(fromY)));
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) for (let dy = 0; dy < 4; dy++) this.setBlockAndBroadcast(x + dx, y + dy, z + dz, B.AIR);
    } else {
      y = Math.max(this.generator.column(x, z).height, SEA_LEVEL) + 1;
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) for (let dy = 0; dy < 4; dy++) this.setBlockAndBroadcast(x + dx, y + dy, z + dz, B.AIR);
    }
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      const corner = Math.abs(dx) === 1 && Math.abs(dz) === 1;
      const id = dx === 0 && dz === 0 ? B.RIFT_STONE : corner ? B.LUMEN_CRYSTAL : floor;
      this.setBlockAndBroadcast(x + dx, y - 1, z + dz, id);
    }
    this.setBlockAndBroadcast(x, y, z, B.RIFT);
    this.setBlockAndBroadcast(x, y + 1, z, B.RIFT);
    return [x + 0.5, y, z + 2.5];
  }

  private sleep(p: PlayerSession, x: number, y: number, z: number): void {
    if (isDeep(x)) {
      this.chat(p, 'בעמקי הגחלים אין יום ולילה, ושק השינה לא נדלק כאן.');
      return;
    }
    p.spawnPoint = [x + 0.5, y + 1, z + 0.5];
    const day = this.dayTime;
    if (day < NIGHT_START || day >= NIGHT_END) {
      this.chat(p, 'נקודת הלידה נקבעה כאן. אפשר לישון רק בלילה.');
      return;
    }
    if (this.mobs.hostilesNear(p.pos[0], p.pos[1], p.pos[2], 10) > 0) {
      this.chat(p, 'אי אפשר לישון כשיצורים עוינים בקרבת מקום.');
      return;
    }
    p.sleptAt = performance.now();
    const awake = [...this.players.values()].filter((q) => q.alive && performance.now() - q.sleptAt > 3000);
    if (awake.length > 0) {
      this.chat(p, `נקודת הלידה נקבעה. ממתינים ש-${awake.length} שחקנים נוספים ילכו לישון…`);
      return;
    }
    this.time += DAY_LENGTH_TICKS - day;
    for (const q of this.players.values()) {
      q.sleptAt = 0;
      q.send({ t: 'time', time: this.time });
      this.chat(q, 'הלילה עבר. בוקר טוב!');
    }
  }

  private chatMessage(p: PlayerSession, raw: string): void {
    const text = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
    if (!text) return;
    const now = performance.now();
    p.chatTimes = p.chatTimes.filter((t) => now - t < 5000);
    if (p.chatTimes.length >= 5) {
      this.chat(p, 'לאט לאט… אפשר לשלוח עד 5 הודעות ב-5 שניות.');
      return;
    }
    p.chatTimes.push(now);
    if (text.startsWith('/')) {
      this.command(p, text.slice(1).split(/\s+/));
      return;
    }
    this.broadcastChat(text, p.name);
  }

  private command(p: PlayerSession, [cmd, ...args]: string[]): void {
    switch (cmd) {
      case 'help':
        this.chat(p, 'פקודות: /list — מי מחובר · /kick שם — הוצאת שחקן · /time day|night · /summon יצור (מארח בלבד)');
        break;
      case 'time': {
        if (!p.isHost) {
          this.chat(p, 'רק המארח יכול לשנות את השעה.');
          break;
        }
        const target = args[0] === 'night' ? 14000 : args[0] === 'day' ? 1000 : NaN;
        if (Number.isNaN(target)) {
          this.chat(p, 'שימוש: /time day או /time night');
          break;
        }
        this.time += ((target - this.dayTime) + DAY_LENGTH_TICKS) % DAY_LENGTH_TICKS;
        this.broadcast({ t: 'time', time: this.time });
        break;
      }
      case 'summon': {
        const def = Object.values(Mob).map((k) => mobDef(k)!).find((d) => d.key === args[0] || d.name === args[0]);
        if (!p.isHost || !def) {
          this.chat(p, p.isHost ? `יצורים: ${Object.values(Mob).map((k) => mobDef(k)!.key).join(', ')}` : 'רק המארח יכול לזמן יצורים.');
          break;
        }
        const d = 3;
        this.mobs.spawn(def.kind, p.pos[0] - Math.sin(p.yaw) * d, p.pos[1] + 0.5, p.pos[2] - Math.cos(p.yaw) * d);
        break;
      }
      case 'list':
        this.chat(p, `מחוברים: ${[...this.players.values()].filter((q) => q.joined).map((q) => q.name).join(', ')}`);
        break;
      case 'kick': {
        if (!p.isHost) {
          this.chat(p, 'רק המארח יכול להוציא שחקנים.');
          break;
        }
        const name = args.join(' ').toLowerCase();
        const target = [...this.players.values()].find((q) => q.joined && q.name.toLowerCase() === name);
        if (!target || target === p) this.chat(p, `לא נמצא שחקן בשם "${args.join(' ')}"`);
        else this.kick(target, 'המארח הוציא אותך מהעולם');
        break;
      }
      default:
        this.chat(p, `פקודה לא מוכרת: /${cmd}. נסו /help`);
    }
  }

  private eat(p: PlayerSession, phase: number, slot: number): void {
    if (phase === 0) {
      p.eating = { slot, start: performance.now() };
      return;
    }
    const e = p.eating;
    p.eating = null;
    if (phase !== 2 || !e || e.slot !== slot || slot !== p.inventory.selected || p.creative) return;
    const held = p.inventory.held;
    const food = held ? itemDef(held.id)?.food : undefined;
    if (!food || p.food >= MAX_FOOD) return;
    if ((performance.now() - e.start) / 1000 < EAT_TIME * TIME_TOLERANCE) return;
    p.food = Math.min(MAX_FOOD, p.food + food.hunger);
    p.saturation = Math.min(p.food, p.saturation + food.saturation);
    p.inventory.take(slot, 1);
    p.sendInventory();
    p.sendStats(true);
  }

  private dropHeld(p: PlayerSession, all: boolean): void {
    const held = p.inventory.held;
    if (!held) return;
    const n = all ? held.count : 1;
    const stack = { ...copyStack(held)!, count: n };
    p.inventory.take(p.inventory.selected, n);
    this.throwItem(p, stack);
    p.sendInventory();
  }

  private throwItem(p: PlayerSession, stack: ItemStack): void {
    const cp = Math.cos(p.pitch);
    const dx = -Math.sin(p.yaw) * cp;
    const dy = Math.sin(p.pitch);
    const dz = -Math.cos(p.yaw) * cp;
    this.items.spawn(stack, p.pos[0] + dx * 0.3, p.pos[1] + EYE_HEIGHT - 0.3, p.pos[2] + dz * 0.3, dx * 5, dy * 5 + 1.5, dz * 5, 40);
  }

  // --- Windows / containers --------------------------------------------------

  private sendWindow(p: PlayerSession, w: OpenWindow | null): void {
    if (!w) {
      p.send({ t: 'window', id: 0, kind: 'inventory', slots: p.craftSlots.map(copyStack) });
      return;
    }
    let progress: [number, number] | undefined;
    if (w.kind === 'furnace' && w.pos) {
      const be = this.world.getBlockEntity(...w.pos);
      if (be?.kind === 'furnace') progress = [be.burnMax > 0 ? be.burn / be.burnMax : 0, be.cook / SMELT_TICKS];
    }
    p.send({ t: 'window', id: w.id, kind: w.kind, slots: w.win.slots.map(copyStack), progress });
  }

  private invAction(p: PlayerSession, window: number, action: number, slot: number, button: number, item: number | undefined): void {
    const open = window === 0 ? null : p.window?.id === window ? p.window : undefined;
    if (open === undefined) {
      p.sendInventory();
      return;
    }
    if (action === InvAction.CREATIVE_CURSOR || action === InvAction.CREATIVE_SLOT) {
      if (p.creative) p.inventory.applyCreative(action, slot, button, item);
    } else if (!p.dead) {
      (open ? open.win : p.invWindow).apply(action, slot, button);
    }
    p.sendInventory();
    this.sendWindow(p, open);
    if (open?.pos && (open.kind === 'chest' || open.kind === 'furnace')) {
      const [x, y, z] = open.pos;
      this.world.touchAt(x, z);
      if (open.kind === 'furnace') this.furnaces.set(posKey(x, y, z), [x, y, z]);
      for (const v of this.viewers.get(posKey(x, y, z)) ?? []) if (v !== p) this.sendWindow(v, v.window);
    }
  }

  /** Closes a window; crafting leftovers and the cursor stack go back into the inventory (or drop). */
  private closeWindow(p: PlayerSession, id: number, notify = false): void {
    const spill: ItemStack[] = [];
    if (id === 0) spill.push(...p.invWindow.returnGrid());
    else if (p.window && p.window.id === id) {
      const w = p.window;
      if (w.kind === 'workbench') spill.push(...w.win.returnGrid());
      if (w.pos) this.viewers.get(posKey(...w.pos))?.delete(p);
      p.window = null;
      if (notify) p.send({ t: 'closeWindow', id });
    }
    const c = p.inventory.cursor;
    if (c) {
      p.inventory.cursor = null;
      const left = p.inventory.addStack(c);
      if (left > 0) spill.push({ ...c, count: left });
    }
    for (const s of spill) this.throwItem(p, s);
    p.sendInventory();
    if (id === 0) this.sendWindow(p, null);
  }

  private closeWindows(p: PlayerSession): void {
    if (p.window) this.closeWindow(p, p.window.id, true);
    this.closeWindow(p, 0);
  }

  private tickFurnaces(): void {
    for (const [key, [x, y, z]] of this.furnaces) {
      const be = this.world.getBlockEntity(x, y, z);
      if (!be || be.kind !== 'furnace') {
        this.furnaces.delete(key);
        continue;
      }
      const [input, fuel, out] = [be.slots[FURNACE_INPUT], be.slots[FURNACE_FUEL], be.slots[FURNACE_OUTPUT]];
      const result = input ? SMELTING.get(input.id) : undefined;
      const canSmelt = !!result && (!out || (canMerge(out, { id: result, count: 1 }) && out.count < maxStack(result)));
      let changed = false;
      if (be.burn > 0) be.burn--;
      const fuelTicks = fuel ? itemDef(fuel.id)?.fuel ?? 0 : 0;
      if (be.burn === 0 && canSmelt && fuelTicks > 0) {
        be.burn = be.burnMax = fuelTicks;
        fuel!.count--;
        if (fuel!.count <= 0) be.slots[FURNACE_FUEL] = null;
        changed = true;
      }
      if (be.burn > 0 && canSmelt) {
        if (++be.cook >= SMELT_TICKS) {
          be.cook = 0;
          input!.count--;
          if (input!.count <= 0) be.slots[FURNACE_INPUT] = null;
          if (out) out.count++;
          else be.slots[FURNACE_OUTPUT] = { id: result!, count: 1 };
          changed = true;
        }
      } else if (be.cook > 0) {
        be.cook = Math.max(0, be.cook - 2);
      }
      const lit = be.burn > 0;
      const raw = this.world.getRaw(x, y, z);
      const want = lit ? B.FURNACE_LIT : B.FURNACE;
      if (raw >= 0 && (raw & 0xfff) !== want) this.setBlockAndBroadcast(x, y, z, withState(want, raw >>> 12));
      this.world.touchAt(x, z);
      const viewers = this.viewers.get(key);
      if (viewers && (changed || this.tickCount % 4 === 0)) for (const v of viewers) this.sendWindow(v, v.window);
      if (!lit && (!canSmelt || fuelTicks === 0) && be.cook === 0) this.furnaces.delete(key);
    }
  }

  private tickPower(): void {
    const due = this.scheduled.get(this.tickCount);
    if (due) {
      this.scheduled.delete(this.tickCount);
      this.inPower++;
      try {
        for (const [x, y, z] of due) this.power.gateTick(x, y, z);
      } finally {
        this.inPower--;
      }
    }
    // Pressure plates: pressed while a player or creature stands on them.
    const occupied = new Map<string, Vec3>();
    const feet = (x: number, y: number, z: number) => {
      const p: Vec3 = [Math.floor(x), Math.floor(y + 0.05), Math.floor(z)];
      if (this.world.getBlock(...p) === B.PRESSURE_PLATE) occupied.set(posKey(...p), p);
    };
    for (const p of this.players.values()) if (p.alive) feet(...(p.pos as Vec3));
    for (const m of this.mobs.mobs.values()) feet(m.body.x, m.body.y, m.body.z);
    for (const [k, p] of this.pressedPlates) {
      if (occupied.has(k)) continue;
      this.pressedPlates.delete(k);
      if (this.world.getBlock(...p) === B.PRESSURE_PLATE) this.setBlockAndBroadcast(...p, B.PRESSURE_PLATE);
    }
    for (const [k, p] of occupied) {
      if (this.pressedPlates.has(k)) continue;
      this.pressedPlates.set(k, p);
      this.setBlockAndBroadcast(...p, withState(B.PRESSURE_PLATE, POWER_ON));
    }
  }

  private chunkLoaded(c: Chunk): void {
    // Settlement centres in this chunk get their traders (they aren't saved; they return with the chunk).
    if (!isDeep(c.cx * 16)) {
      for (const st of settlementsTouching(this.generator, c.cx * 16, c.cz * 16, c.cx * 16 + 15, c.cz * 16 + 15)) {
        if (st.x >> 4 !== c.cx || st.z >> 4 !== c.cz || this.mobs.tradersNear(st.x, st.z, 40) > 0) continue;
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2;
          this.mobs.spawn(Mob.TRADER, st.x + 0.5 + Math.cos(a) * 3, st.y + 1, st.z + 0.5 + Math.sin(a) * 3, { variant: i, home: [st.x + 0.5, st.z + 0.5] });
        }
      }
    }
    for (const [i, be] of c.blockEntities) {
      if (be.kind === 'furnace' && (be.burn > 0 || be.slots[FURNACE_INPUT])) {
        const pos: Vec3 = [c.cx * 16 + (i & 15), i >> 8, c.cz * 16 + ((i >> 4) & 15)];
        this.furnaces.set(posKey(...pos), pos);
      }
    }
  }

  // --- World ticks -------------------------------------------------------------

  private randomTicks(): void {
    for (const c of this.world.chunks.values()) {
      const sections = (c.maxY >> 4) + 1;
      for (let s = 0; s < sections; s++) {
        for (let k = 0; k < RANDOM_TICKS_PER_SECTION; k++) {
          const lx = (Math.random() * 16) | 0;
          const ly = s * 16 + ((Math.random() * 16) | 0);
          const lz = (Math.random() * 16) | 0;
          if (ly >= 255) continue;
          const id = c.blocks[idx(lx, ly, lz)] & 0xfff;
          if (id !== B.DIRT && id !== B.GRASS && id !== B.ASHWOOD_SAPLING && id !== B.FROSTPINE_SAPLING && id !== B.SUNWHEAT && id !== B.FARMLAND) continue;
          const x = c.cx * 16 + lx;
          const z = c.cz * 16 + lz;
          if (id === B.SUNWHEAT) {
            const stage = c.blocks[idx(lx, ly, lz)] >>> 12;
            const wet = (c.blocks[idx(lx, ly - 1, lz)] >>> 12) & 1;
            if (stage < 7 && (c.light[idx(lx, ly, lz)] >> 4) >= 9 && Math.random() < (wet ? 0.35 : 0.12)) {
              this.setBlockAndBroadcast(x, ly, z, withState(B.SUNWHEAT, stage + 1));
            }
            continue;
          }
          if (id === B.FARMLAND) {
            const wet = this.waterNear(x, ly, z) ? 1 : 0;
            const above = c.blocks[idx(lx, ly + 1, lz)] & 0xfff;
            if (!wet && above !== B.SUNWHEAT && Math.random() < 0.1) this.setBlockAndBroadcast(x, ly, z, B.DIRT);
            else if (((c.blocks[idx(lx, ly, lz)] >>> 12) & 1) !== wet) this.setBlockAndBroadcast(x, ly, z, withState(B.FARMLAND, wet));
            continue;
          }
          const above = c.blocks[idx(lx, ly + 1, lz)] & 0xfff;
          const skyAbove = c.light[idx(lx, ly + 1, lz)] >> 4;
          if (id === B.GRASS) {
            if (OPAQUE[above]) this.setBlockAndBroadcast(x, ly, z, B.DIRT);
          } else if (id === B.DIRT) {
            if (!OPAQUE[above] && skyAbove >= 9 && Math.random() < 0.3 && this.grassNear(x, ly, z)) this.setBlockAndBroadcast(x, ly, z, B.GRASS);
          } else if (Math.random() < 0.12 && (c.light[idx(lx, ly, lz)] >> 4) >= 9) {
            this.growTree(x, ly, z, id);
          }
        }
      }
    }
  }

  /** Water within 4 blocks horizontally, at the same level or one above. */
  private waterNear(x: number, y: number, z: number): boolean {
    for (let dy = 0; dy <= 1; dy++) for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
      if (this.world.getBlock(x + dx, y + dy, z + dz) === B.WATER) return true;
    }
    return false;
  }

  private grassNear(x: number, y: number, z: number): boolean {
    for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (this.world.getBlock(x + dx, y + dy, z + dz) === B.GRASS) return true;
    }
    return false;
  }

  private growTree(x: number, y: number, z: number, sapling: number): void {
    const pine = sapling === B.FROSTPINE_SAPLING;
    const height = pine ? TREE_HEIGHT.frostpine : TREE_HEIGHT.ashwood;
    for (let dy = 1; dy < height; dy++) {
      const b = this.world.getBlock(x, y + dy, z);
      if (b !== B.AIR && b !== B.ASHWOOD_LEAVES && b !== B.FROSTPINE_NEEDLES) return;
    }
    this.setBlockAndBroadcast(x, y, z, B.AIR);
    const set = (bx: number, by: number, bz: number, id: number, onlyAir: boolean) => {
      const cur = this.world.getBlock(bx, by, bz);
      if (cur < 0 || by > 255) return;
      if (onlyAir ? cur !== B.AIR : cur !== B.AIR && !REPLACEABLE[cur] && cur !== B.ASHWOOD_LEAVES && cur !== B.FROSTPINE_NEEDLES) return;
      this.setBlockAndBroadcast(bx, by, bz, id);
    };
    const variant = (Math.random() * 1000) | 0;
    if (pine) frostpineTree(set, x, y - 1, z, variant);
    else ashwoodTree(set, x, y - 1, z, variant, this.seed);
  }

  private tick(): void {
    this.tickCount++;
    this.time++;
    if (this.tickCount % 20 === 0) {
      for (const p of this.players.values()) p.send({ t: 'time', time: this.time });
    }
    const now = performance.now();
    for (const p of [...this.players.values()]) {
      if (now - p.lastSeen > 30_000) {
        p.transport.close('לא התקבל מידע מהשחקן 30 שניות');
        continue;
      }
      this.tickPlayer(p);
      this.stream(p);
    }
    if (this.tickCount % 2 === 0) this.sendSnapshots(now);
    if (this.tickCount % 40 === 0) {
      for (const p of this.players.values()) {
        p.pendingPing = { id: this.tickCount, at: now };
        p.send({ t: 'ping', id: this.tickCount });
      }
    }
    if (this.tickCount % 100 === 0) this.sendPlayerList();
    this.items.tick(this.players.values(), this.tickCount);
    const targets = this.mobTargets();
    this.mobs.tick(targets, this.time, this.tickCount);
    if (this.mobSpawning && this.tickCount % 20 === 0) this.mobs.spawnTick(targets, this.time);
    this.tickFurnaces();
    this.tickPower();
    this.randomTicks();
    if (this.tickCount % 100 === 0) this.unloadFarChunks();
    if (this.tickCount % AUTOSAVE_TICKS === 0) void this.save();
  }

  /** Tells every player where the others are (10 Hz). */
  private sendSnapshots(now: number): void {
    const states = [...this.players.values()].filter((q) => q.alive).map((q) => ({
      id: q.id,
      x: q.pos[0],
      y: q.pos[1],
      z: q.pos[2],
      yaw: q.yaw,
      pitch: q.pitch,
      anim: (q.sneaking ? Anim.SNEAK : 0) | (q.swingUntil > now ? Anim.SWING : 0) | (q.flying ? Anim.FLYING : 0),
    }));
    if (states.length < 2) return;
    for (const p of this.players.values()) {
      if (!p.joined) continue;
      p.send({ t: 'snapshot', entities: states.filter((e) => e.id !== p.id) });
    }
  }

  /** Sends nearby chunks (nearest first) and tells the client to drop far ones. */
  private stream(p: PlayerSession): void {
    // A slow connection still has data queued: don't pile more chunks on top.
    if ((p.transport.backlog ?? 0) > 512 * 1024) return;
    const pcx = Math.floor(p.pos[0] / 16);
    const pcz = Math.floor(p.pos[2] / 16);
    let sent = 0;
    let saturated = false;
    const radius = this.radiusOf(p);
    for (const [dx, dz] of this.offsets(radius)) {
      const cx = pcx + dx;
      const cz = pcz + dz;
      const key = chunkKey(cx, cz);
      if (p.sent.has(key)) continue;
      const c = this.world.getChunk(cx, cz);
      if (c) {
        if (sent < MAX_CHUNKS_PER_TICK) {
          p.send({ t: 'chunk', cx, cz, data: this.world.encodedBytes(c) });
          p.sent.set(key, [cx, cz]);
          for (const e of this.items.inChunk(cx, cz)) p.send({ t: 'entitySpawn', entity: ItemEntities.info(e) });
          for (const info of this.mobs.inChunk(cx, cz)) p.send({ t: 'entitySpawn', entity: info });
          sent++;
        }
      } else if (!saturated && !this.world.request(cx, cz)) {
        saturated = true;
      }
      if (saturated && sent >= MAX_CHUNKS_PER_TICK) break;
    }

    const limit = (radius + 1) * (radius + 1);
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
    const centers = [...this.players.values()].map((p) => [Math.floor(p.pos[0] / 16), Math.floor(p.pos[2] / 16), (this.radiusOf(p) + 2) ** 2]);
    const keep = (cx: number, cz: number) => centers.some(([px, pz, r2]) => (cx - px) ** 2 + (cz - pz) ** 2 <= r2);
    const unsaved = this.world.unloadWhere(keep);
    // Creatures and items on unloaded ground vanish (they are not saved).
    this.mobs.removeWhere((x, z) => !keep(Math.floor(x) >> 4, Math.floor(z) >> 4));
    for (const e of [...this.items.all.values()]) {
      if (!keep(Math.floor(e.x) >> 4, Math.floor(e.z) >> 4)) {
        this.items.all.delete(e.id);
        this.broadcast({ t: 'entityDespawn', id: e.id });
      }
    }
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
    for (const p of this.players.values()) if (p.joined) this.meta.players[p.name] = p.save();
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
    return ((this.time % DAY_LENGTH_TICKS) + DAY_LENGTH_TICKS) % DAY_LENGTH_TICKS;
  }

  get playerCount(): number {
    return this.players.size;
  }

  /** For tests and debugging. */
  blockEntityAt(x: number, y: number, z: number): BlockEntity | undefined {
    return this.world.getBlockEntity(x, y, z);
  }
}
