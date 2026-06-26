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
import type { Vec2 } from "./spline";

/**
 * Top-down pointer-based track drawing.
 *
 * Usage:
 *   const designer = new TrackDesigner(scene, engine, canvas);
 *   designer.activate(); // shows top-down view, enables drawing
 *   ...
 *   const points = designer.deactivate(); // returns drawn polyline in world XZ
 *
 * Interaction:
 *   - mouse down: start a new stroke (clears previous)
 *   - drag: append points
 *   - mouse up: stroke complete
 *   - the preview line is rebuilt live so the player can see what they drew
 */
export class TrackDesigner {
  private camera: ArcRotateCamera | null = null;
  private prevCamera: import("@babylonjs/core").Camera | null = null;
  private points: Vec2[] = [];
  private drawing = false;
  private previewLine: LinesMesh | null = null;
  private startMarker: Mesh | null = null;
  private endMarker: Mesh | null = null;
  private groupNode: TransformNode;
  private mat: StandardMaterial;
  private markerStartMat: StandardMaterial;
  private markerEndMat: StandardMaterial;
  private active = false;

  // Plane y=0 used to project mouse rays onto the ground.
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
    this.mat = new StandardMaterial("designer.line", scene);
    this.mat.diffuseColor = new Color3(0.15, 0.18, 0.22);
    this.mat.emissiveColor = new Color3(0.1, 0.1, 0.12);
    this.mat.specularColor = new Color3(0, 0, 0);

    this.markerStartMat = new StandardMaterial("designer.start", scene);
    this.markerStartMat.diffuseColor = new Color3(0.2, 0.8, 0.3);
    this.markerStartMat.emissiveColor = new Color3(0.05, 0.3, 0.1);

    this.markerEndMat = new StandardMaterial("designer.end", scene);
    this.markerEndMat.diffuseColor = new Color3(0.9, 0.3, 0.2);
    this.markerEndMat.emissiveColor = new Color3(0.3, 0.05, 0.05);
  }

  activate(): void {
    if (this.active) return;
    this.active = true;
    this.prevCamera = this.scene.activeCamera;

    const cam = new ArcRotateCamera(
      "designer.cam",
      -Math.PI / 2, // alpha: look down +Z axis (irrelevant since beta=0 -> from above)
      0.001, // beta near 0: looking straight down
      200, // radius (height above ground)
      new Vector3(0, 0, 0),
      this.scene,
    );
    cam.minZ = 0.1;
    cam.maxZ = 2000;
    cam.upperBetaLimit = 0.05;
    cam.lowerBetaLimit = 0.0;
    cam.lowerRadiusLimit = 30;
    cam.upperRadiusLimit = 600;
    cam.panningSensibility = 0; // we steal left-button for drawing
    // Keep mouse wheel for zoom, disable rotation entirely.
    cam.inputs.removeByType("ArcRotateCameraPointersInput");
    this.camera = cam;
    this.scene.activeCamera = cam;

    this.canvas.addEventListener("pointerdown", this.onDown);
    this.canvas.addEventListener("pointermove", this.onMove);
    this.canvas.addEventListener("pointerup", this.onUp);
    this.canvas.addEventListener("pointercancel", this.onUp);
  }

  deactivate(): ReadonlyArray<Vec2> {
    if (!this.active) return this.points;
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
    return this.points;
  }

  hasUsableStroke(): boolean {
    return this.points.length >= 2;
  }

  clear(): void {
    this.points = [];
    this.drawing = false;
    this.clearPreview();
  }

  private clearPreview(): void {
    if (this.previewLine) {
      this.previewLine.dispose();
      this.previewLine = null;
    }
    if (this.startMarker) {
      this.startMarker.dispose();
      this.startMarker = null;
    }
    if (this.endMarker) {
      this.endMarker.dispose();
      this.endMarker = null;
    }
  }

  private onDown = (ev: PointerEvent): void => {
    if (ev.button !== 0) return;
    const hit = this.screenToGround(ev);
    if (!hit) return;
    this.drawing = true;
    this.points = [hit];
    this.rebuildPreview();
    this.canvas.setPointerCapture(ev.pointerId);
  };

  private onMove = (ev: PointerEvent): void => {
    if (!this.drawing) return;
    const hit = this.screenToGround(ev);
    if (!hit) return;
    // Lightweight client-side dedupe to keep preview cheap.
    const last = this.points[this.points.length - 1];
    if (last && Math.hypot(last.x - hit.x, last.z - hit.z) < 0.5) return;
    this.points.push(hit);
    this.rebuildPreview();
  };

  private onUp = (ev: PointerEvent): void => {
    this.drawing = false;
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

  private rebuildPreview(): void {
    if (this.previewLine) {
      this.previewLine.dispose();
      this.previewLine = null;
    }
    if (this.points.length < 2) {
      this.updateMarkers();
      return;
    }
    const pts = this.points.map((p) => new Vector3(p.x, 0.1, p.z));
    this.previewLine = MeshBuilder.CreateLines("designer.preview", { points: pts }, this.scene);
    this.previewLine.color = new Color3(0.15, 0.18, 0.22);
    this.previewLine.isPickable = false;
    this.previewLine.parent = this.groupNode;
    this.updateMarkers();
  }

  private updateMarkers(): void {
    if (this.startMarker) this.startMarker.dispose();
    if (this.endMarker) this.endMarker.dispose();
    this.startMarker = null;
    this.endMarker = null;

    if (this.points.length === 0) return;
    this.startMarker = this.makeMarker(this.points[0], this.markerStartMat);
    if (this.points.length > 1) {
      this.endMarker = this.makeMarker(this.points[this.points.length - 1], this.markerEndMat);
    }
  }

  private makeMarker(p: Vec2, mat: StandardMaterial): Mesh {
    const m = MeshBuilder.CreateDisc(
      "designer.marker",
      { radius: 1.2, tessellation: 16 },
      this.scene,
    );
    m.rotation.x = Math.PI / 2;
    m.position.set(p.x, 0.05, p.z);
    m.material = mat;
    m.isPickable = false;
    m.parent = this.groupNode;
    return m;
  }

  dispose(): void {
    this.deactivate();
    this.groupNode.dispose();
    this.mat.dispose();
    this.markerStartMat.dispose();
    this.markerEndMat.dispose();
    void this.engine; // currently unused but kept for future viewport tweaks
  }
}
