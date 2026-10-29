import { B } from '../../shared/blocks/registry';

// Every sound in Cubica is synthesized with Web Audio (no audio files): filtered noise
// bursts for blocks and steps, oscillator sweeps for creatures and events, and a slow
// generative pentatonic piece now and then as music.

export type SoundName =
  | 'break' | 'place' | 'step' | 'hurt' | 'death' | 'eat' | 'pickup' | 'click' | 'door'
  | 'grunt' | 'growl' | 'thorn' | 'spores' | 'rift' | 'splash'
  | 'moo' | 'baa' | 'oink' | 'cluck' | 'neigh' | 'bark' | 'meow' | 'squeak' | 'yip' | 'bleat' | 'snort' | 'shear' | 'pop';

type Material = 'stone' | 'wood' | 'soft' | 'glass' | 'plant' | 'sand';

const MATERIAL_FREQ: Record<Material, number> = { stone: 1700, wood: 800, soft: 420, glass: 3200, plant: 2400, sand: 1100 };

export function materialOf(id: number): Material {
  switch (id) {
    case B.ASHWOOD_LOG: case B.FROSTPINE_LOG: case B.ASHWOOD_PLANKS: case B.FROSTPINE_PLANKS: case B.WORKBENCH:
    case B.CHEST: case B.ASHWOOD_DOOR: case B.BEDROLL: case B.CACTUS:
      return 'wood';
    case B.DIRT: case B.GRASS: case B.FROST_TURF: case B.CLAY: case B.FARMLAND: case B.SNOW:
      return 'soft';
    case B.SAND: case B.GRAVEL:
      return 'sand';
    case B.GLASS: case B.ICE: case B.LUMEN_CRYSTAL: case B.LAMP: case B.LAMP_ON:
      return 'glass';
    case B.ASHWOOD_LEAVES: case B.FROSTPINE_NEEDLES: case B.TALL_GRASS: case B.SUNBLOOM: case B.BLUEBELL:
    case B.DRY_SCRUB: case B.SUNWHEAT: case B.ASHWOOD_SAPLING: case B.FROSTPINE_SAPLING:
      return 'plant';
    default:
      return 'stone';
  }
}

