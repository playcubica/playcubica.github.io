import * as THREE from 'three';

/** Uniforms shared by every chunk mesh; updated once per frame. */
export interface ChunkUniforms {
  uTex: { value: THREE.DataArrayTexture };
  /** Sky light colour × daylight factor. */
  uSkyLight: { value: THREE.Color };
  uFogColor: { value: THREE.Color };
  uFogNear: { value: number };
  uFogFar: { value: number };
  /** Darkest a lit surface gets (raised in the Ember Deep). */
  uMinLight: { value: number };
  [name: string]: THREE.IUniform;
}

const vertexShader = /* glsl */ `
  in vec4 aTex;
  in vec4 aLight;
  out vec3 vUv;
  out float vShade;
  out vec3 vLight;
  out float vDist;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // Texture rows run top-down, world v runs bottom-up.
    vUv = vec3(aTex.x / 16.0, -aTex.y / 16.0, aTex.z);
    vShade = aTex.w / 255.0;
    vLight = aLight.xyz;
    vDist = length(mv.xyz);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp sampler2DArray;
  uniform sampler2DArray uTex;
  uniform vec3 uSkyLight;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uAlphaTest;
  uniform float uMinLight;
  in vec3 vUv;
  in float vShade;
  in vec3 vLight;
  in float vDist;
  out vec4 fragColor;
  void main() {
    vec4 tex = texture(uTex, vUv);
    if (tex.a < uAlphaTest) discard;
    float sky = pow(0.8, 15.0 - vLight.x);
    float blk = pow(0.8, 15.0 - vLight.y);
    vec3 light = max(uSkyLight * sky, vec3(1.0, 0.86, 0.64) * blk);
    light = max(light, vec3(uMinLight));
    float ao = 0.5 + 0.5 * (vLight.z / 3.0);
    vec3 col = tex.rgb * light * vShade * ao;
    float f = smoothstep(uFogNear, uFogFar, vDist);
    fragColor = vec4(mix(col, uFogColor, f), tex.a);
  }
`;

export function createChunkUniforms(tex: THREE.DataArrayTexture): ChunkUniforms {
  return {
    uTex: { value: tex },
    uSkyLight: { value: new THREE.Color(1, 1, 1) },
    uFogColor: { value: new THREE.Color(0.7, 0.8, 0.95) },
    uFogNear: { value: 80 },
    uFogFar: { value: 120 },
    uMinLight: { value: 0.06 },
  };
}

export interface ChunkMaterials {
  opaque: THREE.ShaderMaterial;
  translucent: THREE.ShaderMaterial;
}

export function createChunkMaterials(uniforms: ChunkUniforms): ChunkMaterials {
  const make = (alphaTest: number, translucent: boolean) =>
    new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { ...uniforms, uAlphaTest: { value: alphaTest } },
      vertexShader,
      fragmentShader,
      transparent: translucent,
      depthWrite: !translucent,
      side: translucent ? THREE.DoubleSide : THREE.FrontSide,
    });
  return { opaque: make(0.5, false), translucent: make(0.02, true) };
}
