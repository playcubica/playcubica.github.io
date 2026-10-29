import * as THREE from 'three';
import { Renderer } from './render/Renderer';
import { blockDef } from '../shared/blocks/registry';
import { DAY_LENGTH_TICKS, GameMode, PROTOCOL_VERSION, TICKS_PER_SECOND } from '../shared/constants';
import { HOTBAR_SIZE, InvAction, Inventory } from '../shared/items/Inventory';
import { ContainerWindow, emptySlots } from '../shared/items/Window';
import type { ClientMsg, ServerMsg } from '../shared/protocol/messages';
import { MoveFlag } from '../shared/protocol/messages';
import { BIOME_NAMES } from '../shared/world/biomes';
import { decodeChunk } from '../shared/world/chunkCodec';
import type { Transport } from '../net/Transport';
import { ClientWorld } from './ClientWorld';
import { ChunkMeshManager } from './render/ChunkMeshManager';
import { createChunkMaterials, createChunkUniforms, type ChunkUniforms } from './render/chunkMaterial';
import { Sky } from './render/sky';
import { buildBlockTextures } from './textures/atlas';
import { Controls, KEYS, MouseButton } from './input/Controls';
import { gamepad, Pad, type PadFrame } from './input/Gamepad';
import { DebugOverlay } from './ui/debugOverlay';
import { LocalPlayer } from './player/LocalPlayer';
import { BlockInteraction, type InteractionHost } from './interaction/BlockInteraction';
import { Hud } from './ui/Hud';
import { WindowScreen, type OpenWindowState, type WindowHost } from './ui/WindowScreen';
import { setIconAtlas } from './ui/icons';
import { EntityRenderer } from './render/EntityRenderer';
import { PlayerModels } from './render/PlayerModels';
import { MobRenderer } from './render/MobRenderer';
import { AudioEngine, materialOf, type SoundName } from './audio/AudioEngine';
import { Mob } from '../shared/entities/mobs';
import { loadSettings, saveSettings, type Settings } from './settings';
import { TradeScreen } from './ui/TradeScreen';
import { isDeep } from '../shared/world/dimensions';
import { B } from '../shared/blocks/registry';
import { ChatInput, PlayerListView } from './ui/Social';
import type { PlayerListEntry } from '../shared/protocol/messages';

export interface ClientOptions {
  name: string;
  settings?: Settings;
  fov?: number;
  /** Connected to another machine's host (enables the connection watchdog). */
  remote?: boolean;
  /** Firebase ID token proving a signed-in player's account to a remote host. */
  token?: string | null;
}

export type ClientStatus =
  | { kind: 'connecting' }
  | { kind: 'playing' }
  | { kind: 'paused' }
  | { kind: 'dead'; message: string }
  | { kind: 'disconnected'; reason: string; succession?: Succession };

/** What the host last said about who carries the world on, plus this client's own player id. */
export interface Succession {
  worldId: string;
  code: string;
  order: Array<{ id: number; name: string }>;
  me: number;
}

type UiState = 'loading' | 'playing' | 'paused' | 'window' | 'chat' | 'resuming' | 'dead' | 'disconnected';

/** A remote host that stays silent this long is considered gone. */
const HOST_TIMEOUT_MS = 20_000;
/** Each animal's own voice. */
const VOICES: Partial<Record<number, SoundName>> = {
  [Mob.COW]: 'moo', [Mob.SHEEP]: 'baa', [Mob.PIG]: 'oink', [Mob.CHICKEN]: 'cluck', [Mob.HORSE]: 'neigh',
  [Mob.WOLF]: 'bark', [Mob.CAT]: 'meow', [Mob.RABBIT]: 'squeak', [Mob.FOX]: 'yip', [Mob.GOAT]: 'bleat',
  [Mob.DUSKWING]: 'screech', [Mob.MIREFIN]: 'gurgle', [Mob.SKITTERLING]: 'chitter', [Mob.EMBER_MITE]: 'chitter',
  [Mob.SHADE]: 'whisper', [Mob.BRAMBLEHULK]: 'roar', [Mob.MATRIARCH]: 'roar', [Mob.CRAGBACK]: 'growl',
};

/** Max milliseconds per frame spent decoding and lighting incoming chunks. */
const CHUNK_BUDGET_MS = 4;
const UNDERWATER_FOG = new THREE.Color(0.06, 0.2, 0.42);

/** Renders the world the host streams to it, runs the local player, and sends input back. */
export class GameClient implements InteractionHost, WindowHost {
  readonly renderer: Renderer;
  readonly world = new ClientWorld();
  readonly controls: Controls;
  readonly inventory = new Inventory();
  onStatus: ((s: ClientStatus) => void) | null = null;