export type MusicMood = 'day' | 'night' | 'deep';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private music!: GainNode;
  private echo!: DelayNode;
  private noise!: AudioBuffer;
  private soundVolume = 0.8;
  private musicVolume = 0.5;
  private listener = { x: 0, y: 0, z: 0, yaw: 0 };
  private nextPieceAt = 0;
  mood: MusicMood = 'day';

  /** Must be called from a user gesture (browsers keep audio locked until then). */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.music = ctx.createGain();
    // A soft feedback echo gives the music some room.
    this.echo = ctx.createDelay(1);
    this.echo.delayTime.value = 0.38;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.35;
    const wet = ctx.createGain();
    wet.gain.value = 0.4;
    this.music.connect(this.master);
    this.music.connect(this.echo);
    this.echo.connect(feedback).connect(this.echo);
    this.echo.connect(wet).connect(this.master);
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.applyVolumes();
    this.nextPieceAt = ctx.currentTime + 20;
  }

  setVolumes(sound: number, music: number): void {
    this.soundVolume = sound;
    this.musicVolume = music;
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.ctx) return;
    this.sfx.gain.value = this.soundVolume;
    this.music.gain.value = this.musicVolume * 0.35;
  }

  setListener(x: number, y: number, z: number, yaw: number): void {
    this.listener = { x, y, z, yaw };
  }

  /** Plays a sound, optionally at a world position (quieter with distance, panned left/right). */
  play(name: SoundName, at?: { x: number; y: number; z: number }, material: Material = 'stone', volume = 1): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this.soundVolume <= 0) return;
    let gain = volume;
    let pan = 0;
    if (at) {
      const dx = at.x - this.listener.x;
      const dy = at.y - this.listener.y;
      const dz = at.z - this.listener.z;
      const dist = Math.hypot(dx, dy, dz);
      gain *= Math.max(0, 1 - dist / 28);
      if (gain <= 0.01) return;
      // Angle of the source relative to where the listener faces (yaw 0 looks towards -z).
      const ang = Math.atan2(dx, -dz) + this.listener.yaw;
      pan = Math.max(-1, Math.min(1, Math.sin(ang) * Math.min(1, dist / 3)));
    }
    const out = ctx.createGain();
    out.gain.value = gain;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    out.connect(panner).connect(this.sfx);
    const t = ctx.currentTime;
    switch (name) {
      case 'break':
        this.noiseBurst(out, t, 0.18, MATERIAL_FREQ[material], 1.2, 0.9);
        if (material === 'glass') this.tone(out, t, 'triangle', 2400, 1800, 0.15, 0.2);
        break;
      case 'place':
        this.noiseBurst(out, t, 0.08, MATERIAL_FREQ[material] * 0.6, 0.8, 0.7);
        this.tone(out, t, 'sine', 140, 90, 0.08, 0.5);
        break;
      case 'step':
        this.noiseBurst(out, t, 0.05, MATERIAL_FREQ[material] * 0.5, 1, 0.25);
        break;
      case 'hurt':
        this.tone(out, t, 'square', 420, 160, 0.18, 0.25);
        break;
      case 'death':
        this.tone(out, t, 'sawtooth', 300, 60, 0.9, 0.3);
        break;
      case 'eat':
        for (let i = 0; i < 3; i++) this.noiseBurst(out, t + i * 0.12, 0.06, 1400, 2, 0.5);
        break;
      case 'pickup':
        this.tone(out, t, 'sine', 880, 1400, 0.09, 0.3);
        break;
      case 'click':
        this.tone(out, t, 'square', 1800, 1200, 0.03, 0.15);
        break;
      case 'door':
        this.tone(out, t, 'sawtooth', 220, 130, 0.25, 0.12);
        this.noiseBurst(out, t + 0.2, 0.06, 600, 1, 0.5);
        break;
      case 'grunt':
        this.tone(out, t, 'triangle', 160 + Math.random() * 60, 110, 0.3, 0.5, 9);
        break;
      case 'growl':
        this.tone(out, t, 'sawtooth', 95 + Math.random() * 20, 70, 0.6, 0.3, 6);
        break;
      case 'thorn':
        this.noiseBurst(out, t, 0.22, 3500, 0.7, 0.5, 900);
        break;
      case 'spores':
        this.noiseBurst(out, t, 0.9, 700, 0.5, 0.8, 200);
        break;
      case 'rift':
        for (const f of [330, 415, 494, 660]) this.tone(out, t, 'sine', f, f * 1.5, 1.6, 0.12);
        break;
      case 'splash':
        this.noiseBurst(out, t, 0.35, 900, 0.6, 0.6, 300);
        break;
      // Animal voices (all synthesized; pitch varies a little each time).
      case 'moo': {
        const f = 105 + Math.random() * 25;
        this.tone(out, t, 'sawtooth', f, f * 1.25, 0.35, 0.18);
        this.tone(out, t + 0.33, 'sawtooth', f * 1.25, f * 0.85, 0.7, 0.18, 3);
        break;
      }
      case 'baa': {
        const f = 330 + Math.random() * 60;
        this.tone(out, t, 'sawtooth', f, f * 0.92, 0.55, 0.12, 22);
        break;
      }
      case 'oink':
        for (let i = 0; i < 2; i++) this.tone(out, t + i * 0.16, 'square', 210 + Math.random() * 40, 140, 0.12, 0.12, 30);
        break;
      case 'cluck':
        for (let i = 0; i < 3; i++) this.tone(out, t + i * 0.09, 'square', 900 + Math.random() * 200, 600, 0.05, 0.1);
        break;
      case 'neigh': {
        const f = 700 + Math.random() * 100;
        this.tone(out, t, 'sawtooth', f, f * 1.3, 0.15, 0.12, 18);
        this.tone(out, t + 0.15, 'sawtooth', f * 1.3, f * 0.45, 0.75, 0.12, 24);
        break;
      }
      case 'bark':
        this.tone(out, t, 'sawtooth', 520 + Math.random() * 80, 260, 0.11, 0.2);
        this.noiseBurst(out, t, 0.08, 900, 1, 0.3);
        break;
      case 'meow': {
        const f = 520 + Math.random() * 120;
        this.tone(out, t, 'triangle', f, f * 1.45, 0.18, 0.18);
        this.tone(out, t + 0.18, 'triangle', f * 1.45, f * 0.8, 0.32, 0.18);
        break;
      }
      case 'squeak':
        this.tone(out, t, 'sine', 1800 + Math.random() * 400, 2600, 0.07, 0.12);
        break;
      case 'yip':
        this.tone(out, t, 'square', 950 + Math.random() * 150, 1400, 0.09, 0.12);
        this.tone(out, t + 0.12, 'square', 1300, 800, 0.1, 0.1);
        break;
      case 'bleat': {
        const f = 420 + Math.random() * 80;
        this.tone(out, t, 'sawtooth', f, f * 1.05, 0.5, 0.12, 28);
        break;
      }
      case 'snort':
        this.noiseBurst(out, t, 0.2, 500, 0.8, 0.5, 250);
        break;
      case 'shear':
        for (let i = 0; i < 2; i++) this.noiseBurst(out, t + i * 0.1, 0.05, 4200, 3, 0.4);
        break;
      case 'pop':
        this.tone(out, t, 'sine', 600, 1200, 0.08, 0.25);
        break;
    }
  }

  private tone(out: AudioNode, t: number, type: OscillatorType, f0: number, f1: number, dur: number, vol: number, vibrato = 0): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    if (vibrato) {
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = vibrato;
      depth.gain.value = f0 * 0.06;
      lfo.connect(depth).connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + dur);
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noiseBurst(out: AudioNode, t: number, dur: number, freq: number, q: number, vol: number, sweepTo = 0): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(freq, t);
    if (sweepTo) filter.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    filter.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(g).connect(out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  // --- Music -----------------------------------------------------------------

  /** Call every frame; starts a new piece every few minutes. */
  tick(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this.musicVolume <= 0 || ctx.currentTime < this.nextPieceAt) return;
    const length = this.playPiece(ctx.currentTime + 0.5);
    this.nextPieceAt = ctx.currentTime + length + 120 + Math.random() * 180;
  }

  /** A slow generative piece on a pentatonic scale; returns its length in seconds. */
  private playPiece(t0: number): number {
    const roots = { day: 261.63, night: 220, deep: 110 };
    const scales = { day: [0, 2, 4, 7, 9], night: [0, 3, 5, 7, 10], deep: [0, 1, 5, 7, 8] };
    const root = roots[this.mood];
    const scale = scales[this.mood];
    const note = (deg: number) => root * Math.pow(2, (scale[((deg % 5) + 5) % 5] + 12 * Math.floor(deg / 5)) / 12);
    const bars = 12 + Math.floor(Math.random() * 6);
    const beat = this.mood === 'deep' ? 1.4 : 1.1;
    let deg = Math.floor(Math.random() * 5);
    for (let b = 0; b < bars; b++) {
      const bt = t0 + b * beat * 4;
      // Pad: root and fifth, held for the bar.
      const chordRoot = [0, 3, 4, 2][b % 4];
      for (const d of [chordRoot, chordRoot + 2]) this.musicNote(bt, note(d - 5), beat * 4, 0.05, 'sine');
      // Melody: a random walk with rests.
      for (let k = 0; k < 4; k++) {
        if (Math.random() < 0.35) continue;
        deg = Math.max(0, Math.min(9, deg + Math.floor(Math.random() * 5) - 2));
        this.musicNote(bt + k * beat, note(deg + 5), beat * 1.8, 0.09, 'triangle');
      }
    }
    return bars * beat * 4;
  }

  private musicNote(t: number, freq: number, dur: number, vol: number, type: OscillatorType): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.music);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
  }
}
