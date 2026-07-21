import {
  Mesh,
  TransformNode,
  Vector3,
  VertexData,
  Scene,
  StandardMaterial,
} from "@babylonjs/core";
import type { RenderContext } from "../render/scene";
import type { PhysicsWorld } from "../physics/world";
import type RAPIER from "@dimforge/rapier3d-compat";
import { adaptiveSmooth, catmullRom, dedupe, laplacianSmooth, resampleByArcLength, roundSharpCorners, tangentAt, type Vec2 } from "./spline";

export interface BuiltTrack {
  /** Where the car should spawn. */
  spawn: { position: Vector3; yaw: number };
  /** Smoothed centerline samples (post Catmull-Rom + resample). */
  centerline: ReadonlyArray<Vec2>;
  /** Root node grouping all visuals so we can dispose them on rebuild. */
  root: TransformNode;
  /** Collider handle so we can free it on rebuild. */
  colliderHandle: number;
  /** Whether the centerline is a loop suitable for lap timing. */
  closed: boolean;
  /** Free meshes + physics. */
  dispose(): void;
}

const ROAD_WIDTH = 8; // meters
const EDGE_WIDTH = 0.35;
/** Road surface y. Bumped well above the ground so depth precision at the
 *  fog limit (~720 m) doesn't let the green plane bleed through. */
const ROAD_Y = 0.06;
/** Edge stripes sit a hair above the road. With zOffset we *also* push them
 *  toward the camera in the depth buffer — Y separation alone isn't enough
 *  at long distances. */
const EDGE_Y = 0.09;
const SAMPLES_PER_SEGMENT = 16;
/** Distance between accepted drawn points. Must be on the order of the road
 *  half-width so a hand-scribbled cluster of points doesn't create a chain
 *  of micro-corners that no fillet large enough to clear the road ribbon
 *  can fit between. */
const MIN_INPUT_STEP = 5.0;
const RESAMPLE_STEP = 0.5; // meters along the smoothed spline
/** Minimum radius of any corner. Must be > ROAD_WIDTH/2 so the offset ribbon
 *  on the inside of the curve never crosses the centerline (which would flip
 *  triangle winding and tear the road visually). Includes a safety margin. */
const MIN_CORNER_RADIUS = ROAD_WIDTH * 1.25;
const SHARP_ANGLE_DEG = 8; // anything that turns more than this is rounded
const ARC_SAMPLES = 12;
const SMOOTH_LAMBDA = 0.4;
const SMOOTH_ITERS = 6;

/**
 * Build a drivable track from a polyline drawn by the player.
 *
 * Pipeline:
 *   raw points -> dedupe -> Catmull-Rom -> resample uniformly -> ribbon
 *
 * Visuals: a filled road quad strip + thin white edge strips. The ground
 * material uses zOffset so the road (y=0.02) wins the depth test cleanly
 * without needing a separate rendering group (which would break car<->track
 * occlusion).
 *
 * Physics: a static trimesh of the road surface. The car can also drive off
 * the track because the ground is its own collider.
 */