  private readonly uniforms: ChunkUniforms;
  private readonly meshes: ChunkMeshManager;
  private readonly sky = new Sky();
  private readonly debug: DebugOverlay;
  private readonly hud: Hud;
  private readonly windowScreen: WindowScreen;
  private readonly entities: EntityRenderer;
  private readonly others: PlayerModels;
  private readonly mobs: MobRenderer;
  private readonly chatInput: ChatInput;
  private readonly playerList: PlayerListView;
  private playerId = 0;
  private succession: Succession | null = null;
  private playerEntries: PlayerListEntry[] = [];
  private lastHostMessage = performance.now();
  /** The player's own window (2×2 crafting) and an open container, if any. */
  private readonly ownWindow: OpenWindowState = { id: 0, kind: 'inventory', slots: emptySlots('inventory') };
  private container: OpenWindowState | null = null;
  private health = 20;
  private food = 20;
  private air = 300;
  private shake = 0;
  private readonly player: LocalPlayer;
  private readonly interaction: BlockInteraction;
  /**
   * Chunk data, block changes and unloads, applied strictly in arrival order (a block
   * change must not be applied before the chunk it belongs to has been decoded).
   */
  private readonly worldQueue: Array<Extract<ServerMsg, { t: 'chunk' | 'blockChange' | 'unloadChunk' }>> = [];
  private state: UiState = 'loading';
  private gameMode: number = GameMode.SURVIVAL;
  private isHost = false;
  private seed = 0;
  private viewDistance = 8;
  private serverTime = 0;
  private serverTimeAt = 0;
  private moveSeq = 0;
  private lastMoveSent = 0;
  private lastFrame = 0;
  private frames = 0;
  private fps = 0;
  private fpsAt = 0;
  private frameMs = 0;
  private debugAt = 0;
  private eyeOffset = 1.62;
  private baseFov: number;
  readonly audio = new AudioEngine();
  private settings: Settings;
  private readonly tradeScreen: TradeScreen;
  /** Positions this client changed itself recently (their sounds already played), by "x,y,z" → time. */
  private readonly predicted = new Map<string, number>();
  private stepDistance = 0;
  private wasEating = false;
  private inRift = false;
  private nextIdleSound = 0;
  private rafId = 0;
  private disposed = false;
  private readonly dir = new THREE.Vector3();
  /** Controller: sprint stays on (L3) until the stick is let go. */
  private padSprint = false;
  /** Whether the previous controller frame was in play (a press that just left a menu is not reused). */
  private padWasPlaying = false;
  private padName: string | null = null;
  /** Controller pointer for inventory windows (a virtual mouse). */
  private readonly padPointer: HTMLDivElement;
  private padPos = { x: 0, y: 0 };
  private readonly unlistenPad: () => void;

  constructor(container: HTMLElement, private readonly transport: Transport<ClientMsg, ServerMsg>, private readonly options: ClientOptions) {
    this.settings = options.settings ?? loadSettings();
    this.baseFov = options.fov ?? this.settings.fov;
    this.renderer = new Renderer(container, this.baseFov);
    const textures = buildBlockTextures();
    setIconAtlas(textures.atlas);
    this.uniforms = createChunkUniforms(textures.array);
    this.meshes = new ChunkMeshManager(this.world, this.renderer.scene, createChunkMaterials(this.uniforms));
    this.renderer.scene.add(this.sky.group);
    this.controls = new Controls(this.renderer.canvas);
    this.player = new LocalPlayer(this.world, this.controls);
    this.player.onDismount = () => this.send({ t: 'dismount' });
    this.interaction = new BlockInteraction(this.renderer.scene, this, this.controls);
    this.hud = new Hud(container);
    this.windowScreen = new WindowScreen(container, this);
    this.tradeScreen = new TradeScreen(container, this.inventory);
    this.tradeScreen.onTrade = (entityId, offer) => {
      this.send({ t: 'trade', entityId, offer });
      this.audio.play('click');
    };
    this.entities = new EntityRenderer(this.renderer.scene, this.world);
    this.others = new PlayerModels(this.renderer.scene, this.world);
    this.mobs = new MobRenderer(this.renderer.scene, this.world);
    this.chatInput = new ChatInput(container);
    this.chatInput.onSend = (text) => this.send({ t: 'chat', text });
    this.chatInput.onClose = () => {
      if (this.state !== 'chat') return;
      this.state = 'resuming';
      this.controls.lock();
    };
    this.playerList = new PlayerListView(container);
    this.debug = new DebugOverlay(container, this.settings.showDebug);

    this.controls.onKeyPress = (code) => this.keyPressed(code);
    this.controls.onKeyRelease = (code) => {
      if (code === KEYS.playerList) this.playerList.show(false);
    };
    this.controls.onWheel = (steps) => this.selectSlot((this.inventory.selected + steps + HOTBAR_SIZE) % HOTBAR_SIZE);
    this.controls.onLockChange = (locked) => this.lockChanged(locked);
    this.padPointer = document.createElement('div');
    this.padPointer.className = 'pad-pointer';
    this.padPointer.style.display = 'none';
    container.appendChild(this.padPointer);
    this.unlistenPad = gamepad.listen((f) => this.padFrame(f));


    transport.onMessage = (msg) => {
      this.lastHostMessage = performance.now();
      this.receive(msg);
    };
    transport.onClose = (reason) => this.disconnect(reason);
  }

  // --- Host interfaces (interaction, inventory screen) -----------------------

  get creative(): boolean {
    return this.gameMode === GameMode.CREATIVE;
  }

