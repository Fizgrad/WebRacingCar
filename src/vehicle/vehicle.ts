import {
  TransformNode,
  Vector3,
  Quaternion,
  Mesh,
  MeshBuilder,
  StandardMaterial,
} from "@babylonjs/core";
import RAPIER from "@dimforge/rapier3d-compat";
import type { RenderContext } from "../render/scene";
import type { PhysicsWorld } from "../physics/world";
import type { InputState } from "../game/input";
import type { CarSpec } from "./cars";

/**
 * Generic vehicle: chassis rigid body + 4 raycast wheels with a Pacejka-lite
 * tire model. Behaviour is fully driven by the `CarSpec` argument so adding
 * new cars is a data change.
 *
 * Right-handed: +Y up, +Z forward, +X right. Meters / kg / seconds / radians.
 */

interface WheelConfig {
  localPos: Vector3;
  steers: boolean;
  drives: boolean;
  brakes: boolean;
  radius: number;
}

interface Wheel {
  cfg: WheelConfig;
  mesh: Mesh;
  grounded: boolean;
  compression: number;
  lastSuspensionForce: number;
  lastSpringLen: number;
  lastSteerAngle: number;
}

export interface Vehicle {
  body: RAPIER.RigidBody;
  root: TransformNode;
  speedKmh(): number;
  /** Average lateral tyre slip 0–1 across all 4 wheels (for audio cues). */
  tireSlip: number;
  reset(position: Vector3, yaw: number): void;
  update(dt: number, input: InputState): void;
  syncRender(): void;
  dispose(): void;
  debug: VehicleDebug;
}

export interface VehicleDebug {
  wheels: Array<{
    grounded: boolean;
    contactDist: number;
    springLen: number;
    compression: number;
    compressionRate: number;
    suspensionForce: number;
    attachY: number;
  }>;
}

