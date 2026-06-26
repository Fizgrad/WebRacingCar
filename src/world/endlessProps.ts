import {
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Color3,
  TransformNode,
  InstancedMesh,
} from "@babylonjs/core";
import type { Vec2 } from "../track/spline";

/**
 * Endless-mode roadside scenery. Spawns lightweight props (trees, pines,
 * rocks, signs) at fixed intervals along the centerline as new chunks of
 * track come into existence, and disposes any that drift far behind the car.
 *
 * Bookkeeping is keyed by "stamp index": every `STAMP_SPACING` meters of
 * centerline gets one stamp slot. Each slot deterministically spawns 0–N
 * props on each side of the road based on a per-stamp PRNG seed, so the
 * world is reproducible even though we only generate it lazily.
 */

const STAMP_SPACING = 18;        // meters between scenery decision points
const LATERAL_MIN = 8;           // closest a prop may sit from the centerline
const LATERAL_MAX = 38;          // farthest the lateral spread reaches
const KEEP_RADIUS = 380;         // dispose stamps farther than this from car
const SPAWN_RADIUS = 280;        // spawn new stamps within this distance

export interface EndlessProps {
  /** Notify of a new centerline (called every time it grows). */
  setCenterline(line: ReadonlyArray<Vec2>): void;
  /** Per-frame update; recycles distant stamps. */
  update(carPos: { x: number; z: number }): void;
  dispose(): void;
}

interface StampInstances { meshes: InstancedMesh[]; cx: number; cz: number }

export function buildEndlessProps(scene: Scene, seed: number): EndlessProps {
  const root = new TransformNode("endlessProps.root", scene);
  const proto = buildProtos(scene);
  for (const m of Object.values(proto)) {
    if (m instanceof Mesh) m.parent = root;
  }

  // Active stamps keyed by stamp index (an integer along the centerline).
  const stamps = new Map<number, StampInstances>();

  // Centerline we're currently sampling along. We accumulate arc length as
  // it grows so stamp indices remain stable as the streamer appends points.
  let line: ReadonlyArray<Vec2> = [];
  let cumLen: number[] = [];
  let totalLen = 0;

  function setCenterline(newLine: ReadonlyArray<Vec2>): void {
    line = newLine;
    if (cumLen.length !== line.length) {
      cumLen = new Array(line.length).fill(0);
    }
    // Extend cumulative length from wherever it left off.
    for (let i = Math.max(1, cumLen.length - line.length + 1); i < line.length; i++) {
      const dx = line[i].x - line[i - 1].x;
      const dz = line[i].z - line[i - 1].z;
      cumLen[i] = cumLen[i - 1] + Math.hypot(dx, dz);
    }
    totalLen = cumLen[cumLen.length - 1] ?? 0;
  }

  function pointAtArc(s: number): { x: number; z: number; tx: number; tz: number } | null {
    if (line.length < 2 || s <= 0 || s >= totalLen) return null;
    // Binary search the segment containing arc length `s`.
    let lo = 0, hi = cumLen.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (cumLen[mid] <= s) lo = mid; else hi = mid;
    }
    const a = line[lo], b = line[lo + 1];
    const segLen = Math.max(1e-3, cumLen[lo + 1] - cumLen[lo]);
    const t = (s - cumLen[lo]) / segLen;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    const dx = (b.x - a.x) / segLen;
    const dz = (b.z - a.z) / segLen;
    return { x, z, tx: dx, tz: dz };
  }

  function spawnStamp(idx: number): void {
    if (stamps.has(idx)) return;
    const s = idx * STAMP_SPACING;
    const pt = pointAtArc(s);
    if (!pt) return;
    const rng = mulberry32(seed ^ idx);
    const meshes: InstancedMesh[] = [];
    // Decide how many props on each side (0–3).
    for (const side of [-1, 1] as const) {
      const n = Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) {
        const lat = LATERAL_MIN + rng() * (LATERAL_MAX - LATERAL_MIN);
        const along = (rng() - 0.5) * (STAMP_SPACING * 0.8);
        // Normal to the tangent: (tz, -tx).
        const nx = pt.tz, nz = -pt.tx;
        const px = pt.x + nx * lat * side + pt.tx * along;
        const pz = pt.z + nz * lat * side + pt.tz * along;
        const kind = rng();
        const inst = spawnProp(kind, rng, proto, px, pz);
        if (inst) {
          inst.parent = root;
          meshes.push(inst);
        }
      }
    }
    stamps.set(idx, { meshes, cx: pt.x, cz: pt.z });
  }

  function disposeStamp(idx: number): void {
    const s = stamps.get(idx);
    if (!s) return;
    for (const m of s.meshes) m.dispose();
    stamps.delete(idx);
  }

  function update(carPos: { x: number; z: number }): void {
    if (totalLen < STAMP_SPACING * 2) return;
    // Recycle distant stamps.
    const toRemove: number[] = [];
    for (const [idx, s] of stamps) {
      const d = Math.hypot(s.cx - carPos.x, s.cz - carPos.z);
      if (d > KEEP_RADIUS) toRemove.push(idx);
    }
    for (const idx of toRemove) disposeStamp(idx);

    // Determine which stamp indices are within spawn range. We scan every
    // stamp slot from the car's projected arc length backward & forward.
    // To keep the per-frame work bounded, only sample the slots that lie
    // along the *current* centerline window — which the streamer already
    // bounds for us.
    // Step 1: find the centerline point closest to the car.
    let nearestIdx = 0;
    let bestD = Infinity;
    for (let i = 0; i < line.length; i++) {
      const d = (line[i].x - carPos.x) ** 2 + (line[i].z - carPos.z) ** 2;
      if (d < bestD) { bestD = d; nearestIdx = i; }
    }
    const sCar = cumLen[nearestIdx] ?? 0;
    const sBack = Math.max(0, sCar - SPAWN_RADIUS);
    const sFwd = Math.min(totalLen, sCar + SPAWN_RADIUS);
    const idxStart = Math.floor(sBack / STAMP_SPACING);
    const idxEnd = Math.floor(sFwd / STAMP_SPACING);
    for (let i = idxStart; i <= idxEnd; i++) {
      if (!stamps.has(i)) spawnStamp(i);
    }
  }

  function dispose(): void {
    const mats = collectMaterials(Object.values(proto));
    for (const [, s] of stamps) for (const m of s.meshes) m.dispose();
    stamps.clear();
    root.dispose(false, true);
    for (const v of Object.values(proto)) {
      if (v instanceof Mesh) v.dispose();
    }
    for (const mat of mats) mat.dispose();
  }

  return { setCenterline, update, dispose };
}