export function buildPlayerTrack(
  ctx: RenderContext,
  phys: PhysicsWorld,
  drawn: ReadonlyArray<Vec2>,
  opts?: { walls?: boolean; closed?: boolean },
): BuiltTrack | null {
  if (drawn.length < 2) return null;

  const source = opts?.closed && distance2(drawn[0], drawn[drawn.length - 1]) < 1e-6
    ? drawn.slice(0, -1)
    : drawn;
  if (source.length < 2) return null;

  // 1. Clean input.
  const cleaned = dedupe(source, MIN_INPUT_STEP);
  if (cleaned.length < 2) return null;

  // 2. Before corner-rounding: adaptive edge-length-weighted smoothing that
  //    pulls high-curvature regions toward their neighbors more aggressively.
  //    This mirrors the user's requirement of "曲率高的地方平滑一下".
  const adaptiveSmoothed = adaptiveSmooth(cleaned, 0.4, 8);
  const rounded = roundSharpCorners(adaptiveSmoothed, MIN_CORNER_RADIUS, SHARP_ANGLE_DEG, ARC_SAMPLES);

  // 3. Smooth via Catmull-Rom, then uniform resample.
  // Adapt the resample step to total path length: very long tracks (presets
  // like a 5 km straight) would otherwise blow up to 10 000+ samples and
  // dominate raycast / minimap cost. Cap centerline at ~1500 samples.
  const smoothed = catmullRom(rounded, SAMPLES_PER_SEGMENT);
  const totalLen = polylineLength(smoothed);
  const step = Math.max(RESAMPLE_STEP, totalLen / 1500);
  const resampled = resampleByArcLength(smoothed, step);
  if (resampled.length < 2) return null;

  // 4. Final low-pass: a few Laplacian passes wipe out residual jitter from
  //    the hand-drawn path while leaving large-scale shape intact (endpoints
  //    are pinned).
  const centerlineRaw = laplacianSmooth(resampled, SMOOTH_LAMBDA, SMOOTH_ITERS);
  const centerline = opts?.closed && centerlineRaw.length > 2 && distance2(centerlineRaw[0], centerlineRaw[centerlineRaw.length - 1]) < 1e-4
    ? centerlineRaw.slice(0, -1)
    : centerlineRaw;

  const { scene, materials } = ctx;
  const { world, rapier } = phys;

  const root = new TransformNode("track.root", scene);

  // ── ribbon construction ────────────────────────────────────────────────
  //
  // Simple per-point approach as requested:
  //   For each centerline point, compute the tangent → normal (t.z, -t.x).
  //   Offset left  = center + normal * halfWidth
  //   Offset right = center - normal * halfWidth
  //   Connect consecutive pairs into two triangles.
  //
  // Because the smoothing pipeline (roundSharpCorners + CatmullRom +
  // Laplacian) already ensures every corner has radius > ROAD_WIDTH/2, the
  // offset ribbon never self-intersects. Edge stripes use the same normal so
  // they stay parallel to the road at all times — no sawtooth or width
  // distortion at bends.
  //
  // Depth layering via zOffset (negative pulls toward camera):
  //   Road     zOffset = -1
  //   Center   zOffset = -2
  //   Edge     zOffset = -3

  const half = ROAD_WIDTH / 2;
  const halfEdge = EDGE_WIDTH / 2;
  const n = centerline.length;
  const segmentCount = opts?.closed ? n : n - 1;

  // Each entry = { leftX, leftZ, rightX, rightZ } for one centerline point.
  interface RibbonRow { lx: number; lz: number; rx: number; rz: number }
  const rows: RibbonRow[] = [];

  for (let i = 0; i < n; i++) {
    const c = centerline[i];
    const t = tangentAt(centerline, i);
    const nx = t.z, nz = -t.x;
    rows.push({
      lx: c.x + nx * half, lz: c.z + nz * half,
      rx: c.x - nx * half, rz: c.z - nz * half,
    });
  }

  // ── Road surface ────────────────────────────────────────────────────────

  const roadPos: number[] = [];
  const roadIdx: number[] = [];
  for (const r of rows) {
    roadPos.push(r.lx, ROAD_Y, r.lz);
    roadPos.push(r.rx, ROAD_Y, r.rz);
  }
  for (let i = 0; i < segmentCount; i++) {
    const ni = (i + 1) % n;
    const a = i * 2, b = i * 2 + 1, c = ni * 2, d = ni * 2 + 1;
    roadIdx.push(a, c, b, b, c, d);
  }
  const roadMesh = buildMesh("track.road", scene, roadPos, roadIdx, materials.road, -1);
  roadMesh.parent = root;

  // ── Edge stripes ────────────────────────────────────────────────────────

  const edgePos: number[] = [];
  const edgeIdx: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    const t = tangentAt(centerline, i);
    const nx = t.z, nz = -t.x;
    edgePos.push(
      r.lx + nx * halfEdge, EDGE_Y, r.lz + nz * halfEdge,
      r.lx - nx * halfEdge, EDGE_Y, r.lz - nz * halfEdge,
      r.rx + nx * halfEdge, EDGE_Y, r.rz + nz * halfEdge,
      r.rx - nx * halfEdge, EDGE_Y, r.rz - nz * halfEdge,
    );
  }
  for (let i = 0; i < segmentCount; i++) {
    const ni = (i + 1) % n;
    const s = i * 4;
    const ns = ni * 4;
    edgeIdx.push(s, ns, s + 1, s + 1, ns, ns + 1);     // left edge
    edgeIdx.push(s + 2, ns + 2, s + 3, s + 3, ns + 2, ns + 3); // right edge
  }
  const edgeMesh = buildMesh("track.edge", scene, edgePos, edgeIdx, materials.roadEdge, -3);
  edgeMesh.parent = root;

  // ── Center dashed line ─────────────────────────────────────────────────

  const dashLen = 2.5;
  const gapLen = 5.0;
  const dashHalf = 0.12;
  const dashPos: number[] = [];
  const dashIdx: number[] = [];
  let d = 0;
  let dashOn = true;
  let cursor = 0;
  for (let i = 1; i < n; i++) {
    const seg = Math.hypot(
      centerline[i].x - centerline[i - 1].x,
      centerline[i].z - centerline[i - 1].z,
    );
    const segEnd = d + seg;
    while (cursor < segEnd) {
      const t = (cursor - d) / seg;
      const cx = centerline[i - 1].x + (centerline[i].x - centerline[i - 1].x) * t;
      const cz = centerline[i - 1].z + (centerline[i].z - centerline[i - 1].z) * t;
      const advance = dashOn ? dashLen : gapLen;
      const t2 = Math.min(1, (cursor + advance - d) / seg);
      const ex = centerline[i - 1].x + (centerline[i].x - centerline[i - 1].x) * t2;
      const ez = centerline[i - 1].z + (centerline[i].z - centerline[i - 1].z) * t2;
      if (dashOn) {
        const dx = ex - cx, dz = ez - cz;
        const ln = Math.hypot(dx, dz) || 1;
        const nx = dz / ln, nz = -dx / ln;
        const base = dashPos.length / 3;
        dashPos.push(cx + nx * dashHalf, ROAD_Y + 0.01, cz + nz * dashHalf);
        dashPos.push(cx - nx * dashHalf, ROAD_Y + 0.01, cz - nz * dashHalf);
        dashPos.push(ex + nx * dashHalf, ROAD_Y + 0.01, ez + nz * dashHalf);
        dashPos.push(ex - nx * dashHalf, ROAD_Y + 0.01, ez - nz * dashHalf);
        dashIdx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
      }
      cursor += advance;
      dashOn = !dashOn;
      if (t2 >= 1) break;
    }
    d = segEnd;
  }
  if (dashPos.length > 0) {
    const dashMesh = buildMesh("track.centerDash", scene, dashPos, dashIdx, materials.roadEdge, -2);
    dashMesh.parent = root;
  }

  // ── Physics ────────────────────────────────────────────────────────────

  const vertices = new Float32Array(roadPos);
  const indices = new Uint32Array(roadIdx);
  const trimeshDesc = rapier.ColliderDesc.trimesh(vertices, indices).setFriction(1.1);
  const body = world.createRigidBody(rapier.RigidBodyDesc.fixed());
  const collider = world.createCollider(trimeshDesc, body);

  // ── Optional perimeter walls (for ovals etc.) ──────────────────────────

  const wallExtras: {
    body: RAPIER.RigidBody;
    collider: RAPIER.Collider;
  }[] = [];
  if (opts?.walls) {
    const wallOffset = half + 1.6;
    const wallHeight = 1.4;
    for (const side of [-1, 1] as const) {
      const wPos: number[] = [];
      const wIdx: number[] = [];
      for (let i = 0; i < n; i++) {
        const c = centerline[i];
        const t = tangentAt(centerline, i);
        const nx = t.z * side;
        const nz = -t.x * side;
        const ex = c.x + nx * wallOffset;
        const ez = c.z + nz * wallOffset;
        wPos.push(ex, 0.02, ez);
        wPos.push(ex, wallHeight, ez);
      }
      for (let i = 0; i < segmentCount; i++) {
        const ni = (i + 1) % n;
        const a = i * 2, b = i * 2 + 1, c2 = ni * 2, d = ni * 2 + 1;
        wIdx.push(a, b, c2, b, d, c2);
      }
      const wallMat = materials.roadEdge.clone(`track.wall.${side}.mat`);
      wallMat.backFaceCulling = false;
      const wallMesh = new Mesh(`track.wall.${side}`, scene);
      const wvd = new VertexData();
      wvd.positions = wPos;
      wvd.indices = wIdx;
      const wn: number[] = [];
      for (let i = 0; i < wPos.length / 3; i++) wn.push(0, 1, 0);
      wvd.normals = wn;
      wvd.applyToMesh(wallMesh, false);
      wallMesh.material = wallMat;
      wallMesh.parent = root;

      const verts = new Float32Array(wPos);
      const indsW = new Uint32Array(wIdx);
      const wallDesc = rapier.ColliderDesc.trimesh(verts, indsW)
        .setFriction(0.4)
        .setRestitution(0.05);
      const wallBody = world.createRigidBody(rapier.RigidBodyDesc.fixed());
      const wallCol = world.createCollider(wallDesc, wallBody);
      wallExtras.push({ body: wallBody, collider: wallCol });
    }
  }

  // ── Start markers ──────────────────────────────────────────────────────

  const startC = centerline[0];
  const startT = tangentAt(centerline, 0);
  const startNx = startT.z, startNz = -startT.x;
  for (const side of [-1, 1] as const) {
    const post = createPost(scene, materials.carDark);
    post.position.set(startC.x + startNx * half * side, 1.25, startC.z + startNz * half * side);
    post.parent = root;
  }

  const yaw = Math.atan2(startT.x, startT.z);
  const spawnPos = new Vector3(startC.x - startT.x * 2.0, 0.52, startC.z - startT.z * 2.0);

  return {
    spawn: { position: spawnPos, yaw },
    centerline,
    root,
    colliderHandle: collider.handle,
    closed: !!opts?.closed,
    dispose() {
      const mats = collectNodeMaterials(root, "track.");
      root.dispose(false, true);
      world.removeCollider(collider, false);
      world.removeRigidBody(body);
      for (const w of wallExtras) {
        world.removeCollider(w.collider, false);
        world.removeRigidBody(w.body);
      }
      for (const mat of mats) mat.dispose();
    },
  };
}