export function createVehicle(
  ctx: RenderContext,
  phys: PhysicsWorld,
  spawn: { position: Vector3; yaw: number },
  spec: CarSpec,
): Vehicle {
  const { scene, materials } = ctx;
  const { world, rapier } = phys;

  const RAY_LENGTH =
    spec.suspensionRest +
    spec.suspensionTravel +
    Math.max(spec.wheelRadiusFront, spec.wheelRadiusRear) +
    0.10;

  // ── rigid body ──
  const bodyDesc = rapier.RigidBodyDesc.dynamic()
    .setTranslation(spawn.position.x, spawn.position.y, spawn.position.z)
    .setLinearDamping(spec.linearDamping)
    .setAngularDamping(spec.angularDamping)
    .setCanSleep(false);
  const body = world.createRigidBody(bodyDesc);
  setYaw(body, spawn.yaw);

  const half = spec.chassisHalf;
  const chassisVolume = half.x * 2 * half.y * 2 * half.z * 2;
  const chassisDensity = spec.mass / chassisVolume;
  const colDesc = rapier.ColliderDesc.cuboid(half.x, half.y, half.z)
    .setDensity(chassisDensity)
    .setFriction(0.4)
    .setRestitution(0.03);
  world.createCollider(colDesc, body);

  // ── visual ──
  const root = new TransformNode(`${spec.id}.root`, scene);
  spec.buildVisual(root, scene, materials, spec);

  // Shadow disc.
  const shadow = MeshBuilder.CreateDisc(
    `${spec.id}.shadow`,
    { radius: 1.8, tessellation: 24 },
    scene,
  );
  shadow.rotation.x = Math.PI / 2;
  shadow.material = materials.shadow;

  // ── wheels ──
  const w = spec.wheelLocalPos;
  const wheelConfigs: WheelConfig[] = [
    { localPos: new Vector3(+w.frontX, w.y, +w.frontZ), steers: true,  drives: false, brakes: true, radius: spec.wheelRadiusFront },
    { localPos: new Vector3(-w.frontX, w.y, +w.frontZ), steers: true,  drives: false, brakes: true, radius: spec.wheelRadiusFront },
    { localPos: new Vector3(+w.rearX,  w.y, -w.rearZ),  steers: false, drives: true,  brakes: true, radius: spec.wheelRadiusRear },
    { localPos: new Vector3(-w.rearX,  w.y, -w.rearZ),  steers: false, drives: true,  brakes: true, radius: spec.wheelRadiusRear },
  ];

  const wheels: Wheel[] = wheelConfigs.map((cfg, i) => {
    const isRearWheel = cfg.localPos.z < 0;
    const visualWidth = isRearWheel ? 0.31 : 0.25;
    const mesh = MeshBuilder.CreateCylinder(
      `${spec.id}.wheel.${i}`,
      { diameter: cfg.radius * 2, height: visualWidth, tessellation: 20 },
      scene,
    );
    mesh.material = materials.carDark;
    mesh.rotation.z = Math.PI / 2;
    mesh.bakeCurrentTransformIntoVertices();
    return {
      cfg, mesh,
      grounded: false, compression: 0, lastSuspensionForce: 0,
      lastSpringLen: spec.suspensionRest, lastSteerAngle: 0,
    };
  });

  // ── scratch ──
  const tmpQ = new Quaternion();
  const tmpV = new Vector3();
  const tmpWv = new Vector3();
  const tmpFwd = new Vector3();
  const tmpRight = new Vector3();

  // Smoothed throttle/brake so taps don't jolt the body.
  let throttleSmoothed = 0;
  let brakeSmoothed = 0;

  function speedKmh(): number {
    const v = body.linvel();
    return Math.sqrt(v.x * v.x + v.z * v.z) * 3.6;
  }

  function reset(position: Vector3, yaw: number): void {
    body.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    body.resetForces(true);
    body.resetTorques(true);
    setYaw(body, yaw);
    throttleSmoothed = 0;
    brakeSmoothed = 0;
  }

  // ── per-frame force update ──
  function update(dt: number, input: InputState): void {
    if (dt <= 0) return;

    body.resetForces(false);
    body.resetTorques(false);

    const t = body.translation();
    const r = body.rotation();
    tmpQ.set(r.x, r.y, r.z, r.w);
    const forward = getBasisToRef(tmpQ, "z", new Vector3());
    const linvel = body.linvel();
    const angvel = body.angvel();
    const speed = Math.hypot(linvel.x, linvel.z); // m/s, planar

    // ── input smoothing ──
    // Throttle ramps in over ~150ms, brake over ~80ms. Releasing returns
    // faster than pressing so the car feels responsive.
    const thRate = input.throttle > throttleSmoothed ? 20 : 14;
    throttleSmoothed += (input.throttle - throttleSmoothed) * Math.min(1, thRate * dt);
    const brRate = input.brake > brakeSmoothed ? 22 : 22;
    brakeSmoothed += (input.brake - brakeSmoothed) * Math.min(1, brRate * dt);

    // ── speed-sensitive steering ──
    // At 0 km/h the driver gets full lock. At 200 km/h they get ~35% of it.
    // This is the single biggest "feels driveable" change — without it the
    // car snaps into a spin the instant you nudge the wheel above 80 km/h.
    const speedKmH = speed * 3.6;
    const steerScale = 1 / (1 + speedKmH / 110); // 1 @0, 0.5 @110, 0.35 @205
    const steerAngle = -input.steer * spec.maxSteer * steerScale;

    const nominalLoad = (spec.mass * 9.81) / 4;

    let slipSum = 0;
    let slipCount = 0;

    for (const wheel of wheels) {
      const cfg = wheel.cfg;

      // ── raycast suspension ──
      const attach = localToWorld(t, tmpQ, cfg.localPos, tmpV);
      const ray = new rapier.Ray(
        { x: attach.x, y: attach.y, z: attach.z },
        { x: 0, y: -1, z: 0 },
      );
      const hit = world.castRay(ray, RAY_LENGTH, true, undefined, undefined, undefined, body);

      let suspensionForce = 0;
      let springLen = spec.suspensionRest;
      let compression = 0;
      let compressionRate = 0;

      if (hit) {
        wheel.grounded = true;
        springLen = clamp(hit.timeOfImpact - cfg.radius, 0.02, spec.suspensionRest + spec.suspensionTravel);
        compression = clamp(spec.suspensionRest - springLen, 0, spec.suspensionTravel);
        wheel.compression = compression / spec.suspensionTravel;

        pointVelocityToRef(body, attach, linvel, angvel, tmpWv);
        compressionRate = -tmpWv.y;

        const springForce = spec.suspensionStiffness * compression;
        const nearRest = compression < 0.003 && Math.abs(tmpWv.y) < 0.08;
        const dampFactor = nearRest ? 0.2 : 1.0;
        const dampForce = compression > 0 ? spec.suspensionDamping * compressionRate * dampFactor : 0;
        suspensionForce = Math.max(0, springForce + dampForce);
        if (suspensionForce > 30000) suspensionForce = 30000;

        applyForceAt(body, { x: 0, y: suspensionForce, z: 0 }, attach);
      } else {
        wheel.grounded = false;
        wheel.compression = 0;
      }

      wheel.lastSpringLen = springLen;
      wheel.lastSteerAngle = steerAngle;
      wheel.lastSuspensionForce = suspensionForce;

      const dbg = debug.wheels[wheels.indexOf(wheel)];
      dbg.grounded = wheel.grounded;
      dbg.contactDist = hit ? hit.timeOfImpact : RAY_LENGTH;
      dbg.springLen = springLen;
      dbg.compression = wheel.compression;
      dbg.compressionRate = compressionRate;
      dbg.suspensionForce = suspensionForce;
      dbg.attachY = attach.y;

      if (!wheel.grounded) continue;

      // ── tire forces ──
      const isRear = cfg.localPos.z < 0;
      pointVelocityToRef(body, attach, linvel, angvel, tmpWv);
      const wheelForward = cfg.steers ? rotateAroundYToRef(forward, steerAngle, tmpFwd) : forward;
      const wheelRight = rotateAroundYToRef(wheelForward, -Math.PI / 2, tmpRight);
      const vFwd = dot(tmpWv, wheelForward);
      const vLat = dot(tmpWv, wheelRight);

      // ── dynamic load transfer ──
      // Under throttle the rear axle squats and gains grip; under braking the
      // front loads up. We bias the per-wheel load accordingly so an RWD car
      // can actually put its power down at launch.
      const throttleBias = throttleSmoothed - brakeSmoothed;
      const transfer = clamp(throttleBias, -0.5, 0.6);
      const loadScale = isRear ? (1 + 0.45 * transfer) : (1 - 0.45 * transfer);
      const load = nominalLoad * Math.max(0.45, loadScale);

      const muFront = spec.tireLatMaxMuFront;
      const muRear = spec.tireLatMaxMuRear;
      const hbScale = input.handbrake && isRear ? spec.handbrakeRearGrip : 1;
      const lateralMu = (isRear ? muRear : muFront) * hbScale;

      // ── lateral force: linear in slip ratio, smooth saturation ──
      // slipDenom of 3 m/s avoids divide-by-zero and gives stable lateral
      // force at parking speeds (no wobble when stationary).
      const slipDenom = Math.max(3.0, Math.abs(vFwd));
      const slip = -vLat / slipDenom;
      const wheelSlipAbs = Math.abs(vLat) / slipDenom;
      slipSum += wheelSlipAbs;
      slipCount += 1;

      const latLinear = spec.tireLatStiffness * load * slip;
      const latMax = lateralMu * load;
      // Soft clip: instead of a hard clamp at latMax, use tanh(latLinear/latMax)*latMax
      // so the tire saturates smoothly. Hard clip causes the "rubber-band" feel
      // where the car suddenly snaps when slip exceeds the limit.
      const latForce = latMax * Math.tanh(latLinear / Math.max(1, latMax));

      // ── longitudinal force ──
      let longForce = 0;
      if (cfg.drives) longForce += throttleSmoothed * (spec.engineForce / 2);
      if (cfg.brakes && brakeSmoothed > 0) {
        // Brake force opposes motion. Use vFwd directly so it can't reverse
        // the car when fully stopped (would jitter at zero crossing).
        const brakeTarget = brakeSmoothed * (spec.brakeForce / 4);
        longForce -= clamp(vFwd * 200, -brakeTarget, brakeTarget);
      }
      if (input.handbrake && isRear) {
        const hbTarget = spec.handbrakeForce / 2;
        longForce -= clamp(vFwd * 200, -hbTarget, hbTarget);
      }
      longForce -= Math.sign(vFwd) * spec.rollingResistance * load * Math.min(1, Math.abs(vFwd));

      const longMu = (isRear ? spec.tireLongMaxMuRear : muFront) *
        (input.handbrake && isRear ? 0.25 : 1);
      const longMax = longMu * load;

      // ── friction circle: ensure |F| ≤ μ·load combined ──
      // This single change kills almost all of the "snap-spin under throttle
      // in a corner" misery. If the tire is already saturated laterally,
      // longitudinal force is capped to whatever budget remains.
      const latUsage = Math.abs(latForce) / Math.max(1, latMax);
      const longBudget = longMax * Math.sqrt(Math.max(0, 1 - latUsage * latUsage));
      longForce = clamp(longForce, -longBudget, longBudget);

      applyForceAt(body, {
        x: wheelForward.x * longForce + wheelRight.x * latForce,
        y: 0,
        z: wheelForward.z * longForce + wheelRight.z * latForce,
      }, attach);
    }

    // ── stability assist: very light yaw-rate damping ──
    // Real cars have ESC; we add a small corrective torque only when the
    // driver is *not* actively counter-steering and the chassis is yawing
    // faster than the steering wheel asks for. The moment the driver flicks
    // the wheel against the spin, we get out of the way — otherwise we'd
    // cancel their counter-steer and make drifts uncontrollable.
    if (speed > 6) {
      const wheelbase = Math.abs(spec.wheelLocalPos.frontZ) + Math.abs(spec.wheelLocalPos.rearZ);
      const desiredYaw = (speed * Math.tan(steerAngle)) / wheelbase;
      const yawErr = angvel.y - desiredYaw;
      // Detect counter-steer: driver's steering input has the OPPOSITE sign
      // of the body's current yaw rate. In that case skip the assist
      // entirely so the player owns the slide.
      const counterSteering =
        Math.abs(angvel.y) > 0.4 &&
        Math.sign(input.steer) !== 0 &&
        Math.sign(input.steer) === Math.sign(angvel.y);
      if (!counterSteering) {
        const stabK = spec.mass * 0.06;
        const stabTorque = -yawErr * stabK;
        body.addTorque({ x: 0, y: stabTorque, z: 0 }, true);
      }
    }

    v.tireSlip = slipCount > 0 ? slipSum / slipCount : 0;
  }

  // ── post-step visual sync ──
  function syncRender(): void {
    const t = body.translation();
    const r = body.rotation();
    tmpQ.set(r.x, r.y, r.z, r.w);

    root.position.set(t.x, t.y, t.z);
    if (!root.rotationQuaternion) root.rotationQuaternion = new Quaternion();
    root.rotationQuaternion.copyFrom(tmpQ);

    shadow.position.set(t.x, 0.05, t.z);

    for (const wheel of wheels) {
      const attach = localToWorld(t, tmpQ, wheel.cfg.localPos, tmpV);
      placeWheelMesh(wheel, attach, tmpQ, wheel.lastSpringLen, wheel.lastSteerAngle);
    }
  }

  function dispose(): void {
    const ownedMats = collectOwnedVehicleMaterials(root);
    root.dispose(false, true);
    shadow.dispose();
    for (const wh of wheels) wh.mesh.dispose();
    for (const mat of ownedMats) mat.dispose();
    world.removeRigidBody(body);
  }

  // initial sync
  root.position.copyFrom(spawn.position);
  root.rotationQuaternion = Quaternion.RotationAxis(new Vector3(0, 1, 0), spawn.yaw);

  const debug: VehicleDebug = {
    wheels: wheels.map(() => ({
      grounded: false, contactDist: 0, springLen: 0,
      compression: 0, compressionRate: 0, suspensionForce: 0, attachY: 0,
    })),
  };

  const v: Vehicle = {
    body, root, speedKmh, reset, update, syncRender, dispose, debug,
    tireSlip: 0,
  };
  return v;
}