  get hosting(): boolean {
    return this.isHost;
  }

  get hungry(): boolean {
    return this.food < 20;
  }

  get currentWindow(): OpenWindowState {
    return this.container ?? this.ownWindow;
  }

  send(msg: ClientMsg): void {
    this.transport.send(msg);
  }

  predictBlock(x: number, y: number, z: number, id: number): void {
    this.predicted.set(`${x},${y},${z}`, performance.now());
    this.blockSound(x, y, z, this.world.getRaw(x, y, z), id);
    this.applyBlock(x, y, z, id);
  }

  /** Break / place / door / lever sounds for a block change. */
  private blockSound(x: number, y: number, z: number, oldRaw: number, raw: number): void {
    const oldId = oldRaw & 0xfff;
    const id = raw & 0xfff;
    if (oldId === id) {
      if (id === B.ASHWOOD_DOOR) this.audio.play('door', { x, y, z });
      else if (id === B.LEVER) this.audio.play('click', { x, y, z });
      return;
    }
    if (id === B.GLOWWIRE || oldId === B.GLOWWIRE || id === B.LAMP_ON || oldId === B.LAMP_ON || id === B.PUSHER_HEAD || oldId === B.PUSHER_HEAD) return;
    if (id === B.AIR && oldId !== B.AIR) this.audio.play('break', { x, y, z }, materialOf(oldId));
    else if (id !== B.AIR) this.audio.play('place', { x, y, z }, materialOf(id));
  }

  /** Applies new settings (from the settings screen). */
  applySettings(s: Settings): void {
    this.settings = s;
    this.baseFov = s.fov;
    this.controls.sensitivity = 0.0022 * s.sensitivity;
    this.audio.setVolumes(s.sound, s.music);
    this.debug.show(s.showDebug);
    if (s.viewDistance !== this.viewDistance) {
      this.viewDistance = s.viewDistance;
      this.send({ t: 'settings', viewDistance: s.viewDistance });
    }
  }

  pickEntity(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): { id: number; distance: number } | null {
    return this.mobs.pick(origin, dir, maxDist);
  }

  playerBox(): { min: number[]; max: number[] } {
    return this.player.body.box();
  }

  pickBlock(id: number): void {
    const inv = this.inventory;
    const existing = inv.slots.findIndex((s, i) => i < HOTBAR_SIZE && s?.id === id);
    if (existing >= 0) this.selectSlot(existing);
    else {
      this.inventory.applyCreative(InvAction.CREATIVE_SLOT, inv.selected, 0, id);
      this.send({ t: 'inv', window: 0, action: InvAction.CREATIVE_SLOT, slot: inv.selected, button: 0, item: id });
    }
  }

  windowAction(action: number, slot: number, button: number, item?: number): void {
    // Predict locally with the same code the host runs; the host's snapshots follow.
    const w = this.currentWindow;
    if (action === InvAction.CREATIVE_CURSOR || action === InvAction.CREATIVE_SLOT) {
      if (this.creative) this.inventory.applyCreative(action, slot, button, item);
    } else {
      new ContainerWindow(w.kind, this.inventory, w.slots).apply(action, slot, button);
    }
    this.send({ t: 'inv', window: w.id, action, slot, button, item });
    this.windowScreen.render();
  }

  // --- Lifecycle / UI state ---------------------------------------------------

