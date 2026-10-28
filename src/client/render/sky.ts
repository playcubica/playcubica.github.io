import * as THREE from 'three';
import { dayFraction, daylight as daylightAt, sunHeight } from '../../shared/time';
import { mulberry32 } from '../../shared/rng';

// Sky dome, sun, moon and stars. Time 0 is sunrise, 6000 noon, 12000 sunset, 18000 midnight.

/** Raw sRGB colour, independent of three.js colour management. */
function rgb(hex: number): THREE.Color {
  return new THREE.Color(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
}

const DAY_TOP = rgb(0x3f7fd8);
const DAY_HORIZON = rgb(0xa8cdf2);
const DUSK_HORIZON = rgb(0xf09a5a);
const NIGHT_TOP = rgb(0x03050d);
const NIGHT_HORIZON = rgb(0x0b1226);
const SKY_DAY = new THREE.Color(1, 1, 1);
const SKY_NIGHT = new THREE.Color(0.16, 0.2, 0.34);

export interface SkyState {
  /** 0 at night, 1 at noon. */
  daylight: number;
  horizon: THREE.Color;
  skyLight: THREE.Color;
}

function pixelDisc(colors: { core: string; edge: string; spots?: string }): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d')!;
  g.fillStyle = colors.edge;
  g.fillRect(2, 2, 12, 12);
  g.fillStyle = colors.core;
  g.fillRect(4, 4, 8, 8);
  if (colors.spots) {
    g.fillStyle = colors.spots;
    g.fillRect(5, 6, 2, 2);
    g.fillRect(9, 9, 2, 1);
    g.fillRect(8, 5, 1, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  return t;
}

export class Sky {
  readonly group = new THREE.Group();
  private readonly domeUniforms = {
    uTop: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
  };
  private readonly celestial = new THREE.Group();
  private readonly starMaterial: THREE.PointsMaterial;
  private readonly state: SkyState = { daylight: 1, horizon: new THREE.Color(), skyLight: new THREE.Color() };

  constructor() {
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(400, 24, 12),
      new THREE.ShaderMaterial({
        uniforms: this.domeUniforms,
        vertexShader: `
          varying float vH;
          void main() {
            vH = normalize(position).y;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          uniform vec3 uTop;
          uniform vec3 uHorizon;
          varying float vH;
          void main() {
            float t = smoothstep(-0.05, 0.45, vH);
            gl_FragColor = vec4(mix(uHorizon, uTop, t), 1.0);
          }`,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    );
    dome.renderOrder = -10;
    this.group.add(dome);

    const rnd = mulberry32(1234);
    const starPos: number[] = [];
    for (let i = 0; i < 900; i++) {
      const u = rnd() * 2 - 1;
      const a = rnd() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      starPos.push(Math.cos(a) * s * 380, u * 380, Math.sin(a) * s * 380);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
    this.starMaterial = new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, depthWrite: false, fog: false });
    const stars = new THREE.Points(starGeo, this.starMaterial);
    stars.renderOrder = -9;
    this.celestial.add(stars);

    const disc = (tex: THREE.Texture, size: number, dist: number) => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide }),
      );
      m.position.set(0, 0, dist);
      m.renderOrder = -8;
      return m;
    };
    const sun = disc(pixelDisc({ core: '#fff6c8', edge: '#ffd24a' }), 60, 350);
    const moon = disc(pixelDisc({ core: '#e6e9f2', edge: '#aab2c4', spots: '#8f97aa' }), 40, -350);
    this.celestial.add(sun, moon);
    this.group.add(this.celestial);
  }

  update(time: number, camera: THREE.Camera): SkyState {
    const angle = dayFraction(time) * Math.PI * 2;
    const daylight = daylightAt(time);
    // Sunrise/sunset glow when the sun is near the horizon.
    const dusk = Math.max(0, 1 - Math.abs(sunHeight(time)) / 0.3);

    this.domeUniforms.uTop.value.copy(NIGHT_TOP).lerp(DAY_TOP, daylight);
    const horizon = this.domeUniforms.uHorizon.value.copy(NIGHT_HORIZON).lerp(DAY_HORIZON, daylight).lerp(DUSK_HORIZON, dusk * 0.55);

    this.group.position.copy(camera.position);
    // Sun travels east (+x) -> up -> west (-x); the celestial group's +z axis points at the sun.
    this.celestial.rotation.set(0, Math.PI / 2, 0);
    this.celestial.rotateX(-angle);
    this.starMaterial.opacity = Math.max(0, 1 - daylight * 1.6);

    this.state.daylight = daylight;
    this.state.horizon.copy(horizon);
    this.state.skyLight.copy(SKY_NIGHT).lerp(SKY_DAY, daylight);
    return this.state;
  }
}
