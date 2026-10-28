import { GameMode } from '../shared/constants';
import { Inventory } from '../shared/items/Inventory';
import { ContainerWindow, emptySlots, type WindowKind } from '../shared/items/Window';
import type { ItemStack } from '../shared/items/registry';
import type { ClientMsg, ServerMsg, Vec3 } from '../shared/protocol/messages';
import type { Transport } from '../net/Transport';
import type { PlayerSave } from './storage/WorldStorage';

export const MAX_HEALTH = 20;
export const MAX_FOOD = 20;
export const MAX_AIR = 300;

export interface OpenWindow {
  id: number;
  kind: WindowKind;
  win: ContainerWindow;
  /** Block position for workbench / furnace / chest windows. */
  pos?: Vec3;
}

/** One connected player, as the host sees them. */
export class PlayerSession {
  name = '';
  joined = false;
  pos: Vec3 = [0, 0, 0];
  yaw = 0;
  pitch = 0;
  flying = false;
  gameMode: number = GameMode.SURVIVAL;
  readonly inventory = new Inventory();
  /** The player's own 2×2 crafting grid + output. */
  readonly craftSlots = emptySlots('inventory');
  readonly invWindow: ContainerWindow;
  /** A container window that is open (workbench, furnace, chest), if any. */
  window: OpenWindow | null = null;
  private nextWindowId = 1;
  dig: { x: number; y: number; z: number; start: number } | null = null;
  eating: { slot: number; start: number } | null = null;

  health = MAX_HEALTH;
  food = MAX_FOOD;
  saturation = 5;
  exhaustion = 0;
  air = MAX_AIR;
  dead = false;
  spawnPoint: Vec3 | null = null;
  /** When the player last lay down in a bedroll (ms), for skipping the night. */
  sleptAt = 0;
  onGround = true;
  fallStartY = 0;
  sneaking = false;
  /** Anti-cheat movement bookkeeping. */
  lastMoveAt = 0;
  /** After a teleport, moves are ignored until the client reports a position near here. */
  teleportTarget: Vec3 | null = null;
  teleportAt = 0;
  violations = 0;
  /** Swing animation shown to others until this time (ms). */
  swingUntil = 0;
  /** Times of recent chat messages (rate limit). */
  chatTimes: number[] = [];
  /** Last message received from this client (ms). */
  lastSeen = performance.now();
  pendingPing: { id: number; at: number } | null = null;
  rtt = -1;
  regenTimer = 0;
  starveTimer = 0;
  drownTimer = 0;
  private lastStats = '';

  /** Chunks this client currently holds. */
  readonly sent = new Map<string, [number, number]>();

  constructor(readonly id: number, readonly transport: Transport<ServerMsg, ClientMsg>, readonly isHost: boolean) {
    this.invWindow = new ContainerWindow('inventory', this.inventory, this.craftSlots);
  }

  send(msg: ServerMsg): void {
    this.transport.send(msg);
  }

  get creative(): boolean {
    return this.gameMode === GameMode.CREATIVE;
  }

  get alive(): boolean {
    return this.joined && !this.dead;
  }

  openWindow(kind: WindowKind, slots: ItemStack[] | (ItemStack | null)[], pos?: Vec3): OpenWindow {
    this.window = { id: this.nextWindowId++, kind, win: new ContainerWindow(kind, this.inventory, slots), pos };
    return this.window;
  }

  /** Picks up an item from the ground. Returns how many did not fit. */
  collect(item: ItemStack): number {
    const left = this.inventory.addStack(item);
    if (left !== item.count) this.sendInventory();
    return left;
  }

  sendInventory(): void {
    this.send({ t: 'inventory', state: this.inventory.snapshot() });
  }

  /** Sends health/food/air if they changed. */
  sendStats(force = false): void {
    const key = `${this.health}|${this.food}|${Math.ceil(this.air / 30)}`;
    if (!force && key === this.lastStats) return;
    this.lastStats = key;
    this.send({ t: 'stats', health: this.health, food: this.food, air: this.air });
  }

  addExhaustion(n: number): void {
    if (this.creative) return;
    this.exhaustion += n;
    while (this.exhaustion >= 4) {
      this.exhaustion -= 4;
      if (this.saturation > 0) this.saturation = Math.max(0, this.saturation - 1);
      else this.food = Math.max(0, this.food - 1);
    }
  }

  save(): PlayerSave {
    return {
      pos: [...this.pos],
      yaw: this.yaw,
      pitch: this.pitch,
      flying: this.flying,
      gameMode: this.gameMode,
      inventory: this.inventory.snapshot(),
      health: this.health,
      food: this.food,
      saturation: this.saturation,
      air: this.air,
      spawnPoint: this.spawnPoint ?? undefined,
    };
  }

  load(s: PlayerSave): void {
    this.pos = [...s.pos];
    this.yaw = s.yaw;
    this.pitch = s.pitch;
    this.flying = s.flying;
    this.gameMode = s.gameMode;
    this.inventory.load(s.inventory);
    this.health = s.health ?? MAX_HEALTH;
    this.food = s.food ?? MAX_FOOD;
    this.saturation = s.saturation ?? 5;
    this.air = s.air ?? MAX_AIR;
    this.spawnPoint = s.spawnPoint ?? null;
    if (this.health <= 0) this.health = MAX_HEALTH;
  }
}
