/**
 * Streams an infinite track into the scene chunk by chunk.
 *
 *   - Generation is lazy. Only the first chunk is built at construction
 *     time. As the player approaches the front of the live queue, more
 *     chunks are generated and built one at a time.
 *   - Bookkeeping is index-based. We track which chunk the car is currently
 *     "in" (the chunk whose centerline the car is closest to) and recycle
 *     anything more than `BEHIND_KEEP` chunks earlier.
 *
 * Each chunk merges `SEGMENTS_PER_CHUNK` segments into one mesh + Rapier
 * trimesh, so we don't pay per-segment driver overhead while streaming.
 */

import {
  Mesh,
  TransformNode,
  Vector3,
  VertexData,
  StandardMaterial,
} from "@babylonjs/core";
import RAPIER from "@dimforge/rapier3d-compat";
import type { RenderContext } from "../render/scene";
import type { PhysicsWorld } from "../physics/world";
import { EndlessTrackGenerator, type Segment } from "./endless";
import { tangentAt, type Vec2 } from "./spline";

const ROAD_WIDTH = 8;
const EDGE_WIDTH = 0.35;
const ROAD_Y = 0.06;
const EDGE_Y = 0.09;

/** How many segments are merged into one mesh+collider chunk. */
const SEGMENTS_PER_CHUNK = 3;
/** Keep at least this many chunks live in front of the car's current chunk. */
const AHEAD_CHUNKS = 4;
/** Keep at most this many chunks live behind the car's current chunk. */
const BEHIND_KEEP = 1;

interface Chunk {
  /** Monotonically increasing index assigned at creation. */
  index: number;
  /** Centerline points used by this chunk (including shared join points). */
  centerline: ReadonlyArray<Vec2>;
  /** Cached centroid for cheap "nearest chunk" search. */
  centerX: number;
  centerZ: number;
  meshes: Mesh[];
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  materialClones: StandardMaterial[];
}

export interface EndlessTrack {
  /** Starting point of the track (where the car spawns). */
  spawn: { position: Vector3; yaw: number };
  /** Centerline points emitted so far (used for the minimap; grows as we stream). */
  centerline: ReadonlyArray<Vec2>;
  /** Call every frame with the car position. */
  update(carPos: { x: number; z: number }): void;
  dispose(): void;
}