// ─── prop spawning ─────────────────────────────────────────────────────────

interface Protos {
  trunk: Mesh;
  foliage: Mesh;
  pineLayer: Mesh;
  rock: Mesh;
  signPost: Mesh;
  signFace: Mesh;
  building: Mesh;
  meadow: Mesh;
  dirt: Mesh;
  pond: Mesh;
}

function spawnProp(
  kind: number,
  rng: () => number,
  proto: Protos,
  x: number,
  z: number,
): InstancedMesh | null {
  if (kind < 0.12) {
    const pick = rng();
    const inst = (pick < 0.45 ? proto.meadow : pick < 0.85 ? proto.dirt : proto.pond)
      .createInstance(`ep.terrain.${++propCounter}`);
    const s = 5 + rng() * 12;
    inst.position.set(x, 0.014, z);
    inst.scaling.set(s * (0.8 + rng() * 0.8), 1, s);
    inst.rotation.y = rng() * Math.PI * 2;
    return inst;
  } else if (kind < 0.55) {
    // Pine: stretched cone (one mesh — fast to dispose).
    const s = 1.0 + rng() * 0.8;
    const layer = proto.pineLayer.createInstance(`ep.pine.${++propCounter}`);
    layer.position.set(x, 1.0 * s, z);
    layer.scaling.set(s, s * 1.6, s);
    layer.rotation.y = rng() * Math.PI * 2;
    return layer;
  } else if (kind < 0.85) {
    // Round bush (single sphere — cheap green dot near the road).
    const s = 0.8 + rng() * 0.8;
    const inst = proto.foliage.createInstance(`ep.bush.${++propCounter}`);
    inst.position.set(x, 0.45 * s, z);
    inst.scaling.set(s, s * 0.85, s);
    inst.rotation.y = rng() * Math.PI * 2;
    return inst;
  } else if (kind < 0.92) {
    const s = 0.4 + rng() * 0.6;
    const inst = proto.rock.createInstance(`ep.rock.${++propCounter}`);
    inst.position.set(x, 0.25 * s, z);
    inst.scaling.set(s, s, s);
    inst.rotation.y = rng() * Math.PI * 2;
    return inst;
  } else if (kind < 0.985) {
    const inst = proto.building.createInstance(`ep.building.${++propCounter}`);
    inst.position.set(x, 1.3, z);
    inst.scaling.set(0.7 + rng() * 0.9, 0.7 + rng() * 0.8, 0.7 + rng() * 0.9);
    inst.rotation.y = rng() * Math.PI * 2;
    return inst;
  } else {
    const inst = proto.signPost.createInstance(`ep.sign.${++propCounter}`);
    inst.position.set(x, 0.55, z);
    return inst;
  }
}

