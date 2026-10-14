import {
  ACESFilmicToneMapping, NoToneMapping, BoxGeometry, Color, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, MathUtils, Matrix4, Mesh,
  OrthographicCamera, PerspectiveCamera, PlaneGeometry, Raycaster, Scene, Vector2, Vector3, WebGLRenderer, type ShaderMaterial,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import type { CityLayout } from "../core/layout";
import { ArcLayer, type Arc } from "./arcs";
import { blockMaterial, gridMaterial } from "./materials";
import type { ScenePalette } from "./palette";

export type Pick = { kind: "file"; id: number } | { kind: "dir"; path: string } | null;

export const TowerState = { Normal: 0, Dim: 1, Highlight: 2, Selected: 3, Ghost: 4 } as const;
export type TowerState = (typeof TowerState)[keyof typeof TowerState];

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  maxY: number;
}

const VIEW_DIR = new Vector3(1, 1.1, 1).normalize();
const PLATFORM_H = 0.3;

/**
 * The 3D city: renderer, camera, controls, instanced towers & platforms, arcs, bloom.
 * Knows nothing about issues or patterns: callers push colours, states and arcs.
 */
export class CityView {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  camera: PerspectiveCamera | OrthographicCamera;
  private perspective: PerspectiveCamera;
  private ortho: OrthographicCamera;
  controls: OrbitControls;
  private composer: EffectComposer;
  private renderPass: RenderPass;
  private bloom: UnrealBloomPass;
  private towerMat = blockMaterial({ edge: 0.09, fill: 0.62, glow: 1.25 });
  private platformMat = blockMaterial({ edge: 0.12, fill: 0.5, glow: 0.9 });
  private gridMat = gridMaterial();
  private grid: Mesh;
  private towers: InstancedMesh | null = null;
  private platforms: InstancedMesh | null = null;
  private towerState: InstancedBufferAttribute | null = null;
  private towerPulse: InstancedBufferAttribute | null = null;
  private platformState: InstancedBufferAttribute | null = null;
  readonly arcs = new ArcLayer();
  private layout: CityLayout | null = null;
  /** Instance index → file id, and back. */
  private instanceFile: number[] = [];
  private fileInstance = new Map<number, number>();
  private platformDirs: string[] = [];
  private raycaster = new Raycaster();
  private pointer = new Vector2();
  private pointerDown = new Vector2();
  private hoverPending: { x: number; y: number } | null = null;
  private lastHover: string = "";
  private flight: { from: Vector3; to: Vector3; tFrom: Vector3; tTo: Vector3; start: number; ms: number } | null = null;
  private clockStart = performance.now();
  private perf = { frames: 0, start: 0, done: false };
  onLowPerformance: () => void = () => {};
  private resizeObserver: ResizeObserver;
  private disposed = false;
  bloomEnabled = true;
  /** Pixels covered on the right by a panel: the view centre shifts left by half of it. */
  private inset = { target: 0, current: 0 };
  onHover: (pick: Pick, x: number, y: number) => void = () => {};
  onClick: (pick: Pick, event: MouseEvent) => void = () => {};
  onFrame: () => void = () => {};