function buildMesh(
  name: string,
  scene: Scene,
  positions: number[],
  indices: number[],
  mat: StandardMaterial,
  zOffset: number,
): Mesh {
  const mesh = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  // Flat top-facing normals — we lay the ribbons in the XZ plane so the
  // surface is always (0, 1, 0). Compute-from-geometry can flip on near-
  // colinear tris and produce dark spots; hard-coding the normal sidesteps
  // that and matches our minimalist flat-shaded look.
  const normals: number[] = [];
  for (let i = 0; i < positions.length / 3; i++) normals.push(0, 1, 0);
  vd.normals = normals;
  vd.applyToMesh(mesh, false);
  // Clone the material so we can tweak its zOffset without affecting other
  // meshes that share the same StandardMaterial. backFaceCulling stays ON;
  // the ribbon is now built with a mitered offset that never inverts the
  // winding, so we don't need (and shouldn't have) double-sided rendering.
  const m = mat.clone(`${name}.mat`);
  m.backFaceCulling = true;
  m.zOffset = zOffset;
  mesh.material = m;
  return mesh;
}

function collectNodeMaterials(root: TransformNode, ownedPrefix: string): Set<StandardMaterial> {
  const mats = new Set<StandardMaterial>();
  for (const mesh of root.getChildMeshes(false)) {
    if (mesh.material instanceof StandardMaterial && mesh.material.name.startsWith(ownedPrefix)) {
      mats.add(mesh.material);
    }
  }
  return mats;
}

