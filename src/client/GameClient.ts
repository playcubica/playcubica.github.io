import * as THREE from 'three';
import { Renderer } from './render/Renderer';
import { DAY_LENGTH_TICKS, PROTOCOL_VERSION, TICKS_PER_SECOND } from '../shared/constants';
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

export interface ClientOptions {
  name: string;
}

export type ClientStatus =
  | { kind: 'connecting' }
  | { kind: 'playing' }
  | { kind: 'disconnected'; reason: string };

/** Max milliseconds per frame spent decoding and lighting incoming chunks. */
const CHUNK_BUDGET_MS = 4;
const FLY_SPEED = 12;
const FLY_SPRINT_SPEED = 40;

/** Renders the world the host streams to it and sends the player's input back. */
export class GameClient {
  readonly renderer: Renderer;
  readonly world = new ClientWorld();
  readonly controls: Controls;
  onStatus: ((s: ClientStatus) => void) | null = null;

  private readonly uniforms: ChunkUniforms;
  private readonly meshes: ChunkMeshManager;
  private readonly sky = new Sky();
  private readonly debug: DebugOverlay;
  private readonly chunkQueue: Array<Extract<ServerMsg, { t: 'chunk' }>> = [];
  private readonly pos = new THREE.Vector3();
  private seed = 0;
  private viewDistance = 8;
  private serverTime = 0;
  private serverTimeAt = 0;
  private joined = false;
  private moveSeq = 0;
  private lastMoveSent = 0;
  private lastFrame = 0;
  private frames = 0;
  private fps = 0;
  private fpsAt = 0;
  private frameMs = 0;
  private debugAt = 0;

  constructor(container: HTMLElement, private readonly transport: Transport<ClientMsg, ServerMsg>, private readonly options: ClientOptions) {
    this.renderer = new Renderer(container);
    const textures = buildBlockTextures();
    this.uniforms = createChunkUniforms(textures.array);
    this.meshes = new ChunkMeshManager(this.world, this.renderer.scene, createChunkMaterials(this.uniforms));
    this.renderer.scene.add(this.sky.group);
    this.controls = new Controls(this.renderer.canvas);
    this.controls.onKeyPress = (code) => {
      if (code === KEYS.debug) this.debug.toggle();
    };
    this.debug = new DebugOverlay(container);

    transport.onMessage = (msg) => this.receive(msg);
    transport.onClose = (reason) => this.onStatus?.({ kind: 'disconnected', reason });
  }