  constructor(private container: HTMLElement, private palette: ScenePalette) {
    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.classList.add("city-canvas");

    this.perspective = new PerspectiveCamera(32, 1, 0.5, 20000);
    this.ortho = new OrthographicCamera(-1, 1, 1, -1, -20000, 20000);
    this.camera = this.perspective;
    this.controls = this.makeControls();

    this.grid = new Mesh(new PlaneGeometry(1, 1), this.gridMat);
    this.grid.rotation.x = -Math.PI / 2;
    this.grid.position.y = -0.02;
    this.scene.add(this.grid, this.arcs.object);

    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.bloom = new UnrealBloomPass(new Vector2(1, 1), 0.7, 0.55, 0.62);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.applyPalette(palette);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.bindPointer();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private makeControls(): OrbitControls {
    const c = new OrbitControls(this.camera, this.renderer.domElement);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.maxPolarAngle = MathUtils.degToRad(84);
    c.screenSpacePanning = false;
    c.zoomToCursor = true;
    c.addEventListener("start", () => (this.flight = null));
    return c;
  }

  applyPalette(p: ScenePalette) {
    this.palette = p;
    this.scene.background = p.background;
    this.gridMat.uniforms.uColor.value.copy(p.grid);
    this.gridMat.uniforms.uMajor.value.copy(p.gridMajor);
    for (const m of [this.towerMat, this.platformMat, this.gridMat]) m.uniforms.uFogColor.value.copy(p.fog);
    for (const m of [this.towerMat, this.platformMat]) m.uniforms.uDim.value.copy(p.dim);
    this.renderer.toneMapping = p.dark ? ACESFilmicToneMapping : NoToneMapping;
    for (const m of [this.towerMat, this.platformMat]) m.uniforms.uLight.value = p.dark ? 0 : 1;
    this.bloom.strength = p.dark ? 0.55 : 0.2;
    this.bloom.threshold = p.dark ? 0.7 : 0.88;
    if (this.layout) this.colorPlatforms();
  }

  /** Builds the instanced meshes for a new city. */
  load(layout: CityLayout) {
    this.layout = layout;
    this.clearMeshes();
    const box = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const m = new Matrix4();

    const towers = new InstancedMesh(box, this.towerMat, layout.towers.length);
    this.instanceFile = [];
    this.fileInstance.clear();
    layout.towers.forEach((t, i) => {
      m.makeScale(t.w, t.h, t.w).setPosition(t.x, t.y, t.z);
      towers.setMatrixAt(i, m);
      towers.setColorAt(i, this.palette.neutral);
      this.instanceFile.push(t.file);
      this.fileInstance.set(t.file, i);
    });
    this.towerState = new InstancedBufferAttribute(new Float32Array(layout.towers.length), 1).setUsage(DynamicDrawUsage);
    this.towerPulse = new InstancedBufferAttribute(new Float32Array(layout.towers.length), 1).setUsage(DynamicDrawUsage);
    box.setAttribute("aState", this.towerState);
    box.setAttribute("aPulse", this.towerPulse);
    towers.computeBoundingSphere();
    this.towers = towers;

    const pbox = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const platforms = new InstancedMesh(pbox, this.platformMat, layout.platforms.length);
    this.platformDirs = [];
    layout.platforms.forEach((p, i) => {
      m.makeScale(p.w, PLATFORM_H, p.d).setPosition(p.x, p.y + 0.0, p.z);
      platforms.setMatrixAt(i, m);
      this.platformDirs.push(p.dir);
    });
    this.platformState = new InstancedBufferAttribute(new Float32Array(layout.platforms.length), 1).setUsage(DynamicDrawUsage);
    pbox.setAttribute("aState", this.platformState);
    pbox.setAttribute("aPulse", new InstancedBufferAttribute(new Float32Array(layout.platforms.length), 1));
    this.platforms = platforms;
    this.colorPlatforms();

    this.scene.add(platforms, towers);
    const radius = layout.size * 3 + 200;
    this.grid.scale.set(radius * 2, radius * 2, 1);
    this.gridMat.uniforms.uRadius.value = radius;
    this.gridMat.uniforms.uCell.value = layout.size > 400 ? 10 : layout.size > 120 ? 4 : 2;
    this.controls.maxDistance = layout.size * 6 + 200;
    this.controls.minDistance = 3;
    this.resetView(false);
  }

  private colorPlatforms() {
    if (!this.platforms || !this.layout) return;
    this.layout.platforms.forEach((p, i) => this.platforms!.setColorAt(i, this.palette.platform(p.level)));
    if (this.platforms.instanceColor) this.platforms.instanceColor.needsUpdate = true;
  }

  private clearMeshes() {
    for (const mesh of [this.towers, this.platforms]) {
      if (!mesh) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.towers = this.platforms = null;
  }

  /** Per-file tower colours and pulses. */
  setTowerColors(color: (file: number) => Color, pulse: (file: number) => number = () => 0) {
    if (!this.towers || !this.towerPulse) return;
    this.instanceFile.forEach((file, i) => {
      this.towers!.setColorAt(i, color(file));
      this.towerPulse!.setX(i, pulse(file));
    });
    this.towers.instanceColor!.needsUpdate = true;
    this.towerPulse.needsUpdate = true;
  }

  setTowerStates(state: (file: number) => TowerState) {
    if (!this.towerState) return;
    this.instanceFile.forEach((file, i) => this.towerState!.setX(i, state(file)));
    this.towerState.needsUpdate = true;
  }

  setPlatformStates(state: (dir: string) => TowerState) {
    if (!this.platformState) return;
    this.platformDirs.forEach((dir, i) => this.platformState!.setX(i, state(dir)));
    this.platformState.needsUpdate = true;
  }

  setArcs(arcs: Arc[]) {
    this.arcs.set(arcs, this.layout ? Math.max(2, this.layout.maxHeight * 0.25) : 2);
  }

  towerTop(file: number): Vector3 | null {
    const t = this.layout?.towerByFile[file];
    return t ? new Vector3(t.x, t.y + t.h, t.z) : null;
  }

  platformTop(dir: string): Vector3 | null {
    const p = this.layout?.platformByDir.get(dir);
    return p ? new Vector3(p.x, p.y + PLATFORM_H, p.z) : null;
  }

  boundsOfFiles(files: Iterable<number>): Bounds | null {
    let b: Bounds | null = null;
    for (const f of files) {
      const t = this.layout?.towerByFile[f];
      if (!t) continue;
      b ??= { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, maxY: 0 };
      b.minX = Math.min(b.minX, t.x - t.w / 2);
      b.maxX = Math.max(b.maxX, t.x + t.w / 2);
      b.minZ = Math.min(b.minZ, t.z - t.w / 2);
      b.maxZ = Math.max(b.maxZ, t.z + t.w / 2);
      b.maxY = Math.max(b.maxY, t.y + t.h);
    }
    return b;
  }

  boundsOfDir(dir: string): Bounds | null {
    const p = this.layout?.platformByDir.get(dir);
    return p ? { minX: p.x - p.w / 2, maxX: p.x + p.w / 2, minZ: p.z - p.d / 2, maxZ: p.z + p.d / 2, maxY: p.y + 2 } : null;
  }

  /** Smoothly moves the camera to frame `b`, keeping the current viewing direction. */
  flyTo(b: Bounds, animate = true, minRadius = 6) {
    const center = new Vector3((b.minX + b.maxX) / 2, b.maxY * 0.35, (b.minZ + b.maxZ) / 2);
    const radius = Math.max(minRadius, Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ) / 2, b.maxY * 0.7);
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-6) dir.copy(VIEW_DIR);
    dir.normalize();
    // Fit the projected footprint: horizontally its full half-diagonal, vertically the half-diagonal
    // foreshortened by the elevation plus the towers' height, against the visible (un-inset) aspect.
    const vfov = MathUtils.degToRad(this.perspective.fov) / 2;
    const aspect = Math.max(0.3, (this.container.clientWidth - this.inset.target) / Math.max(1, this.container.clientHeight));
    const hfov = Math.atan(Math.tan(vfov) * aspect);
    const elev = Math.asin(Math.min(1, Math.max(0.2, dir.y)));
    const halfV = radius * Math.sin(elev) + b.maxY * Math.cos(elev) * 0.6;
    const dist = Math.max(halfV / Math.tan(vfov), radius / Math.tan(hfov)) * 1.08 + radius * Math.cos(elev) * 0.15;
    const to = center.clone().addScaledVector(dir, dist);
    if (!animate) {
      this.controls.target.copy(center);
      this.camera.position.copy(to);
      this.fitOrtho(radius);
      this.controls.update();
      return;
    }
    this.flight = { from: this.camera.position.clone(), to, tFrom: this.controls.target.clone(), tTo: center, start: performance.now(), ms: 750 };
    this.fitOrtho(radius);
  }

