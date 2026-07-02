import {
  Color3,
  InstancedMesh,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
} from "@babylonjs/core";
import type { Vec2 } from "../track/spline";

const RADIUS = 760;
const TRACK_CLEARANCE = 10;
const SPAWN_CLEARANCE = 20;

const COUNTS = {
  meadowPatches: 70,
  dirtPatches: 34,
  sandPatches: 20,
  ponds: 12,
  hills: 44,
  rockFields: 26,
};

export interface TerrainFeatures {
  root: TransformNode;
  updateLOD(carPos: { x: number; z: number }): void;
  dispose(): void;
}

export function buildTerrainFeatures(
  scene: Scene,
  centerline: ReadonlyArray<Vec2>,
  spawn: { x: number; z: number },
): TerrainFeatures {
  const root = new TransformNode("terrain.root", scene);
  const rng = mulberry32(0x510e527f);
  const proto = buildPrototypes(scene);
  for (const mesh of Object.values(proto)) {
    if (mesh instanceof Mesh) mesh.parent = root;
  }

  const instances: InstancedMesh[] = [];
  const lodItems: Array<{ mesh: InstancedMesh; maxD2: number }> = [];
  const density = isLowPowerDevice() ? 0.55 : 1;
  const count = (v: number): number => Math.max(1, Math.round(v * density));
  const add = (m: InstancedMesh, maxDistance: number = 560) => {
    m.parent = root;
    m.freezeWorldMatrix();
    instances.push(m);
    lodItems.push({ mesh: m, maxD2: maxDistance * maxDistance });
  };

  scatter(count(COUNTS.meadowPatches), rng, centerline, spawn, 8, (x, z) => {
    const s = 8 + rng() * 18;
    const inst = proto.meadow.createInstance(`terrain.meadow.${instances.length}`);
    inst.position.set(x, 0.012, z);
    inst.scaling.set(s * (0.7 + rng() * 0.6), 1, s);
    inst.rotation.y = rng() * Math.PI * 2;
    add(inst);
  });

  scatter(count(COUNTS.dirtPatches), rng, centerline, spawn, 14, (x, z) => {
    const s = 6 + rng() * 18;
    const inst = proto.dirt.createInstance(`terrain.dirt.${instances.length}`);
    inst.position.set(x, 0.014, z);
    inst.scaling.set(s * (0.8 + rng() * 0.7), 1, s);
    inst.rotation.y = rng() * Math.PI * 2;
    add(inst);
  });

  scatter(count(COUNTS.sandPatches), rng, centerline, spawn, 16, (x, z) => {
    const s = 5 + rng() * 14;
    const inst = proto.sand.createInstance(`terrain.sand.${instances.length}`);
    inst.position.set(x, 0.016, z);
    inst.scaling.set(s * (0.8 + rng() * 0.7), 1, s);
    inst.rotation.y = rng() * Math.PI * 2;
    add(inst);
  });

  scatter(count(COUNTS.ponds), rng, centerline, spawn, 30, (x, z) => {
    const s = 5 + rng() * 12;
    const inst = proto.pond.createInstance(`terrain.pond.${instances.length}`);
    inst.position.set(x, 0.018, z);
    inst.scaling.set(s * (0.8 + rng() * 0.8), 1, s);
    inst.rotation.y = rng() * Math.PI * 2;
    add(inst);
  });

  scatter(count(COUNTS.hills), rng, centerline, spawn, 24, (x, z) => {
    const s = 5 + rng() * 18;
    const inst = proto.hill.createInstance(`terrain.hill.${instances.length}`);
    inst.position.set(x, 0.25 + s * 0.045, z);
    inst.scaling.set(s * (0.8 + rng() * 0.5), s * (0.16 + rng() * 0.08), s);
    inst.rotation.y = rng() * Math.PI * 2;
    add(inst);
  });

  scatter(count(COUNTS.rockFields), rng, centerline, spawn, 22, (x, z) => {
    const cluster = 4 + Math.floor(rng() * 7);
    for (let i = 0; i < cluster; i++) {
      const ox = (rng() - 0.5) * 10;
      const oz = (rng() - 0.5) * 10;
      const s = 0.5 + rng() * 1.0;
      const inst = proto.rock.createInstance(`terrain.rock.${instances.length}`);
      inst.position.set(x + ox, 0.18 * s, z + oz);
      inst.scaling.set(s, s * (0.5 + rng() * 0.5), s);
      inst.rotation.y = rng() * Math.PI * 2;
      add(inst);
    }
  });

  return {
    root,
    updateLOD(carPos): void {
      for (const item of lodItems) {
        const dx = item.mesh.position.x - carPos.x;
        const dz = item.mesh.position.z - carPos.z;
        item.mesh.isVisible = dx * dx + dz * dz <= item.maxD2;
      }
    },
    dispose(): void {
      const mats = collectMaterials(Object.values(proto));
      root.dispose(false, true);
      for (const mesh of Object.values(proto)) {
        if (mesh instanceof Mesh) mesh.dispose();
      }
      for (const mat of mats) mat.dispose();
    },
  };
}

