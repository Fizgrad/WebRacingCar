import {
  ArcRotateCamera,
  Vector3,
  Scene,
  Engine,
  Plane,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  Color3,
  LinesMesh,
  TransformNode,
} from "@babylonjs/core";
import { catmullRom, laplacianSmooth, resampleByArcLength, type Vec2 } from "./spline";

export class TrackDesigner {
  private camera: ArcRotateCamera | null = null;
  private prevCamera: import("@babylonjs/core").Camera | null = null;
  private points: Vec2[] = [];
  private previewLine: LinesMesh | null = null;
  private markers: Mesh[] = [];
  private groupNode: TransformNode;
  private markerStartMat: StandardMaterial;
  private markerMidMat: StandardMaterial;
  private markerEndMat: StandardMaterial;
  private active = false;
  private draggingIndex: number | null = null;
  private curve = 0.65;
  private closed = false;
  private segmentMode: "curve" | "line" = "curve";

  private static readonly GROUND_PLANE = Plane.FromPositionAndNormal(
    new Vector3(0, 0, 0),
    new Vector3(0, 1, 0),
  );

  constructor(
    private scene: Scene,
    private engine: Engine,
    private canvas: HTMLCanvasElement,
  ) {
    this.groupNode = new TransformNode("designer.root", scene);

    this.markerStartMat = new StandardMaterial("designer.start", scene);
    this.markerStartMat.diffuseColor = new Color3(0.2, 0.8, 0.3);
    this.markerStartMat.emissiveColor = new Color3(0.05, 0.3, 0.1);

    this.markerMidMat = new StandardMaterial("designer.mid", scene);
    this.markerMidMat.diffuseColor = new Color3(0.18, 0.35, 0.95);
    this.markerMidMat.emissiveColor = new Color3(0.03, 0.08, 0.25);

    this.markerEndMat = new StandardMaterial("designer.end", scene);
    this.markerEndMat.diffuseColor = new Color3(0.9, 0.3, 0.2);
    this.markerEndMat.emissiveColor = new Color3(0.3, 0.05, 0.05);
  }

  activate(): void {
    if (this.active) return;
    this.active = true;
    this.prevCamera = this.scene.activeCamera;

    const cam = new ArcRotateCamera("designer.cam", -Math.PI / 2, 0.001, 200, new Vector3(0, 0, 0), this.scene);
    cam.minZ = 0.1;
    cam.maxZ = 2000;
    cam.upperBetaLimit = 0.05;
    cam.lowerBetaLimit = 0.0;
    cam.lowerRadiusLimit = 30;
    cam.upperRadiusLimit = 600;
    cam.panningSensibility = 0;
    cam.inputs.removeByType("ArcRotateCameraPointersInput");
    this.camera = cam;
    this.scene.activeCamera = cam;

    this.canvas.addEventListener("pointerdown", this.onDown);
    this.canvas.addEventListener("pointermove", this.onMove);
    this.canvas.addEventListener("pointerup", this.onUp);
    this.canvas.addEventListener("pointercancel", this.onUp);
  }

  deactivate(): ReadonlyArray<Vec2> {
    if (!this.active) return this.buildPath();
    this.active = false;

    this.canvas.removeEventListener("pointerdown", this.onDown);
    this.canvas.removeEventListener("pointermove", this.onMove);
    this.canvas.removeEventListener("pointerup", this.onUp);
    this.canvas.removeEventListener("pointercancel", this.onUp);

    if (this.camera) {
      this.camera.dispose();
      this.camera = null;
    }
    if (this.prevCamera) this.scene.activeCamera = this.prevCamera;

    this.clearPreview();
    return this.buildPath();
  }

  hasUsableStroke(): boolean {
    return this.points.length >= 2;
  }

  clear(): void {
    this.points = [];
    this.draggingIndex = null;
    this.clearPreview();
  }

  setCurve(value: number): void {
    this.curve = Math.max(0, Math.min(1, value));
    this.rebuildPreview();
  }

  setClosed(value: boolean): void {
    this.closed = value;
    this.rebuildPreview();
  }

  setSegmentMode(value: "curve" | "line"): void {
    this.segmentMode = value;
    this.rebuildPreview();
  }

  isClosed(): boolean {
    return this.closed && this.points.length >= 3;
  }

  keyPointCount(): number {
    return this.points.length;
  }

  scaleText(): string {
    const r = this.camera?.radius ?? 200;
    return `view ${(r * 2).toFixed(0)} m`;
  }

  statsText(): string {
    const path = this.buildPath();
    const len = pathLength(path);
    const minR = minTurnRadius(path);
    const warning = minR < 18 && path.length >= 3 ? ` · narrow turn ${minR.toFixed(0)} m` : "";
    return `${this.points.length} points · ${this.segmentMode}${this.isClosed() ? " · closed" : ""} · ${len.toFixed(0)} m${warning} · ${this.scaleText()}`;
  }