  resetView(animate = true) {
    if (!this.layout) return;
    const s = this.layout.size / 2;
    if (!animate) {
      this.camera.position.copy(VIEW_DIR).multiplyScalar(1);
      this.controls.target.set(0, 0, 0);
    }
    const prev = this.camera.position.clone().sub(this.controls.target);
    this.camera.position.copy(this.controls.target).add(VIEW_DIR.clone().multiplyScalar(prev.length() || 1));
    this.flyTo({ minX: -s, maxX: s, minZ: -s, maxZ: s, maxY: this.layout.maxHeight * 0.6 }, animate, 4);
  }

  /** Switches between perspective and an orthographic, true-isometric view. */
  setIsometric(on: boolean) {
    const target = this.controls.target.clone();
    const dist = this.camera.position.distanceTo(target);
    this.camera = on ? this.ortho : this.perspective;
    if (on) {
      this.camera.position.copy(target).add(new Vector3(1, Math.SQRT2 * Math.tan(MathUtils.degToRad(35.264)), 1).normalize().multiplyScalar(dist));
      this.fitOrtho(dist * Math.sin(MathUtils.degToRad(this.perspective.fov) / 2) / 1.15);
    } else this.camera.position.copy(target).add(VIEW_DIR.clone().multiplyScalar(dist));
    this.controls.dispose();
    this.controls = this.makeControls();
    this.controls.target.copy(target);
    this.controls.maxDistance = (this.layout?.size ?? 100) * 6 + 200;
    if (on) {
      this.controls.enableRotate = true;
      this.controls.minPolarAngle = this.controls.maxPolarAngle = MathUtils.degToRad(54.736);
    }
    this.renderPass.camera = this.camera;
    this.resize();
  }