interface Prototypes {
  meadow: Mesh;
  dirt: Mesh;
  sand: Mesh;
  pond: Mesh;
  hill: Mesh;
  rock: Mesh;
}

function buildPrototypes(scene: Scene): Prototypes {
  const meadowMat = flatMat("terrain.meadow", scene, new Color3(0.44, 0.58, 0.30));
  const dirtMat = flatMat("terrain.dirt", scene, new Color3(0.50, 0.38, 0.25));
  const sandMat = flatMat("terrain.sand", scene, new Color3(0.74, 0.65, 0.42));
  const pondMat = flatMat("terrain.pond", scene, new Color3(0.26, 0.52, 0.66));
  const hillMat = flatMat("terrain.hill", scene, new Color3(0.47, 0.55, 0.32));
  const rockMat = flatMat("terrain.rock", scene, new Color3(0.48, 0.48, 0.50));

  meadowMat.zOffset = -0.2;
  dirtMat.zOffset = -0.3;
  sandMat.zOffset = -0.35;
  pondMat.zOffset = -0.45;

  const meadow = flatPatch("terrain.meadow.proto", scene, meadowMat, 11);
  const dirt = flatPatch("terrain.dirt.proto", scene, dirtMat, 9);
  const sand = flatPatch("terrain.sand.proto", scene, sandMat, 8);
  const pond = flatPatch("terrain.pond.proto", scene, pondMat, 14);
  const hill = MeshBuilder.CreateSphere("terrain.hill.proto", { diameter: 1, segments: 5 }, scene);
  hill.material = hillMat;
  const rock = MeshBuilder.CreatePolyhedron("terrain.rock.proto", { type: 1, size: 1 }, scene);
  rock.material = rockMat;

  for (const mesh of [meadow, dirt, sand, pond, hill, rock]) mesh.isPickable = false;
  return { meadow, dirt, sand, pond, hill, rock };
}

function flatPatch(name: string, scene: Scene, mat: StandardMaterial, tessellation: number): Mesh {
  const mesh = MeshBuilder.CreateCylinder(name, {
    diameter: 1,
    height: 0.01,
    tessellation,
  }, scene);
  mesh.material = mat;
  return mesh;
}

function flatMat(name: string, scene: Scene, color: Color3): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = color;
  m.specularColor = new Color3(0, 0, 0);
  m.emissiveColor = color.scale(0.16);
  return m;
}

function scatter(
  count: number,
  rng: () => number,
  centerline: ReadonlyArray<Vec2>,
  spawn: { x: number; z: number },
  clearance: number,
  place: (x: number, z: number) => void,
): void {
  let placed = 0;
  let attempts = 0;
  const maxAttempts = count * 10;
  while (placed < count && attempts < maxAttempts) {
    attempts += 1;
    const r = Math.sqrt(rng()) * RADIUS;
    const a = rng() * Math.PI * 2;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (Math.hypot(x - spawn.x, z - spawn.z) < SPAWN_CLEARANCE) continue;
    if (distToCenterline(x, z, centerline) < Math.max(TRACK_CLEARANCE, clearance)) continue;
    place(x, z);
    placed += 1;
  }
}

function distToCenterline(x: number, z: number, line: ReadonlyArray<Vec2>): number {
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    let t = ((x - a.x) * dx + (z - a.z) * dz) / Math.max(len2, 1e-6);
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    const ddx = x - px;
    const ddz = z - pz;
    const d2 = ddx * ddx + ddz * ddz;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

function isLowPowerDevice(): boolean {
  return typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;
}

function collectMaterials(values: ReadonlyArray<unknown>): Set<StandardMaterial> {
  const mats = new Set<StandardMaterial>();
  for (const value of values) {
    if (value instanceof Mesh && value.material instanceof StandardMaterial) mats.add(value.material);
  }
  return mats;
}

function mulberry32(a: number): () => number {
  let s = a >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