function createPost(scene: Scene, mat: StandardMaterial): Mesh {
  const m = Mesh.CreateBox("post", 1, scene);
  m.scaling.set(0.3, 2.5, 0.3);
  m.material = mat;
  return m;
}

/**
 * Build the static ground (visual + physics). Returns a disposer because the
 * ground is created once per game and never rebuilt.
 */
/**
 * Build the static ground (visual + physics) and return a controller that
 * the main loop can call each frame to recenter the ground tile under the
 * car. From the car's perspective the ground appears infinite — visually
 * the same green plane is reused, and the physics collider follows so the
 * car always has solid ground to drive on, no matter how far it travels.
 */
export interface Ground {
  /** Recenter the ground under the car. Snap to a grid to avoid jitter. */
  follow(carPos: { x: number; z: number }): void;
  dispose(): void;
}

export function buildGround(ctx: RenderContext, phys: PhysicsWorld): Ground {
  const { scene, materials } = ctx;
  const { world, rapier } = phys;

  const ground = Mesh.CreateGround("ground", 1500, 1500, 1, scene);
  const groundMat = materials.ground.clone("ground.mat");
  groundMat.zOffset = 4;
  ground.material = groundMat;
  ground.position.y = 0;

  const groundBody = world.createRigidBody(rapier.RigidBodyDesc.fixed());
  const groundCollider = rapier.ColliderDesc.cuboid(1000, 0.5, 1000)
    .setTranslation(0, -0.5, 0)
    .setFriction(1.0);
  const collider = world.createCollider(groundCollider, groundBody);

  // Snap follow to a 50 m grid: the visual plane and the collider both move
  // in 50 m chunks, so the player never sees the edge of the world but we
  // also never accumulate floating-point drift.
  const SNAP = 50;

  return {
    follow(carPos): void {
      const sx = Math.round(carPos.x / SNAP) * SNAP;
      const sz = Math.round(carPos.z / SNAP) * SNAP;
      if (ground.position.x === sx && ground.position.z === sz) return;
      ground.position.x = sx;
      ground.position.z = sz;
      // Move the static collider too. setTranslation on a fixed body is fine.
      groundBody.setTranslation({ x: sx, y: 0, z: sz }, false);
    },
    dispose(): void {
      world.removeCollider(collider, false);
      world.removeRigidBody(groundBody);
      ground.dispose();
      groundMat.dispose();
    },
  };
}