// ── helpers ────────────────────────────────────────────────────────────────

function collectOwnedVehicleMaterials(root: TransformNode): Set<StandardMaterial> {
  const mats = new Set<StandardMaterial>();
  for (const mesh of root.getChildMeshes(false)) {
    if (mesh.material instanceof StandardMaterial && isOwnedVehicleMaterial(mesh.material.name)) {
      mats.add(mesh.material);
    }
  }
  return mats;
}

function isOwnedVehicleMaterial(name: string): boolean {
  return name.startsWith("apex.") || name.startsWith("retro.") || name.startsWith("strada.");
}

function setYaw(body: RAPIER.RigidBody, yaw: number): void {
  const h = yaw * 0.5;
  body.setRotation({ x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) }, true);
}

function applyForceAt(
  body: RAPIER.RigidBody,
  force: { x: number; y: number; z: number },
  pointWorld: Vector3,
): void {
  body.addForceAtPoint(force, { x: pointWorld.x, y: pointWorld.y, z: pointWorld.z }, true);
}

function localToWorld(
  t: { x: number; y: number; z: number },
  q: Quaternion,
  local: Vector3,
  out: Vector3,
): Vector3 {
  const vx = local.x, vy = local.y, vz = local.z;
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const ux = qy * vz - qz * vy;
  const uy = qz * vx - qx * vz;
  const uz = qx * vy - qy * vx;
  const uux = qy * uz - qz * uy;
  const uuy = qz * ux - qx * uz;
  const uuz = qx * uy - qy * ux;
  out.x = t.x + vx + 2 * (qw * ux + uux);
  out.y = t.y + vy + 2 * (qw * uy + uuy);
  out.z = t.z + vz + 2 * (qw * uz + uuz);
  return out;
}

