import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
} from "@babylonjs/core";
import type { Vec2 } from "../track/spline";

interface GhostSample {
  t: number;
  x: number;
  z: number;
  yaw: number;
}

export interface RaceSnapshot {
  enabled: boolean;
  lap: number;
  checkpoint: number;
  checkpointCount: number;
  currentLapMs: number;
  bestLapMs: number | null;
}

export class RaceTimer {
  private readonly enabled: boolean;
  private readonly checkpointIndices: number[];
  private nextCheckpoint = 1;
  private lap = 0;
  private lapTimeMs = 0;
  private bestLapMs: number | null = null;
  private currentSamples: GhostSample[] = [];
  private bestSamples: GhostSample[] = [];
  private ghost: Mesh | null = null;
  private ghostMat: StandardMaterial | null = null;

  constructor(private scene: Scene, private centerline: ReadonlyArray<Vec2>, closed: boolean) {
    this.enabled = closed && centerline.length >= 32;
    this.checkpointIndices = this.enabled
      ? [0, Math.floor(centerline.length * 0.25), Math.floor(centerline.length * 0.5), Math.floor(centerline.length * 0.75)]
      : [];
    if (this.enabled) this.buildGhost();
  }

  update(car: { x: number; z: number; yaw: number }, dt: number): void {
    if (!this.enabled) return;
    this.lapTimeMs += dt * 1000;
    this.currentSamples.push({ t: this.lapTimeMs, x: car.x, z: car.z, yaw: car.yaw });

    const nearest = nearestIndex(car.x, car.z, this.centerline);
    const target = this.checkpointIndices[this.nextCheckpoint];
    if (cyclicIndexDistance(nearest, target, this.centerline.length) < 16) {
      this.nextCheckpoint += 1;
      if (this.nextCheckpoint >= this.checkpointIndices.length) this.nextCheckpoint = 0;
    }

    if (this.nextCheckpoint === 0 && cyclicIndexDistance(nearest, 0, this.centerline.length) < 16 && this.lapTimeMs > 8000) {
      this.finishLap();
    }

    this.updateGhost();
  }

  snapshot(): RaceSnapshot {
    return {
      enabled: this.enabled,
      lap: this.lap + 1,
      checkpoint: this.enabled ? this.nextCheckpoint : 0,
      checkpointCount: this.checkpointIndices.length,
      currentLapMs: this.lapTimeMs,
      bestLapMs: this.bestLapMs,
    };
  }

  dispose(): void {
    this.ghost?.dispose();
    this.ghostMat?.dispose();
  }

  private finishLap(): void {
    this.lap += 1;
    if (this.bestLapMs == null || this.lapTimeMs < this.bestLapMs) {
      this.bestLapMs = this.lapTimeMs;
      this.bestSamples = this.currentSamples.slice();
    }
    this.currentSamples = [];
    this.lapTimeMs = 0;
    this.nextCheckpoint = 1;
  }

  private buildGhost(): void {
    this.ghostMat = new StandardMaterial("race.ghost.mat", this.scene);
    this.ghostMat.diffuseColor = new Color3(0.4, 0.8, 1.0);
    this.ghostMat.emissiveColor = new Color3(0.1, 0.25, 0.35);
    this.ghostMat.alpha = 0.38;
    this.ghost = MeshBuilder.CreateBox("race.ghost", { width: 1.8, height: 0.55, depth: 4.0 }, this.scene);
    this.ghost.material = this.ghostMat;
    this.ghost.isVisible = false;
    this.ghost.isPickable = false;
  }

  private updateGhost(): void {
    if (!this.ghost || this.bestSamples.length < 2 || this.bestLapMs == null) return;
    if (this.lapTimeMs > this.bestLapMs) {
      this.ghost.isVisible = false;
      return;
    }
    const t = this.lapTimeMs;
    let i = 1;
    while (i < this.bestSamples.length && this.bestSamples[i].t < t) i += 1;
    const a = this.bestSamples[Math.max(0, i - 1)];
    const b = this.bestSamples[Math.min(this.bestSamples.length - 1, i)];
    const span = Math.max(1, b.t - a.t);
    const k = Math.max(0, Math.min(1, (t - a.t) / span));
    const x = a.x + (b.x - a.x) * k;
    const z = a.z + (b.z - a.z) * k;
    const yaw = lerpAngle(a.yaw, b.yaw, k);
    this.ghost.position.set(x, 0.55, z);
    this.ghost.rotation.y = yaw;
    this.ghost.isVisible = true;
  }
}

export function formatLap(ms: number | null): string {
  if (ms == null) return "--:--.---";
  const total = Math.max(0, Math.floor(ms));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${millis.toString().padStart(3, "0")}`;
}

function nearestIndex(x: number, z: number, line: ReadonlyArray<Vec2>): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < line.length; i++) {
    const dx = line[i].x - x;
    const dz = line[i].z - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function cyclicIndexDistance(a: number, b: number, n: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, n - d);
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

