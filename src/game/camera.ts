import { FreeCamera, Scene, Vector3, Quaternion } from "@babylonjs/core";

/**
 * Simple chase camera: smoothly trails a target's position + yaw.
 * No mouse/keyboard control to avoid stealing input.
 */
export class FollowCamera {
  readonly camera: FreeCamera;
  private smoothedPos = new Vector3();
  private smoothedTarget = new Vector3();
  private initialized = false;

  // Tunables
  private distance = 7.5;
  private height = 3.0;
  private targetHeight = 1.2;
  private posLerp = 6; // higher = snappier
  private tgtLerp = 9;

  constructor(scene: Scene, canvas: HTMLCanvasElement) {
    this.camera = new FreeCamera("chase", new Vector3(0, 5, -10), scene);
    this.camera.fov = 0.9;
    this.camera.minZ = 0.1;
    this.camera.maxZ = 1500;
    // Don't capture input — driving uses keyboard directly.
    this.camera.detachControl();
    void canvas;
  }

  update(dt: number, targetPos: Vector3, targetQ: Quaternion): void {
    const yaw = quaternionYaw(targetQ);
    const back = new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));

    const desiredPos = new Vector3(
      targetPos.x + back.x * this.distance,
      targetPos.y + this.height,
      targetPos.z + back.z * this.distance,
    );
    const desiredTarget = new Vector3(
      targetPos.x,
      targetPos.y + this.targetHeight,
      targetPos.z,
    );

    if (!this.initialized) {
      this.smoothedPos.copyFrom(desiredPos);
      this.smoothedTarget.copyFrom(desiredTarget);
      this.initialized = true;
    } else {
      const tp = 1 - Math.exp(-this.posLerp * dt);
      const tt = 1 - Math.exp(-this.tgtLerp * dt);
      this.smoothedPos.x += (desiredPos.x - this.smoothedPos.x) * tp;
      this.smoothedPos.y += (desiredPos.y - this.smoothedPos.y) * tp;
      this.smoothedPos.z += (desiredPos.z - this.smoothedPos.z) * tp;
      this.smoothedTarget.x += (desiredTarget.x - this.smoothedTarget.x) * tt;
      this.smoothedTarget.y += (desiredTarget.y - this.smoothedTarget.y) * tt;
      this.smoothedTarget.z += (desiredTarget.z - this.smoothedTarget.z) * tt;
    }

    this.camera.position.copyFrom(this.smoothedPos);
    this.camera.setTarget(this.smoothedTarget);
  }
}

function quaternionYaw(q: Quaternion): number {
  const siny = 2 * (q.w * q.y + q.x * q.z);
  const cosy = 1 - 2 * (q.y * q.y + q.x * q.x);
  return Math.atan2(siny, cosy);
}