  start(): void {
    this.onStatus?.({ kind: 'connecting' });
    this.transport.send({ t: 'hello', v: PROTOCOL_VERSION, name: this.options.name });
    const loop = (now: number) => {
      this.frame(now);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private receive(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.joined = true;
        this.seed = msg.seed;
        this.viewDistance = msg.viewDistance;
        this.setServerTime(msg.time);
        // Stage 1 has no physics yet: start floating above spawn.
        this.pos.set(msg.spawn[0], msg.spawn[1] + 12, msg.spawn[2]);
        this.controls.yaw = Math.PI * 0.75;
        this.controls.pitch = -0.35;
        this.uniforms.uFogFar.value = this.viewDistance * 16;
        this.uniforms.uFogNear.value = this.viewDistance * 16 * 0.55;
        this.onStatus?.({ kind: 'playing' });
        break;
      case 'chunk':
        this.chunkQueue.push(msg);
        break;
      case 'unloadChunk':
        this.chunkQueue.splice(0, this.chunkQueue.length, ...this.chunkQueue.filter((m) => m.cx !== msg.cx || m.cz !== msg.cz));
        this.world.remove(msg.cx, msg.cz);
        this.meshes.remove(msg.cx, msg.cz);
        break;
      case 'time':
        this.setServerTime(msg.time);
        break;
      case 'kick':
        this.onStatus?.({ kind: 'disconnected', reason: msg.reason });
        break;
      default:
        break;
    }
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

  private fly(dt: number): void {
    const c = this.controls;
    const speed = c.isDown(KEYS.sprint) ? FLY_SPRINT_SPEED : FLY_SPEED;
    const fx = -Math.sin(c.yaw);
    const fz = -Math.cos(c.yaw);
    let mx = 0;
    let my = 0;
    let mz = 0;
    if (c.isDown(KEYS.forward)) { mx += fx; mz += fz; }
    if (c.isDown(KEYS.back)) { mx -= fx; mz -= fz; }
    if (c.isDown(KEYS.left)) { mx += fz; mz -= fx; }
    if (c.isDown(KEYS.right)) { mx -= fz; mz += fx; }
    if (c.isDown(KEYS.jump)) my += 1;
    if (c.isDown(KEYS.sneak)) my -= 1;
    const len = Math.hypot(mx, mz);
    if (len > 0) { mx /= len; mz /= len; }
    this.pos.x += mx * speed * dt;
    this.pos.y = Math.max(-20, Math.min(320, this.pos.y + my * speed * dt));
    this.pos.z += mz * speed * dt;
  }

  private frame(now: number): void {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000 || 0);
    this.lastFrame = now;
    const t0 = performance.now();

    this.processChunks();
    if (this.joined) this.fly(dt);

    const cam = this.renderer.camera;
    cam.position.copy(this.pos);
    cam.rotation.set(this.controls.pitch, this.controls.yaw, 0);

    const sky = this.sky.update(this.time, cam);
    this.uniforms.uSkyLight.value.copy(sky.skyLight);
    this.uniforms.uFogColor.value.copy(sky.horizon);
    this.renderer.gl.setClearColor(sky.horizon);

    this.meshes.update(this.pos.x, this.pos.z);
    this.renderer.render();

    if (this.joined && now - this.lastMoveSent >= 1000 / TICKS_PER_SECOND) {
      this.lastMoveSent = now;
      this.transport.send({
        t: 'move', seq: this.moveSeq++, x: this.pos.x, y: this.pos.y, z: this.pos.z,
        yaw: this.controls.yaw, pitch: this.controls.pitch, flags: MoveFlag.FLYING,
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
    const p = this.pos;
    const bx = Math.floor(p.x);
    const by = Math.floor(p.y);
    const bz = Math.floor(p.z);
    const c = this.world.getChunk(bx >> 4, bz >> 4);
    const biome = c ? BIOME_NAMES[c.biomes[(bx & 15) | ((bz & 15) << 4)]] : '-';
    const light = this.world.getLight(bx, by, bz);
    const t = ((this.time % DAY_LENGTH_TICKS) + DAY_LENGTH_TICKS) % DAY_LENGTH_TICKS;
    const hours = (t / 1000 + 6) % 24;
    const clock = `${String(Math.floor(hours)).padStart(2, '0')}:${String(Math.floor((hours % 1) * 60)).padStart(2, '0')}`;
    const yawDeg = ((((-this.controls.yaw * 180) / Math.PI) % 360) + 360) % 360;
    const facing = ['north (-Z)', 'east (+X)', 'south (+Z)', 'west (-X)'][Math.round(yawDeg / 90) % 4];
    const info = this.renderer.gl.info.render;
    this.debug.set([
      'Cubica 0.1 (stage 1)',
      `${this.fps} fps  (cpu ${this.frameMs.toFixed(1)} ms)  draws ${info.calls}  tris ${Math.round(info.triangles / 1000)}k`,
      `XYZ ${p.x.toFixed(1)} / ${p.y.toFixed(1)} / ${p.z.toFixed(1)}`,
      `Chunk ${bx >> 4} ${bz >> 4}  facing ${facing}`,
      `Biome ${biome}  light sky ${light >> 4} block ${light & 15}`,
      `Chunks ${this.world.chunks.size}  meshed ${this.meshes.meshedCount}  pending ${this.meshes.pendingCount + this.chunkQueue.length}`,
      `Seed ${this.seed}  day ${Math.floor(this.time / DAY_LENGTH_TICKS) + 1}  ${clock}`,
    ]);
  }
}