function getBasisToRef(q: Quaternion, axis: "x" | "y" | "z", out: Vector3): Vector3 {
  const x = q.x, y = q.y, z = q.z, w = q.w;
  if (axis === "x") { out.set(1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)); return out; }
  if (axis === "y") { out.set(2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)); return out; }
  out.set(2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y));
  return out;
}

function pointVelocityToRef(
  body: RAPIER.RigidBody,
  pointWorld: Vector3,
  linvel: { x: number; y: number; z: number },
  angvel: { x: number; y: number; z: number },
  out: Vector3,
): Vector3 {
  const com = body.translation();
  const rx = pointWorld.x - com.x;
  const ry = pointWorld.y - com.y;
  const rz = pointWorld.z - com.z;
  out.set(
    linvel.x + (angvel.y * rz - angvel.z * ry),
    linvel.y + (angvel.z * rx - angvel.x * rz),
    linvel.z + (angvel.x * ry - angvel.y * rx),
  );
  return out;
}

function rotateAroundYToRef(v: Vector3, angle: number, out: Vector3): Vector3 {
  const c = Math.cos(angle), s = Math.sin(angle);
  out.set(c * v.x + s * v.z, v.y, -s * v.x + c * v.z);
  return out;
}

function dot(a: Vector3, b: Vector3): number { return a.x * b.x + a.y * b.y + a.z * b.z; }
function clamp(x: number, lo: number, hi: number): number { return x < lo ? lo : x > hi ? hi : x; }

function placeWheelMesh(
  wheel: Wheel,
  attachWorld: Vector3,
  chassisQ: Quaternion,
  springLen: number,
  steerAngle: number,
): void {
  wheel.mesh.position.set(attachWorld.x, attachWorld.y - springLen, attachWorld.z);
  if (!wheel.mesh.rotationQuaternion) wheel.mesh.rotationQuaternion = new Quaternion();
  const yaw = quaternionYaw(chassisQ) + (wheel.cfg.steers ? steerAngle : 0);
  Quaternion.RotationYawPitchRollToRef(yaw, 0, 0, wheel.mesh.rotationQuaternion);
}

function quaternionYaw(q: Quaternion): number {
  return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
}