  start(): void {
    this.onStatus?.({ kind: 'connecting' });
    this.send({ t: 'hello', v: PROTOCOL_VERSION, name: this.options.name, ...(this.options.token ? { token: this.options.token } : {}) });
    this.send({ t: 'settings', viewDistance: this.settings.viewDistance });
    this.controls.sensitivity = 0.0022 * this.settings.sensitivity;
    this.audio.setVolumes(this.settings.sound, this.settings.music);
    const loop = (now: number) => {
      if (this.disposed) return;
      this.frame(now);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  /** Called from a click (user gesture) to enter the game. */
  resume(): void {
    this.audio.unlock();
    if (this.state === 'disconnected' || this.state === 'loading' || this.state === 'dead') return;
    if (this.windowScreen.open || this.tradeScreen.open) this.closeWindow(false);
    this.setState('resuming');
    this.controls.lock();
  }

  /** Called from the death screen's button (a user gesture, so the pointer can lock again). */
  respawn(): void {
    if (this.state !== 'dead') return;
    this.send({ t: 'respawn' });
    this.state = 'resuming';
    this.controls.lock();
  }

  setGameMode(mode: number): void {
    if (this.isHost) this.send({ t: 'setGameMode', mode });
  }

  private setState(s: UiState): void {
    if (this.state === s) return;
    this.state = s;
    if (s === 'playing') this.onStatus?.({ kind: 'playing' });
    else if (s === 'paused') this.onStatus?.({ kind: 'paused' });
  }

  private freeMouseHinted = false;

  private lockChanged(locked: boolean): void {
    if (locked && this.controls.freeMouse && !this.freeMouseHinted && !gamepad.active) {
      this.freeMouseHinted = true;
      this.hud.message('הדפדפן לא מאפשר לתפוס את העכבר — משחקים במצב עכבר חופשי: הזיזו את העכבר (או החיצים) כדי להסתכל, Esc להשהיה.', true);
    }
    if (locked) {
      if (this.state !== 'disconnected' && this.state !== 'loading' && this.state !== 'dead') this.setState('playing');
    } else if (this.state === 'playing' || (this.state === 'resuming' && !this.chatInput.open)) {
      this.setState('paused');
    }
  }

  private voice(id: number): SoundName {
    const kind = this.mobs.kindOf(id);
    return (kind !== null && VOICES[kind]) || (this.mobs.isHostile(id) ? 'growl' : 'grunt');
  }

  private keyPressed(code: string): void {
    if (code === KEYS.debug) {
      this.settings = { ...this.settings, showDebug: !this.settings.showDebug };
      saveSettings(this.settings);
      this.debug.show(this.settings.showDebug);
    }
    if (code === KEYS.playerList && this.state !== 'chat') {
      this.playerList.set(this.playerEntries, this.playerId);
      this.playerList.show(true);
    }
    if (this.state === 'chat') return;
    if (this.state === 'window') {
      if (code === KEYS.inventory || code === 'Escape') this.closeWindow(code === KEYS.inventory);
      return;
    }
    if (this.state !== 'playing') return;
    if (code === KEYS.inventory) {
      this.openWindowScreen();
      return;
    }
    if (code === KEYS.chat || code === 'Slash') {
      this.state = 'chat';
      this.controls.unlock();
      this.chatInput.show(code === 'Slash' ? '/' : '');
      return;
    }
    if (code === 'KeyQ' && this.inventory.held) {
      const all = this.controls.isDown(KEYS.sprint);
      this.send({ t: 'drop', all });
      this.inventory.take(this.inventory.selected, all ? this.inventory.held.count : 1);
    }
    const digit = /^Digit([1-9])$/.exec(code);
    if (digit) this.selectSlot(Number(digit[1]) - 1);
    this.player.keyPressed(code);
  }

  // --- Game controller ---------------------------------------------------------

  /** Maps a controller frame onto the same actions as keyboard and mouse. */
  private padFrame(f: PadFrame): void {
    if (this.padName !== gamepad.connectedName) {
      this.padName = gamepad.connectedName;
      if (this.padName) this.hud.message(`🎮 שלט מחובר: ${this.padName}`);
    }
    const c = this.controls;
    if (this.state === 'window') {
      c.clearPad();
      this.padWasPlaying = false;
      this.padWindow(f);
      return;
    }
    this.padPointer.style.display = 'none';
    const wasPlaying = this.padWasPlaying;
    this.padWasPlaying = this.state === 'playing';
    if (this.state !== 'playing' || !wasPlaying) {
      c.clearPad();
      return;
    }
    const [lx, ly] = f.left;
    c.padMove = { forward: -ly, strafe: lx };
    if (f.pressed(Pad.L3)) this.padSprint = !this.padSprint;
    if (Math.hypot(lx, ly) < 0.2) this.padSprint = false;
    c.padKey(KEYS.sprint, this.padSprint);
    c.padKey(KEYS.jump, f.held(Pad.A));
    c.padKey(KEYS.sneak, f.held(Pad.B));
    c.padKey(KEYS.playerList, f.held(Pad.BACK));
    c.padButton(MouseButton.LEFT, f.held(Pad.RT));
    c.padButton(MouseButton.RIGHT, f.held(Pad.LT));
    c.padButton(MouseButton.MIDDLE, f.held(Pad.UP));
    // Quadratic response: small tilts aim finely, full tilt turns fast.
    const [rx, ry] = f.right;
    const speed = 3.2 * this.settings.sensitivity * f.dt;
    c.padLook(-Math.sign(rx) * rx * rx * speed, -Math.sign(ry) * ry * ry * speed * 0.75);
    if (f.pressed(Pad.LB) || f.pressed(Pad.LEFT)) c.onWheel?.(-1);
    if (f.pressed(Pad.RB) || f.pressed(Pad.RIGHT)) c.onWheel?.(1);
    if (f.pressed(Pad.X)) this.keyPressed('KeyQ');
    if (f.pressed(Pad.Y)) this.keyPressed(KEYS.inventory);
    if (f.pressed(Pad.START)) c.unlock();
  }

  /** Inventory/trade windows: the left stick moves a pointer that clicks like a mouse. */
  private padWindow(f: PadFrame): void {
    const p = this.padPointer;
    if (p.style.display === 'none') {
      this.padPos = { x: innerWidth / 2, y: innerHeight / 2 };
      p.style.display = '';
    }
    const [lx, ly] = f.left;
    const speed = 1100 * f.dt;
    const moved = lx !== 0 || ly !== 0 || f.nav.x !== 0 || f.nav.y !== 0;
    this.padPos.x = Math.max(0, Math.min(innerWidth - 1, this.padPos.x + Math.sign(lx) * lx * lx * speed));
    this.padPos.y = Math.max(0, Math.min(innerHeight - 1, this.padPos.y + Math.sign(ly) * ly * ly * speed));
    // The D-pad steps one slot (44 px + gap) at a time for precise placing.
    if (!lx && !ly) {
      this.padPos.x = Math.max(0, Math.min(innerWidth - 1, this.padPos.x + f.nav.x * 46));
      this.padPos.y = Math.max(0, Math.min(innerHeight - 1, this.padPos.y + f.nav.y * 46));
    }
    const { x, y } = this.padPos;
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
    const target = document.elementFromPoint(x, y);
    const fire = (type: string, button = 0, shiftKey = false) =>
      target?.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button, shiftKey }));
    if (moved) fire('mousemove');
    const click = (button: number, shift = false) => {
      fire('mousedown', button, shift);
      fire('mouseup', button, shift);
      if (button === 0) fire('click', 0, shift);
      fire('mousemove'); // refresh the held stack and tooltip
    };
    if (f.pressed(Pad.A)) click(0);
    else if (f.pressed(Pad.X)) click(2);
    else if (f.pressed(Pad.RB) || f.pressed(Pad.LB)) click(0, true);
    else if (f.pressed(Pad.Y) || f.pressed(Pad.B) || f.pressed(Pad.START)) this.keyPressed(KEYS.inventory);
  }

  private openWindowScreen(): void {
    this.state = 'window';
    this.controls.unlock();
    this.windowScreen.show();
  }

  private closeWindow(relock: boolean): void {
    if (this.tradeScreen.open) {
      this.tradeScreen.hide();
      if (relock) {
        this.state = 'resuming';
        this.controls.lock();
      } else this.setState('paused');
      return;
    }
    const w = this.currentWindow;
    this.send({ t: 'closeWindow', window: w.id });
    // Predict: crafting leftovers and the cursor stack return to the inventory.
    if (w.kind === 'inventory' || w.kind === 'workbench') new ContainerWindow(w.kind, this.inventory, w.slots).returnGrid();
    if (this.inventory.cursor) {
      this.inventory.addStack(this.inventory.cursor);
      this.inventory.cursor = null;
    }
    this.container = null;
    this.windowScreen.hide();
    if (relock) {
      this.state = 'resuming';
      this.controls.lock();
    } else {
      this.setState('paused');
    }
  }

  private selectSlot(i: number): void {
    if (i === this.inventory.selected || this.state === 'window') return;
    this.inventory.selected = i;
    this.send({ t: 'held', slot: i });
  }

  private disconnect(reason: string): void {
    if (this.state === 'disconnected') return;
    this.state = 'disconnected';
    this.controls.unlock();
    this.onStatus?.({ kind: 'disconnected', reason, succession: this.succession ?? undefined });
  }

  dispose(): void {
    this.audio.dispose();
    this.tradeScreen.dispose();
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.controls.dispose();
    this.unlistenPad();
    this.padPointer.remove();
    this.interaction.dispose();
    this.meshes.dispose();
    this.hud.dispose();
    this.windowScreen.dispose();
    this.entities.dispose();
    this.others.dispose();
    this.mobs.dispose();
    this.chatInput.dispose();
    this.playerList.dispose();
    this.debug.el.remove();
    this.renderer.dispose();
  }

  // --- Network ----------------------------------------------------------------

  private receive(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.playerId = msg.playerId;
        for (const pl of msg.players) if (pl.id !== msg.playerId) this.others.add(pl.id, pl.name);
        this.seed = msg.seed;
        this.viewDistance = this.settings.viewDistance;
        this.isHost = msg.isHost;
        this.setServerTime(msg.time);
        this.gameMode = msg.gameMode;
        this.player.canFly = this.creative;
        this.player.teleport(msg.spawn[0], msg.spawn[1], msg.spawn[2]);
        this.player.body.flying = msg.flying && this.creative;
        this.controls.yaw = msg.yaw;
        this.controls.pitch = msg.pitch;
        this.uniforms.uFogFar.value = this.viewDistance * 16;
        this.uniforms.uFogNear.value = this.viewDistance * 16 * 0.55;
        this.state = 'paused';
        this.onStatus?.({ kind: 'paused' });
        break;
      case 'chunk':
      case 'unloadChunk':
        this.worldQueue.push(msg);
        break;
      case 'blockChange': {
        // Changes this client made itself already made their sound.
        const k = `${msg.x},${msg.y},${msg.z}`;
        const mine = performance.now() - (this.predicted.get(k) ?? -1e9) < 1500;
        if (!mine) this.blockSound(msg.x, msg.y, msg.z, this.world.getRaw(msg.x, msg.y, msg.z), msg.id);
        if (this.worldQueue.length === 0) this.applyBlock(msg.x, msg.y, msg.z, msg.id);
        else this.worldQueue.push(msg);
        break;
      }
      case 'inventory':
        this.inventory.load(msg.state);
        this.windowScreen.render();
        break;
      case 'window':
        if (msg.id === 0) {
          this.ownWindow.slots.splice(0, this.ownWindow.slots.length, ...msg.slots);
        } else {
          const fresh = !this.container || this.container.id !== msg.id;
          this.container = { id: msg.id, kind: msg.kind, slots: msg.slots, progress: msg.progress };
          if (fresh && this.state !== 'dead') {
            if (this.state === 'window') this.windowScreen.hide();
            this.openWindowScreen();
          }
        }
        this.windowScreen.render();
        break;
      case 'closeWindow':
        if (this.container?.id === msg.id) {
          this.container = null;
          this.windowScreen.hide();
          if (this.state === 'window') this.setState('paused');
        }
        break;
      case 'gameMode':
        this.gameMode = msg.mode;
        this.player.canFly = this.creative;
        this.windowScreen.render();
        break;
      case 'stats':
        this.health = msg.health;
        this.food = msg.food;
        this.air = msg.air;
        break;
      case 'hurt':
        this.hud.flashHurt();
        this.shake = 0.3;
        this.audio.play('hurt');
        break;
      case 'trades':
        if (this.state === 'window') this.closeWindow(false);
        this.tradeScreen.show(msg.entityId, msg.profession, msg.offers);
        this.state = 'window';
        this.controls.unlock();
        break;
      case 'death':
        this.audio.play('death');
        this.tradeScreen.hide();
        this.container = null;
        this.windowScreen.hide();
        this.state = 'dead';
        this.controls.unlock();
        this.onStatus?.({ kind: 'dead', message: msg.message });
        break;
      case 'teleport':
        this.player.teleport(msg.x, msg.y, msg.z);
        break;
      case 'entitySpawn':
        if (msg.entity.kind === 'item') this.entities.spawn(msg.entity);
        else if (msg.entity.kind === 'block') this.entities.spawnBlock(msg.entity);
        else this.mobs.spawn(msg.entity);
        if (msg.entity.kind === 'projectile') this.audio.play('thorn', msg.entity);
        break;
      case 'entityDespawn':
        if (msg.pickedBy === this.playerId) this.audio.play('pickup');
        this.entities.remove(msg.id);
        this.mobs.remove(msg.id);
        break;
      case 'mobMove':
        this.mobs.move(msg.data);
        break;
      case 'entityEvent': {
        this.mobs.event(msg.id, msg.event);
        const at = this.mobs.position(msg.id);
        if (at) {
          const e = msg.event;
          if (e === 'spores') this.audio.play('spores', at);
          else if (e === 'love' || e === 'tamed' || e === 'baby') this.audio.play('pop', at);
          else if (e === 'smoke') this.audio.play('snort', at);
          else if (e === 'shear') this.audio.play('shear', at);
          else if (e === 'clang') this.audio.play('clang', at);
          else if (e === 'crit') this.audio.play('crit', at);
          else if (e === 'blink') this.audio.play('whisper', at);
          else if (e === 'slam' || e === 'stun') this.audio.play('boom', at, 'stone', 1);
          else if (e === 'roar') this.audio.play('roar', at, 'stone', 1);
          else this.audio.play(this.voice(msg.id), at, 'stone', e === 'death' ? 1 : 0.7);
        }
        break;
      }
      case 'mobState':
        this.mobs.state(msg.entity);
        break;
      case 'bossBar':
        this.hud.setBossBar(msg.id === null ? null : msg.name ?? '', msg.health, msg.max);
        break;
      case 'ride':
        if (msg.entityId === null) {
          this.player.unmount();
          this.mobs.setRidden(null);
        } else {
          const b = this.player.body;
          const before = this.player.riding;
          this.player.mount({
            id: msg.entityId, speed: msg.speed ?? 4, jump: msg.jump ?? 8.4, steer: !!msg.steer, width: msg.width ?? 1, height: msg.height ?? 2,
          });
          this.mobs.setRidden(msg.entityId, () => ({ x: b.x, y: b.y, z: b.z, yaw: this.controls.yaw }));
          if (before?.id !== msg.entityId || before.steer !== !!msg.steer) {
            this.hud.message(msg.steer ? 'Shift — לרדת' : before?.id === msg.entityId ? 'הסוס התרגל אליך! צריך אוכף כדי לרכוב עליו' : 'הסוס עוד לא מאולף… (Shift — לרדת)', true);
          }
        }
        break;
      case 'knockback':
        this.player.body.push(msg.vx, msg.vy, msg.vz);
        break;
      case 'entityMove':
        this.entities.move(msg.data);
        break;
      case 'chat':
        this.hud.message(msg.from ? `${msg.from}: ${msg.text}` : msg.text, !msg.from);
        break;
      case 'playerJoin':
        if (msg.player.id !== this.playerId) this.others.add(msg.player.id, msg.player.name);
        break;
      case 'playerLeave':
        this.others.remove(msg.id);
        break;
      case 'playerList':
        this.playerEntries = msg.players;
        this.playerList.set(this.playerEntries, this.playerId);
        break;
      case 'snapshot':
        this.others.snapshot(msg.entities);
        break;
      case 'ping':
        this.send({ t: 'pong', id: msg.id });
        break;
      case 'time':
        this.setServerTime(msg.time);
        break;
      case 'kick':
        this.disconnect(msg.reason);
        break;
      case 'succession':
        this.succession = { worldId: msg.worldId, code: msg.code, order: msg.order, me: this.playerId };
        break;
      default:
        break;
    }
  }

  private applyBlock(x: number, y: number, z: number, id: number): void {
    for (const c of this.world.setBlock(x, y, z, id)) this.meshes.markAround(c.cx, c.cz);
  }

  private setServerTime(t: number): void {
    this.serverTime = t;
    this.serverTimeAt = performance.now();
  }

  private get time(): number {
    return this.serverTime + ((performance.now() - this.serverTimeAt) / 1000) * TICKS_PER_SECOND;
  }

  private processChunks(): void {
    const start = performance.now();
    while (this.worldQueue.length > 0) {
      const msg = this.worldQueue[0];
      if (msg.t === 'chunk' && performance.now() - start >= CHUNK_BUDGET_MS) break;
      this.worldQueue.shift();
      if (msg.t === 'blockChange') {
        this.applyBlock(msg.x, msg.y, msg.z, msg.id);
      } else if (msg.t === 'unloadChunk') {
        this.world.remove(msg.cx, msg.cz);
        this.meshes.remove(msg.cx, msg.cz);
        this.entities.removeInChunk(msg.cx, msg.cz);
        this.mobs.removeInChunk(msg.cx, msg.cz);
      } else {
        const touched = this.world.add(decodeChunk(msg.data));
        for (const c of touched) this.meshes.markAround(c.cx, c.cz);
      }
    }
  }

  // --- Frame ------------------------------------------------------------------

  private frame(now: number): void {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000 || 0);
    this.lastFrame = now;
    const t0 = performance.now();
    const body = this.player.body;

    this.processChunks();
    this.controls.turn(dt);
    this.player.canSprint = this.creative || this.food > 6;
    if (this.state !== 'loading' && this.state !== 'disconnected' && this.state !== 'dead') this.player.update(dt);

    // Camera: eye height eases when sneaking; FOV widens when sprinting.
    const cam = this.renderer.camera;
    this.eyeOffset += (body.eyeHeight - this.eyeOffset) * Math.min(1, dt * 14);
    cam.position.set(body.x, body.y + this.eyeOffset, body.z);
    this.shake = Math.max(0, this.shake - dt);
    cam.rotation.set(this.controls.pitch, this.controls.yaw, Math.sin(this.shake * 40) * this.shake * 0.15);
    const fov = this.baseFov * (body.sprinting || (body.flying && this.controls.isDown(KEYS.sprint)) ? 1.12 : 1);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov += (fov - cam.fov) * Math.min(1, dt * 10);
      cam.updateProjectionMatrix();
    }

    if (this.state === 'playing') {
      cam.getWorldDirection(this.dir);
      this.interaction.update(dt, cam.position, this.dir);
    }
    this.hud.setEating(this.interaction.eating);
    if (this.wasEating && this.interaction.eating === null) this.audio.play('eat');
    this.wasEating = (this.interaction.eating ?? 0) > 0.85;

    const sky = this.sky.update(this.time, cam);
    const ex = Math.floor(cam.position.x);
    const ey = Math.floor(cam.position.y);
    const ez = Math.floor(cam.position.z);
    const eyeBlock = this.world.getBlock(ex, ey, ez);
    const underwater = eyeBlock === B.WATER;
    const deep = isDeep(cam.position.x);
    this.uniforms.uSkyLight.value.copy(sky.skyLight);
    this.uniforms.uMinLight.value = deep ? 0.16 : 0.06;
    if (eyeBlock === B.MAGMA) {
      this.uniforms.uFogColor.value.setRGB(0.9, 0.35, 0.05);
      this.uniforms.uFogNear.value = 0;
      this.uniforms.uFogFar.value = 3;
    } else if (underwater) {
      this.uniforms.uFogColor.value.copy(UNDERWATER_FOG).multiplyScalar(0.3 + 0.7 * sky.daylight);
      this.uniforms.uFogNear.value = 0;
      this.uniforms.uFogFar.value = 22;
    } else if (deep) {
      this.uniforms.uFogColor.value.setRGB(0.2, 0.06, 0.04);
      this.uniforms.uFogFar.value = Math.min(this.viewDistance * 16, 96);
      this.uniforms.uFogNear.value = 8;
    } else {
      this.uniforms.uFogColor.value.copy(sky.horizon);
      this.uniforms.uFogFar.value = this.viewDistance * 16;
      this.uniforms.uFogNear.value = this.viewDistance * 16 * 0.55;
    }
    this.renderer.gl.setClearColor(this.uniforms.uFogColor.value);
    this.sky.group.visible = !underwater && !deep;
    this.audio.mood = deep ? 'deep' : sky.daylight < 0.3 ? 'night' : 'day';

    // Rift: purple haze and a shimmer while standing in one.
    const rift = this.world.getBlock(Math.floor(body.x), Math.floor(body.y + 0.2), Math.floor(body.z)) === B.RIFT;
    if (rift && !this.inRift) this.audio.play('rift');
    this.inRift = rift;
    this.hud.setRift(rift);

    // Footsteps.
    if (body.onGround && !body.flying && this.state === 'playing') {
      this.stepDistance += Math.hypot(body.vx, body.vz) * dt;
      if (this.stepDistance > 2.2) {
        this.stepDistance = 0;
        const under = this.world.getBlock(Math.floor(body.x), Math.floor(body.y - 0.1), Math.floor(body.z));
        if (under !== B.AIR) this.audio.play('step', undefined, materialOf(under), 0.6);
      }
    }
    // Now and then a nearby creature makes a sound.
    if (now > this.nextIdleSound) {
      this.nextIdleSound = now + 4000 + Math.random() * 8000;
      const near = this.mobs.randomNear(body.x, body.y, body.z, 16);
      if (near) this.audio.play(VOICES[near.kind] ?? (near.hostile ? 'growl' : 'grunt'), near, 'stone', 0.5);
    }
    this.audio.setListener(cam.position.x, cam.position.y, cam.position.z, this.controls.yaw);
    this.audio.tick();

    this.meshes.update(body.x, body.z);
    this.entities.update(dt, sky.daylight);
    this.others.update(dt, sky.daylight);
    this.mobs.update(dt, sky.daylight, cam.position);
    if (this.options.remote && this.state !== 'disconnected' && performance.now() - this.lastHostMessage > HOST_TIMEOUT_MS) {
      this.transport.close('המארח לא מגיב');
      this.disconnect('המארח לא הגיב 20 שניות — ייתכן שהוא סגר את המשחק או שהחיבור נפל.');
    }
    this.hud.setStats(this.health, this.food, this.air, !this.creative);
    this.hud.update(this.inventory, underwater, dt);
    this.renderer.render();

    if (this.state !== 'loading' && this.state !== 'dead' && now - this.lastMoveSent >= 1000 / TICKS_PER_SECOND) {
      this.lastMoveSent = now;
      const flags = (body.onGround ? MoveFlag.ON_GROUND : 0) | (body.sneaking ? MoveFlag.SNEAK : 0) |
        (body.sprinting ? MoveFlag.SPRINT : 0) | (body.flying ? MoveFlag.FLYING : 0) | (body.bounced ? MoveFlag.BOUNCED : 0);
      body.bounced = false;
      this.send({
        t: 'move', seq: this.moveSeq++, x: body.x, y: body.y, z: body.z,
        yaw: this.controls.yaw, pitch: this.controls.pitch, flags,
      });
    }

    this.frameMs = this.frameMs * 0.9 + (performance.now() - t0) * 0.1;
    this.frames++;
    if (now - this.fpsAt >= 1000) {
      this.fps = Math.round((this.frames * 1000) / (now - this.fpsAt));
      this.frames = 0;
      this.fpsAt = now;
    }
    if (now - this.debugAt >= 250) {
      this.debugAt = now;
      this.updateDebug();
    }
  }

  private updateDebug(): void {
    const b = this.player.body;
    const bx = Math.floor(b.x);
    const by = Math.floor(b.y);
    const bz = Math.floor(b.z);
    const c = this.world.getChunk(bx >> 4, bz >> 4);
    const biome = c ? BIOME_NAMES[c.biomes[(bx & 15) | ((bz & 15) << 4)]] : '-';
    const light = this.world.getLight(bx, by, bz);
    const t = ((this.time % DAY_LENGTH_TICKS) + DAY_LENGTH_TICKS) % DAY_LENGTH_TICKS;
    const hours = (t / 1000 + 6) % 24;
    const clock = `${String(Math.floor(hours)).padStart(2, '0')}:${String(Math.floor((hours % 1) * 60)).padStart(2, '0')}`;
    const yawDeg = ((((-this.controls.yaw * 180) / Math.PI) % 360) + 360) % 360;
    const facing = ['north (-Z)', 'east (+X)', 'south (+Z)', 'west (-X)'][Math.round(yawDeg / 90) % 4];
    const info = this.renderer.gl.info.render;
    const tg = this.interaction.target;
    const state = [b.onGround && 'ground', b.inWater && 'water', b.flying && 'flying', b.sneaking && 'sneak', b.sprinting && 'sprint'].filter(Boolean).join(' ');
    this.debug.set([
      'Cubica 1.0',
      `${this.fps} fps  (cpu ${this.frameMs.toFixed(1)} ms)  draws ${info.calls}  tris ${Math.round(info.triangles / 1000)}k`,
      `XYZ ${b.x.toFixed(2)} / ${b.y.toFixed(2)} / ${b.z.toFixed(2)}  ${state}`,
      `Chunk ${bx >> 4} ${bz >> 4}  facing ${facing}`,
      `Biome ${biome}  light sky ${light >> 4} block ${light & 15}`,
      tg ? `Target ${blockDef(tg.id)?.name} @ ${tg.x} ${tg.y} ${tg.z}` : this.interaction.entityTarget !== null ? `Target creature #${this.interaction.entityTarget}` : 'Target -',
      `Mode ${this.creative ? 'creative' : 'survival'}  chunks ${this.world.chunks.size}  meshed ${this.meshes.meshedCount}  items ${this.entities.count}  players ${this.others.count + 1}  mobs ${this.mobs.count}`,
      `Seed ${this.seed}  day ${Math.floor(this.time / DAY_LENGTH_TICKS) + 1}  ${clock}`,
    ]);
  }
}
