import * as THREE from 'three';

// All colours and textures in Cubica are authored as plain sRGB values and written
// straight to the screen, so three.js colour management is switched off.
THREE.ColorManagement.enabled = false;

export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly onResize = () => this.resize();

  constructor(container: HTMLElement, fov = 70) {
    this.gl = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.gl.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.gl.domElement.className = 'game-canvas';
    container.appendChild(this.gl.domElement);
    this.camera = new THREE.PerspectiveCamera(fov, 1, 0.1, 1000);
    this.camera.rotation.order = 'YXZ';
    this.resize();
    window.addEventListener('resize', this.onResize);
  }

  get canvas(): HTMLCanvasElement {
    return this.gl.domElement;
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.gl.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    this.gl.render(this.scene, this.camera);
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.gl.dispose();
    this.gl.domElement.remove();
  }
}