  get isometric() {
    return this.camera === this.ortho;
  }

  private fitOrtho(radius: number) {
    const aspect = this.container.clientWidth / Math.max(1, this.container.clientHeight);
    const h = radius * 1.25;
    this.ortho.left = -h * aspect;
    this.ortho.right = h * aspect;
    this.ortho.top = h;
    this.ortho.bottom = -h;
    this.ortho.zoom = 1;
    this.ortho.updateProjectionMatrix();
  }

  /** World → CSS pixel coordinates (null when behind the camera). */
  project(v: Vector3): { x: number; y: number } | null {
    const p = v.clone().project(this.camera);
    if (p.z > 1 || p.z < -1) return null;
    return { x: (p.x * 0.5 + 0.5) * this.container.clientWidth, y: (-p.y * 0.5 + 0.5) * this.container.clientHeight };
  }

  /** Pixels per world unit at a point (for label culling). */
  pixelScale(at: Vector3): number {
    if (this.camera instanceof OrthographicCamera) return (this.container.clientHeight / (this.ortho.top - this.ortho.bottom)) * this.ortho.zoom;
    const dist = this.camera.position.distanceTo(at);
    return this.container.clientHeight / (2 * Math.tan(MathUtils.degToRad(this.perspective.fov) / 2) * dist);
  }

  /** Right edge (CSS px) of the part of the canvas not covered by a panel. */
  get visibleRight(): number {
    return this.container.clientWidth - this.inset.target;
  }

  setInsetRight(px: number) {
    this.inset.target = px;
  }

