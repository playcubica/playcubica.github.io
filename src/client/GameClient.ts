import * as THREE from 'three';
import { Renderer } from './render/Renderer';
import { blockDef } from '../shared/blocks/registry';
import { DAY_LENGTH_TICKS, GameMode, PROTOCOL_VERSION, TICKS_PER_SECOND } from '../shared/constants';
import { HOTBAR_SIZE, InvAction, Inventory } from '../shared/items/Inventory';
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
import { Controls, KEYS } from './input/Controls';
import { DebugOverlay } from './ui/debugOverlay';
import { LocalPlayer } from './player/LocalPlayer';
import { BlockInteraction, type InteractionHost } from './interaction/BlockInteraction';
import { Hud } from './ui/Hud';
import { InventoryScreen, type InventoryHost } from './ui/InventoryScreen';
import { setIconAtlas } from './ui/icons';

export interface ClientOptions {
  name: string;
  fov?: number;
}

export type ClientStatus =
  | { kind: 'connecting' }
  | { kind: 'playing' }
  | { kind: 'paused' }
  | { kind: 'disconnected'; reason: string };

type UiState = 'loading' | 'playing' | 'paused' | 'inventory' | 'resuming' | 'disconnected';

/** Max milliseconds per frame spent decoding and lighting incoming chunks. */
const CHUNK_BUDGET_MS = 4;
const UNDERWATER_FOG = new THREE.Color(0.06, 0.2, 0.42);

/** Renders the world the host streams to it, runs the local player, and sends input back. */
export class GameClient implements InteractionHost, InventoryHost {
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
  private readonly invScreen: InventoryScreen;
  private readonly player: LocalPlayer;
  private readonly interaction: BlockInteraction;
  private readonly chunkQueue: Array<Extract<ServerMsg, { t: 'chunk' }>> = [];
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
  private readonly baseFov: number;
  private rafId = 0;
  private disposed = false;
  private readonly dir = new THREE.Vector3();

  constructor(container: HTMLElement, private readonly transport: Transport<ClientMsg, ServerMsg>, private readonly options: ClientOptions) {
    this.baseFov = options.fov ?? 70;
    this.renderer = new Renderer(container, this.baseFov);
    const textures = buildBlockTextures();
    setIconAtlas(textures.atlas);
    this.uniforms = createChunkUniforms(textures.array);
    this.meshes = new ChunkMeshManager(this.world, this.renderer.scene, createChunkMaterials(this.uniforms));
    this.renderer.scene.add(this.sky.group);
    this.controls = new Controls(this.renderer.canvas);
    this.player = new LocalPlayer(this.world, this.controls);
    this.interaction = new BlockInteraction(this.renderer.scene, this, this.controls);
    this.hud = new Hud(container);
    this.invScreen = new InventoryScreen(container, this);
    this.debug = new DebugOverlay(container);

    this.controls.onKeyPress = (code) => this.keyPressed(code);
    this.controls.onWheel = (steps) => this.selectSlot((this.inventory.selected + steps + HOTBAR_SIZE) % HOTBAR_SIZE);
    this.controls.onLockChange = (locked) => this.lockChanged(locked);
    this.controls.onLockError = () => {
      if (this.state === 'resuming' || this.state === 'playing') this.setState('paused');
    };

    transport.onMessage = (msg) => this.receive(msg);
    transport.onClose = (reason) => this.disconnect(reason);
  }

  // --- Host interfaces (interaction, inventory screen) -----------------------

  get creative(): boolean {
    return this.gameMode === GameMode.CREATIVE;
  }

  get hosting(): boolean {
    return this.isHost;
  }

  send(msg: ClientMsg): void {
    this.transport.send(msg);
  }

  predictBlock(x: number, y: number, z: number, id: number): void {
    this.applyBlock(x, y, z, id);
  }

  playerBox(): { min: number[]; max: number[] } {
    return this.player.body.box();
  }