// ── built-in track presets ────────────────────────────────────────────────

/**
 * Each preset returns a polyline (the same shape the designer hands in) so
 * presets reuse the entire smoothing + mesh + collider pipeline.
 */
export interface TrackPreset {
  id: string;
  label: string;
  description: string;
  polyline(): Vec2[];
  walls?: boolean;
  closed?: boolean;
}

export const PRESETS: ReadonlyArray<TrackPreset> = [
  {
    id: "infinite-straight",
    label: "Infinite Straight",
    description:
      "5 km arrow-straight runway. Bury the throttle and find the top end.",
    polyline(): Vec2[] {
      return [
        { x: 0, z: -50 },
        { x: 0, z: 5000 },
      ];
    },
  },
  {
    id: "nascar-oval",
    label: "Speedway Oval",
    description:
      "1.6 km elliptical speedway: smooth oval banking, two long sweeping straights. Walled inside and out.",
    walls: true,
    closed: true,
    polyline(): Vec2[] {
      const a = 240; // semi-major (along Z)
      const b = 150; // semi-minor (along X)
      const samples = 220;
      const pts: Vec2[] = [];
      for (let i = 0; i < samples; i++) {
        const t = (i / samples) * Math.PI * 2;
        pts.push({ x: Math.sin(t) * b, z: Math.cos(t) * a });
      }
      return pts;
    },
  },
];

export function findPreset(id: string): TrackPreset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** Build a preset by id. Same return shape as `buildPlayerTrack`. */
export function buildPresetTrack(
  ctx: RenderContext,
  phys: PhysicsWorld,
  presetId: string,
): BuiltTrack | null {
  const preset = findPreset(presetId);
  if (!preset) return null;
  return buildPlayerTrack(ctx, phys, preset.polyline(), { walls: preset.walls, closed: preset.closed });
}

function distance2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

function polylineLength(points: ReadonlyArray<Vec2>): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dz = points[i].z - points[i - 1].z;
    total += Math.hypot(dx, dz);
  }
  return total;
}