  private onDown = (ev: PointerEvent): void => {
    if (ev.button !== 0) return;
    const hit = this.screenToGround(ev);
    if (!hit) return;
    const nearest = this.findPoint(hit, Math.max(4, (this.camera?.radius ?? 200) * 0.025));
    if (nearest >= 0) {
      this.draggingIndex = nearest;
    } else {
      this.points.push(hit);
      this.draggingIndex = this.points.length - 1;
      this.rebuildPreview();
    }
    this.canvas.setPointerCapture(ev.pointerId);
  };

  private onMove = (ev: PointerEvent): void => {
    if (this.draggingIndex == null) return;
    const hit = this.screenToGround(ev);
    if (!hit) return;
    this.points[this.draggingIndex] = hit;
    this.rebuildPreview();
  };

  private onUp = (ev: PointerEvent): void => {
    this.draggingIndex = null;
    try {
      this.canvas.releasePointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
  };

  private screenToGround(ev: PointerEvent): Vec2 | null {
    const cam = this.camera;
    if (!cam) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const ray = this.scene.createPickingRay(x, y, null, cam);
    const t = ray.intersectsPlane(TrackDesigner.GROUND_PLANE);
    if (t == null) return null;
    const p = ray.origin.add(ray.direction.scale(t));
    return { x: p.x, z: p.z };
  }

  private findPoint(p: Vec2, radius: number): number {
    let best = -1;
    let bestD = radius * radius;
    for (let i = 0; i < this.points.length; i++) {
      const dx = this.points[i].x - p.x;
      const dz = this.points[i].z - p.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private buildPath(): Vec2[] {
    const controls = this.isClosed() ? [...this.points, this.points[0]] : this.points;
    if (controls.length < 3 || this.curve <= 0.02 || this.segmentMode === "line") {
      return controls.map((p) => ({ x: p.x, z: p.z }));
    }
    const sampled = catmullRom(controls, 10 + Math.round(this.curve * 18));
    const step = Math.max(0.8, 4 - this.curve * 3);
    const resampled = resampleByArcLength(sampled, step);
    return laplacianSmooth(resampled, this.curve * 0.35, Math.round(2 + this.curve * 6));
  }

  private rebuildPreview(): void {
    this.clearLine();
    const path = this.buildPath();
    if (path.length >= 2) {
      const pts = path.map((p) => new Vector3(p.x, 0.12, p.z));
      this.previewLine = MeshBuilder.CreateLines("designer.preview", { points: pts }, this.scene);
      this.previewLine.color = new Color3(0.15, 0.18, 0.22);
      this.previewLine.isPickable = false;
      this.previewLine.parent = this.groupNode;
    }
    this.rebuildMarkers();
  }

  private clearLine(): void {
    if (this.previewLine) {
      this.previewLine.dispose();
      this.previewLine = null;
    }
  }

  private clearPreview(): void {
    this.clearLine();
    for (const m of this.markers) m.dispose();
    this.markers = [];
  }

  private rebuildMarkers(): void {
    for (const m of this.markers) m.dispose();
    this.markers = [];
    for (let i = 0; i < this.points.length; i++) {
      const mat = i === 0 ? this.markerStartMat : i === this.points.length - 1 ? this.markerEndMat : this.markerMidMat;
      const m = MeshBuilder.CreateDisc("designer.marker", { radius: 1.35, tessellation: 16 }, this.scene);
      m.rotation.x = Math.PI / 2;
      m.position.set(this.points[i].x, 0.16, this.points[i].z);
      m.material = mat;
      m.isPickable = false;
      m.parent = this.groupNode;
      this.markers.push(m);
    }
  }

  dispose(): void {
    this.deactivate();
    this.groupNode.dispose();
    this.markerStartMat.dispose();
    this.markerMidMat.dispose();
    this.markerEndMat.dispose();
    void this.engine;
  }
}

function pathLength(points: ReadonlyArray<Vec2>): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  }
  return total;
}

function minTurnRadius(points: ReadonlyArray<Vec2>): number {
  let best = Infinity;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    const ab = Math.hypot(b.x - a.x, b.z - a.z);
    const bc = Math.hypot(c.x - b.x, c.z - b.z);
    const ac = Math.hypot(c.x - a.x, c.z - a.z);
    const area2 = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
    if (area2 < 1e-4) continue;
    const r = (ab * bc * ac) / (2 * area2);
    if (r < best) best = r;
  }
  return Number.isFinite(best) ? best : Infinity;
}