  pickBlock(id: number): void {
    const inv = this.inventory;
    const existing = inv.slots.findIndex((s, i) => i < HOTBAR_SIZE && s?.id === id);
    if (existing >= 0) this.selectSlot(existing);
    else this.invAction(InvAction.CREATIVE_SLOT, inv.selected, 0, id);
  }

  invAction(action: number, slot: number, button: number, item?: number): void {
    // Predict locally with the same code the host runs; the host's snapshot follows.
    this.inventory.apply(action, slot, button, item, this.creative);
    this.send({ t: 'inv', action, slot, button, item });
    this.invScreen.render();
  }

  // --- Lifecycle / UI state ---------------------------------------------------

  start(): void {
    this.onStatus?.({ kind: 'connecting' });
    this.send({ t: 'hello', v: PROTOCOL_VERSION, name: this.options.name });
    const loop = (now: number) => {
      if (this.disposed) return;
      this.frame(now);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  /** Called from a click (user gesture) to enter the game. */
  resume(): void {
    if (this.state === 'disconnected' || this.state === 'loading') return;
    if (this.invScreen.open) this.closeInventory(false);
    this.setState('resuming');
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

  private lockChanged(locked: boolean): void {
    if (locked) {
      if (this.state !== 'disconnected' && this.state !== 'loading') this.setState('playing');
    } else if (this.state === 'playing' || this.state === 'resuming') {
      this.setState('paused');
    }
  }

  private keyPressed(code: string): void {
    if (code === KEYS.debug) this.debug.toggle();
    if (this.state === 'inventory') {
      if (code === KEYS.inventory || code === 'Escape') this.closeInventory(code === KEYS.inventory);
      return;
    }
    if (this.state !== 'playing') return;
    if (code === KEYS.inventory) {
      this.openInventory();
      return;
    }
    const digit = /^Digit([1-9])$/.exec(code);
    if (digit) this.selectSlot(Number(digit[1]) - 1);
    this.player.keyPressed(code);
  }

  private openInventory(): void {
    this.state = 'inventory';
    this.controls.unlock();
    this.invScreen.show();
  }

  private closeInventory(relock: boolean): void {
    this.invAction(InvAction.CLOSE, 0, 0);
    this.invScreen.hide();
    if (relock) {
      this.state = 'resuming';
      this.controls.lock();
    } else {
      this.setState('paused');
    }
  }

  private selectSlot(i: number): void {
    if (i === this.inventory.selected) return;
    this.inventory.selected = i;
    this.send({ t: 'held', slot: i });
  }

  private disconnect(reason: string): void {
    if (this.state === 'disconnected') return;
    this.state = 'disconnected';
    this.controls.unlock();
    this.onStatus?.({ kind: 'disconnected', reason });
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.controls.dispose();
    this.interaction.dispose();
    this.meshes.dispose();
    this.hud.dispose();
    this.invScreen.dispose();
    this.debug.el.remove();
    this.renderer.dispose();
  }

  // --- Network ----------------------------------------------------------------

  private receive(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.seed = msg.seed;
        this.viewDistance = msg.viewDistance;
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
        this.chunkQueue.push(msg);
        break;
      case 'unloadChunk': {
        const i = this.chunkQueue.findIndex((m) => m.cx === msg.cx && m.cz === msg.cz);
        if (i >= 0) this.chunkQueue.splice(i, 1);
        this.world.remove(msg.cx, msg.cz);
        this.meshes.remove(msg.cx, msg.cz);
        break;
      }
      case 'blockChange':
        this.applyBlock(msg.x, msg.y, msg.z, msg.id);
        break;
      case 'inventory':
        this.inventory.load(msg.state);
        this.invScreen.render();
        break;
      case 'gameMode':
        this.gameMode = msg.mode;
        this.player.canFly = this.creative;
        this.invScreen.render();
        break;
      case 'time':
        this.setServerTime(msg.time);
        break;
      case 'kick':
        this.disconnect(msg.reason);
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
    while (this.chunkQueue.length > 0 && performance.now() - start < CHUNK_BUDGET_MS) {
      const msg = this.chunkQueue.shift()!;
      const chunk = decodeChunk(msg.data);
      const touched = this.world.add(chunk);
      for (const c of touched) this.meshes.markAround(c.cx, c.cz);
    }
  }

  // --- Frame ------------------------------------------------------------------

  private frame(now: number): void {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000 || 0);
    this.lastFrame = now;
    const t0 = performance.now();
    const body = this.player.body;

    this.processChunks();
    if (this.state !== 'loading' && this.state !== 'disconnected') this.player.update(dt);

    // Camera: eye height eases when sneaking; FOV widens when sprinting.
    const cam = this.renderer.camera;
    this.eyeOffset += (body.eyeHeight - this.eyeOffset) * Math.min(1, dt * 14);
    cam.position.set(body.x, body.y + this.eyeOffset, body.z);
    cam.rotation.set(this.controls.pitch, this.controls.yaw, 0);
    const fov = this.baseFov * (body.sprinting || (body.flying && this.controls.isDown(KEYS.sprint)) ? 1.12 : 1);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov += (fov - cam.fov) * Math.min(1, dt * 10);
      cam.updateProjectionMatrix();
    }

    if (this.state === 'playing') {
      cam.getWorldDirection(this.dir);
      this.interaction.update(dt, cam.position, this.dir);
    }

    const sky = this.sky.update(this.time, cam);
    const underwater = this.world.isWater(Math.floor(cam.position.x), Math.floor(cam.position.y), Math.floor(cam.position.z));
    this.uniforms.uSkyLight.value.copy(sky.skyLight);
    if (underwater) {
      this.uniforms.uFogColor.value.copy(UNDERWATER_FOG).multiplyScalar(0.3 + 0.7 * sky.daylight);
      this.uniforms.uFogNear.value = 0;
      this.uniforms.uFogFar.value = 22;
    } else {
      this.uniforms.uFogColor.value.copy(sky.horizon);
      this.uniforms.uFogFar.value = this.viewDistance * 16;
      this.uniforms.uFogNear.value = this.viewDistance * 16 * 0.55;
    }
    this.renderer.gl.setClearColor(this.uniforms.uFogColor.value);
    this.sky.group.visible = !underwater;

    this.meshes.update(body.x, body.z);
    this.hud.update(this.inventory, underwater, dt);
    this.renderer.render();

    if (this.state !== 'loading' && now - this.lastMoveSent >= 1000 / TICKS_PER_SECOND) {
      this.lastMoveSent = now;
      const flags = (body.onGround ? MoveFlag.ON_GROUND : 0) | (body.sneaking ? MoveFlag.SNEAK : 0) |
        (body.sprinting ? MoveFlag.SPRINT : 0) | (body.flying ? MoveFlag.FLYING : 0);
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
      'Cubica 0.2 (stage 2)',
      `${this.fps} fps  (cpu ${this.frameMs.toFixed(1)} ms)  draws ${info.calls}  tris ${Math.round(info.triangles / 1000)}k`,
      `XYZ ${b.x.toFixed(2)} / ${b.y.toFixed(2)} / ${b.z.toFixed(2)}  ${state}`,
      `Chunk ${bx >> 4} ${bz >> 4}  facing ${facing}`,
      `Biome ${biome}  light sky ${light >> 4} block ${light & 15}`,
      tg ? `Target ${blockDef(tg.id)?.name} @ ${tg.x} ${tg.y} ${tg.z}` : 'Target -',
      `Mode ${this.creative ? 'creative' : 'survival'}  chunks ${this.world.chunks.size}  meshed ${this.meshes.meshedCount}`,
      `Seed ${this.seed}  day ${Math.floor(this.time / DAY_LENGTH_TICKS) + 1}  ${clock}`,
    ]);
  }
}
