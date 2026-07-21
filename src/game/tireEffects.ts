import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
} from "@babylonjs/core";

export class TireEffects {
  private markMat: StandardMaterial;
  private smokeMat: StandardMaterial;
  private marks: Mesh[] = [];
  private smokes: Mesh[] = [];
  private cooldown = 0;

  constructor(private scene: Scene) {
    this.markMat = new StandardMaterial("tire.mark.mat", scene);
    this.markMat.diffuseColor = new Color3(0.05, 0.055, 0.06);
    this.markMat.emissiveColor = new Color3(0.01, 0.01, 0.012);
    this.markMat.alpha = 0.45;
    this.markMat.zOffset = -5;

    this.smokeMat = new StandardMaterial("tire.smoke.mat", scene);
    this.smokeMat.diffuseColor = new Color3(0.78, 0.78, 0.74);
    this.smokeMat.emissiveColor = new Color3(0.16, 0.16, 0.15);
    this.smokeMat.alpha = 0.32;
  }

  update(pos: { x: number; z: number }, yaw: number, slip: number, speedMs: number, dt: number): void {
    this.cooldown -= dt;
    if (slip > 0.32 && speedMs > 7 && this.cooldown <= 0) {
      this.spawnMark(pos.x, pos.z, yaw, Math.min(1, slip));
      if (slip > 0.55) this.spawnSmoke(pos.x, pos.z, yaw);
      if (navigator.vibrate && slip > 0.6) navigator.vibrate(25);
      this.cooldown = 0.045;
    }

    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const s = this.smokes[i];
      s.position.y += dt * 0.8;
      s.scaling.x += dt * 0.8;
      s.scaling.y += dt * 0.8;
      s.scaling.z += dt * 0.8;
      s.visibility -= dt * 0.7;
      if (s.visibility <= 0) {
        s.dispose();
        this.smokes.splice(i, 1);
      }
    }
  }

  clear(): void {
    for (const m of this.marks) m.dispose();
    for (const s of this.smokes) s.dispose();
    this.marks = [];
    this.smokes = [];
    this.cooldown = 0;
  }

  dispose(): void {
    this.clear();
    this.markMat.dispose();
    this.smokeMat.dispose();
  }

  private spawnMark(x: number, z: number, yaw: number, intensity: number): void {
    const mark = MeshBuilder.CreatePlane("tire.mark", { width: 0.45, height: 2.2 + intensity * 1.8 }, this.scene);
    mark.rotation.x = Math.PI / 2;
    mark.rotation.y = yaw;
    mark.position.set(x, 0.075, z);
    mark.material = this.markMat;
    mark.isPickable = false;
    mark.visibility = 0.25 + intensity * 0.35;
    this.marks.push(mark);
    if (this.marks.length > 260) this.marks.shift()?.dispose();
  }

  private spawnSmoke(x: number, z: number, yaw: number): void {
    const backX = -Math.sin(yaw) * 1.5;
    const backZ = -Math.cos(yaw) * 1.5;
    const smoke = MeshBuilder.CreateSphere("tire.smoke", { diameter: 0.8, segments: 4 }, this.scene);
    smoke.position.set(x + backX, 0.45, z + backZ);
    smoke.scaling.set(0.6, 0.35, 0.6);
    smoke.material = this.smokeMat;
    smoke.isPickable = false;
    smoke.visibility = 0.55;
    this.smokes.push(smoke);
    if (this.smokes.length > 80) this.smokes.shift()?.dispose();
  }
}