  private applyInset() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const px = Math.round(this.inset.current);
    for (const cam of [this.perspective, this.ortho]) {
      if (px > 0) cam.setViewOffset(w + px, h, px, 0, w, h);
      else cam.clearViewOffset();
    }
    if (px > 0) {
      // setViewOffset widens the full frame: keep the perspective aspect of the full frame.
      this.perspective.aspect = (w + px) / h;
      this.perspective.updateProjectionMatrix();
    }
  }

  setBloom(on: boolean) {
    this.bloomEnabled = on;
  }

  private bindPointer() {
    const el = this.renderer.domElement;
    el.addEventListener("pointermove", (e) => {
      this.hoverPending = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener("pointerleave", () => {
      this.hoverPending = null;
      if (this.lastHover) {
        this.lastHover = "";
        this.onHover(null, 0, 0);
      }
    });
    el.addEventListener("pointerdown", (e) => this.pointerDown.set(e.clientX, e.clientY));
    el.addEventListener("click", (e) => {
      if (this.pointerDown.distanceTo(new Vector2(e.clientX, e.clientY)) > 5) return;
      this.onClick(this.pick(e.clientX, e.clientY), e);
    });
  }

  pick(clientX: number, clientY: number): Pick {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    if (this.towers) {
      const hit = this.raycaster.intersectObject(this.towers, false)[0];
      if (hit?.instanceId !== undefined) return { kind: "file", id: this.instanceFile[hit.instanceId] };
    }
    if (this.platforms) {
      const hits = this.raycaster.intersectObject(this.platforms, false);
      // The highest (deepest-level) platform under the pointer.
      let best: { level: number; dir: string } | null = null;
      for (const h of hits) {
        if (h.instanceId === undefined) continue;
        const p = this.layout!.platforms[h.instanceId];
        if (!best || p.level > best.level) best = { level: p.level, dir: p.dir };
      }
      if (best) return { kind: "dir", path: best.dir };
    }
    return null;
  }

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.perspective.aspect = w / h;
    this.perspective.updateProjectionMatrix();
    const halfH = (this.ortho.top - this.ortho.bottom) / 2;
    this.ortho.left = -halfH * (w / h);
    this.ortho.right = halfH * (w / h);
    this.ortho.updateProjectionMatrix();
    this.applyInset();
  }

  private frame() {
    if (this.disposed) return;
    const now = performance.now();
    if (!this.perf.done && this.towers) {
      if (this.perf.frames === 0) this.perf.start = now;
      if (++this.perf.frames === 90) {
        this.perf.done = true;
        if ((now - this.perf.start) / 89 > 40) {
          this.renderer.setPixelRatio(1);
          this.resize();
          this.onLowPerformance();
        }
      }
    }
    const time = (now - this.clockStart) / 1000;
    if (this.flight) {
      const k = Math.min(1, (now - this.flight.start) / this.flight.ms);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.camera.position.lerpVectors(this.flight.from, this.flight.to, e);
      this.controls.target.lerpVectors(this.flight.tFrom, this.flight.tTo, e);
      if (k >= 1) this.flight = null;
    }
    if (Math.abs(this.inset.target - this.inset.current) > 0.5) {
      this.inset.current += (this.inset.target - this.inset.current) * 0.18;
      if (Math.abs(this.inset.target - this.inset.current) <= 0.5) this.inset.current = this.inset.target;
      this.resize();
    }
    this.controls.update();
    const dist = this.camera.position.distanceTo(this.controls.target);
    const span = this.layout ? this.layout.size : 100;
    for (const m of [this.towerMat, this.platformMat, this.gridMat] as ShaderMaterial[]) {
      m.uniforms.uFogNear.value = dist * 0.8 + span * 0.2;
      m.uniforms.uFogFar.value = dist * 2.2 + span * 1.2;
    }
    this.towerMat.uniforms.uTime.value = time;
    this.arcs.tick(time);
    if (this.hoverPending) {
      const { x, y } = this.hoverPending;
      this.hoverPending = null;
      const pick = this.pick(x, y);
      const key = pick ? (pick.kind === "file" ? `f${pick.id}` : `d${pick.path}`) : "";
      if (key !== this.lastHover || pick) {
        this.lastHover = key;
        this.onHover(pick, x, y);
      }
    }
    this.onFrame();
    if (this.bloomEnabled) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.clearMeshes();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

export { Color };