let propCounter = 0;

function buildProtos(scene: Scene): Protos {
  const trunkMat = flatMat("ep.trunkMat", scene, new Color3(0.36, 0.25, 0.18));
  const leafMat  = flatMat("ep.leafMat",  scene, new Color3(0.26, 0.50, 0.22));
  const pineMat  = flatMat("ep.pineMat",  scene, new Color3(0.14, 0.36, 0.22));
  const rockMat  = flatMat("ep.rockMat",  scene, new Color3(0.55, 0.55, 0.55));
  const postMat  = flatMat("ep.postMat",  scene, new Color3(0.32, 0.32, 0.34));
  const signMat  = flatMat("ep.signMat",  scene, new Color3(0.92, 0.65, 0.18));
  const buildingMat = flatMat("ep.buildingMat", scene, new Color3(0.70, 0.66, 0.58));
  const meadowMat = flatMat("ep.meadow", scene, new Color3(0.44, 0.58, 0.30));
  const dirtMat = flatMat("ep.dirt", scene, new Color3(0.50, 0.38, 0.25));
  const pondMat = flatMat("ep.pond", scene, new Color3(0.26, 0.52, 0.66));

  const trunk = MeshBuilder.CreateCylinder("ep.trunk.proto",
    { diameterTop: 0.18, diameterBottom: 0.28, height: 1.4, tessellation: 7 }, scene);
  trunk.material = trunkMat;
  const foliage = MeshBuilder.CreateSphere("ep.foliage.proto", { diameter: 1.6, segments: 3 }, scene);
  foliage.material = leafMat;
  const pineLayer = MeshBuilder.CreateCylinder("ep.pineLayer.proto",
    { diameterTop: 0, diameterBottom: 1.6, height: 1.4, tessellation: 7 }, scene);
  pineLayer.material = pineMat;
  const rock = MeshBuilder.CreatePolyhedron("ep.rock.proto", { type: 1, size: 0.6 }, scene);
  rock.material = rockMat;
  const signPost = MeshBuilder.CreateCylinder("ep.signpost.proto",
    { diameter: 0.12, height: 1.1, tessellation: 6 }, scene);
  signPost.material = postMat;
  const signFace = MeshBuilder.CreateBox("ep.signface.proto",
    { width: 0.7, height: 0.5, depth: 0.06 }, scene);
  signFace.material = signMat;
  const building = MeshBuilder.CreateBox("ep.building.proto",
    { width: 3.5, height: 2.6, depth: 3.0 }, scene);
  building.material = buildingMat;
  const meadow = flatPatch("ep.meadow.proto", scene, meadowMat, 11);
  const dirt = flatPatch("ep.dirt.proto", scene, dirtMat, 9);
  const pond = flatPatch("ep.pond.proto", scene, pondMat, 13);

  for (const m of [trunk, foliage, pineLayer, rock, signPost, signFace, building, meadow, dirt, pond]) m.isPickable = false;
  return { trunk, foliage, pineLayer, rock, signPost, signFace, building, meadow, dirt, pond };
}

function flatPatch(name: string, scene: Scene, mat: StandardMaterial, tessellation: number): Mesh {
  const m = MeshBuilder.CreateCylinder(name, { diameter: 1, height: 0.01, tessellation }, scene);
  m.material = mat;
  return m;
}

function flatMat(name: string, scene: Scene, color: Color3): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = color;
  m.specularColor = new Color3(0, 0, 0);
  m.emissiveColor = color.scale(0.18);
  return m;
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