export function buildEndlessTrack(
  ctx: RenderContext,
  phys: PhysicsWorld,
  seed: number,
): EndlessTrack {
  const { scene, materials } = ctx;
  const { world, rapier } = phys;

  const generator = new EndlessTrackGenerator(seed);
  const root = new TransformNode("endless.root", scene);

  const segments: Segment[] = [];
  const chunks: Chunk[] = [];
  const fullCenterline: Vec2[] = [];

  // Pull one segment from the generator and append its points to the
  // master centerline (skipping the duplicate join with the previous one).
  function pullSegment(): Segment {
    const seg = generator.next();
    segments.push(seg);
    const start = fullCenterline.length === 0 ? 0 : 1;
    for (let i = start; i < seg.points.length; i++) fullCenterline.push(seg.points[i]);
    return seg;
  }

  // Bootstrap: a couple of segments so we know where to spawn the car and
  // can build at least one chunk under their wheels.
  for (let i = 0; i < SEGMENTS_PER_CHUNK + 1; i++) pullSegment();

  // Spawn just behind the start, facing along the first tangent.
  const firstSeg = segments[0];
  const startC = firstSeg.points[0];
  const t0 = tangentAt(firstSeg.points, 0);
  const yaw = Math.atan2(t0.x, t0.z);
  const spawn = {
    position: new Vector3(startC.x - t0.x * 2, 0.52, startC.z - t0.z * 2),
    yaw,
  };

  // ── chunk creation ─────────────────────────────────────────────────────

  let nextSegToBuild = 0;
  let nextChunkIndex = 0;

  function buildOneChunk(): Chunk | null {
    const segs = segments.slice(nextSegToBuild, nextSegToBuild + SEGMENTS_PER_CHUNK);
    if (segs.length < SEGMENTS_PER_CHUNK) return null;
    nextSegToBuild += segs.length;

    // Concatenate the segments' centerlines, dropping duplicate joins.
    const centerline: Vec2[] = [];
    const isFirst = nextChunkIndex === 0;
    for (let i = 0; i < segs.length; i++) {
      const start = i === 0 && isFirst ? 0 : 1;
      for (let j = start; j < segs[i].points.length; j++) centerline.push(segs[i].points[j]);
    }
    if (centerline.length < 2) return null;

    // For chunks beyond the first, prepend the previous chunk's last
    // centerline point so quads bridge cleanly with no visible gap.
    if (!isFirst && chunks.length > 0) {
      const prev = chunks[chunks.length - 1];
      const tail = prev.centerline[prev.centerline.length - 1];
      centerline.unshift({ x: tail.x, z: tail.z });
    }

    const chunk = buildChunk(scene, world, rapier, materials, centerline, root, nextChunkIndex);
    chunks.push(chunk);
    nextChunkIndex += 1;
    return chunk;
  }

  // Build the first chunk now so something is visible the instant the car
  // spawns. We *don't* build the entire lookahead upfront — that's the
  // user-visible "lazy" feel they asked for.
  buildOneChunk();

  // ── per-frame update ──────────────────────────────────────────────────

  function distance2(ax: number, az: number, bx: number, bz: number): number {
    const dx = ax - bx, dz = az - bz;
    return dx * dx + dz * dz;
  }

  function update(carPos: { x: number; z: number }): void {
    if (chunks.length === 0) {
      ensureSegments();
      buildOneChunk();
      if (chunks.length === 0) return;
    }

    // 1. Find the chunk that contains the centerline point nearest the car.
    //    Per-point search is more reliable than centroid distance on long /
    //    curved chunks, where centroids can be far from the actual path.
    let curIdx = 0;
    let bestD2 = Infinity;
    for (let i = 0; i < chunks.length; i++) {
      const cl = chunks[i].centerline;
      for (let j = 0; j < cl.length; j++) {
        const d2 = distance2(carPos.x, carPos.z, cl[j].x, cl[j].z);
        if (d2 < bestD2) {
          bestD2 = d2;
          curIdx = i;
        }
      }
    }

    // 2. Recycle chunks too far behind. Keep BEHIND_KEEP chunks before the
    //    current one as a safety margin so the car doesn't fall off the
    //    world if it briefly reverses or skids backward.
    while (curIdx > BEHIND_KEEP) {
      disposeChunk(chunks[0], world);
      chunks.shift();
      curIdx -= 1;
    }

    // 3. Stream ahead: build chunks one at a time until we have AHEAD_CHUNKS
    //    chunks live in front of the car's current chunk. We may build more
    //    than one per frame to recover from a single dropped frame, but cap
    //    it so a long pause doesn't stall the main thread.
    let toBuild = AHEAD_CHUNKS - (chunks.length - 1 - curIdx);
    let safety = 4;
    while (toBuild > 0 && safety-- > 0) {
      ensureSegments();
      const built = buildOneChunk();
      if (!built) break;
      toBuild -= 1;
    }
  }

  function ensureSegments(): void {
    while (segments.length - nextSegToBuild < SEGMENTS_PER_CHUNK) pullSegment();
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  function dispose(): void {
    for (const c of chunks) disposeChunk(c, world);
    chunks.length = 0;
    root.dispose(false, true);
  }

  return { spawn, centerline: fullCenterline, update, dispose };
}

// ── chunk construction ────────────────────────────────────────────────────

function buildChunk(
  scene: import("@babylonjs/core").Scene,
  world: RAPIER.World,
  rapier: typeof RAPIER,
  materials: import("../render/scene").Materials,
  centerline: ReadonlyArray<Vec2>,
  parent: TransformNode,
  index: number,
): Chunk {
  const half = ROAD_WIDTH / 2;
  const halfEdge = EDGE_WIDTH / 2;
  const n = centerline.length;

  // Simple per-point offset: take the tangent at each centerline point,
  // rotate it 90° to get the normal, then extend left/right by half-width.
  // Connect consecutive pairs into quads. The endless generator already
  // limits curvature, so the offset ribbon never self-intersects.

  const roadPos: number[] = [];
  const roadIdx: number[] = [];
  const edgePos: number[] = [];
  const edgeIdx: number[] = [];

  for (let i = 0; i < n; i++) {
    const c = centerline[i];
    const t = tangentAt(centerline, i);
    const nx = t.z, nz = -t.x;
    // Road: left and right offset by `half`.
    roadPos.push(c.x + nx * half, ROAD_Y, c.z + nz * half);
    roadPos.push(c.x - nx * half, ROAD_Y, c.z - nz * half);
    // Edges: four points per sample (outer-L, inner-L, inner-R, outer-R).
    edgePos.push(
      c.x + nx * (half + halfEdge), EDGE_Y, c.z + nz * (half + halfEdge),
      c.x + nx * (half - halfEdge), EDGE_Y, c.z + nz * (half - halfEdge),
      c.x - nx * (half - halfEdge), EDGE_Y, c.z - nz * (half - halfEdge),
      c.x - nx * (half + halfEdge), EDGE_Y, c.z - nz * (half + halfEdge),
    );
  }

  for (let i = 0; i < n - 1; i++) {
    const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
    roadIdx.push(a, c, b, b, c, d);
    const s = i * 4;
    edgeIdx.push(s, s + 4, s + 1, s + 1, s + 4, s + 5);     // left edge
    edgeIdx.push(s + 2, s + 6, s + 3, s + 3, s + 6, s + 7); // right edge
  }

  const meshes: Mesh[] = [];
  const matClones: StandardMaterial[] = [];

  const roadMesh = makeMesh(`endless.road.${index}`, scene, roadPos, roadIdx, materials.road, -1);
  roadMesh.parent = parent;
  meshes.push(roadMesh);
  matClones.push(roadMesh.material as StandardMaterial);

  const edgeMesh = makeMesh(`endless.edge.${index}`, scene, edgePos, edgeIdx, materials.roadEdge, -3);
  edgeMesh.parent = parent;
  meshes.push(edgeMesh);
  matClones.push(edgeMesh.material as StandardMaterial);

  // Center dashed line.
  const dashLen = 2.5, gapLen = 5.0, dashHalf = 0.12;
  const dashPos: number[] = [];
  const dashIdx: number[] = [];
  let d = 0;
  let dashOn = true;
  let cursor = 0;
  for (let i = 1; i < n; i++) {
    const seg = Math.hypot(centerline[i].x - centerline[i - 1].x, centerline[i].z - centerline[i - 1].z);
    const segEnd = d + seg;
    while (cursor < segEnd) {
      const tt = (cursor - d) / seg;
      const cxp = centerline[i - 1].x + (centerline[i].x - centerline[i - 1].x) * tt;
      const czp = centerline[i - 1].z + (centerline[i].z - centerline[i - 1].z) * tt;
      const advance = dashOn ? dashLen : gapLen;
      const t2 = Math.min(1, (cursor + advance - d) / seg);
      const ex = centerline[i - 1].x + (centerline[i].x - centerline[i - 1].x) * t2;
      const ez = centerline[i - 1].z + (centerline[i].z - centerline[i - 1].z) * t2;
      if (dashOn) {
        const dxp = ex - cxp, dzp = ez - czp;
        const ln = Math.hypot(dxp, dzp) || 1;
        const nnx = dzp / ln, nnz = -dxp / ln;
        const base = dashPos.length / 3;
        dashPos.push(cxp + nnx * dashHalf, ROAD_Y + 0.01, czp + nnz * dashHalf);
        dashPos.push(cxp - nnx * dashHalf, ROAD_Y + 0.01, czp - nnz * dashHalf);
        dashPos.push(ex + nnx * dashHalf, ROAD_Y + 0.01, ez + nnz * dashHalf);
        dashPos.push(ex - nnx * dashHalf, ROAD_Y + 0.01, ez - nnz * dashHalf);
        dashIdx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
      }
      cursor += advance;
      dashOn = !dashOn;
      if (t2 >= 1) break;
    }
    d = segEnd;
  }
  if (dashPos.length > 0) {
    const dashMesh = makeMesh(`endless.dash.${index}`, scene, dashPos, dashIdx, materials.roadEdge, -2);
    dashMesh.parent = parent;
    meshes.push(dashMesh);
    matClones.push(dashMesh.material as StandardMaterial);
  }

  // Physics: trimesh of the road surface only.
  const vertices = new Float32Array(roadPos);
  const indices = new Uint32Array(roadIdx);
  const trimeshDesc = rapier.ColliderDesc.trimesh(vertices, indices).setFriction(1.1);
  const body = world.createRigidBody(rapier.RigidBodyDesc.fixed());
  const collider = world.createCollider(trimeshDesc, body);

  // Centroid (cheap, used for nearest-chunk lookup).
  let cx = 0, cz = 0;
  for (const p of centerline) { cx += p.x; cz += p.z; }
  cx /= centerline.length;
  cz /= centerline.length;

  return {
    index,
    centerline,
    centerX: cx,
    centerZ: cz,
    meshes,
    body,
    collider,
    materialClones: matClones,
  };
}

function makeMesh(
  name: string,
  scene: import("@babylonjs/core").Scene,
  positions: number[],
  indices: number[],
  baseMat: StandardMaterial,
  zOffset: number,
): Mesh {
  const mesh = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  // Flat up-facing normals for our flat-shaded minimalist look. Avoids dark
  // patches that ComputeNormals can produce on near-degenerate triangles.
  const normals: number[] = [];
  for (let i = 0; i < positions.length / 3; i++) normals.push(0, 1, 0);
  vd.normals = normals;
  vd.applyToMesh(mesh, false);
  const m = baseMat.clone(`${name}.mat`);
  m.backFaceCulling = true;
  m.zOffset = zOffset;
  mesh.material = m;
  return mesh;
}

function disposeChunk(c: Chunk, world: RAPIER.World): void {
  for (const m of c.meshes) m.dispose();
  for (const mat of c.materialClones) mat.dispose();
  world.removeCollider(c.collider, false);
  world.removeRigidBody(c.body);
}
