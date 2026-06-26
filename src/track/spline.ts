/**
 * 2D polyline utilities for the track designer:
 *   - distance-based resampling (denoise / uniformize)
 *   - Catmull-Rom interpolation
 *
 * All points are (x, z) — the track lies in the XZ plane at y=0.
 */

export interface Vec2 {
  x: number;
  z: number;
}

export function distance(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Drop points that are closer than `minStep` to the previous accepted point. */
export function dedupe(points: ReadonlyArray<Vec2>, minStep: number): Vec2[] {
  if (points.length === 0) return [];
  const out: Vec2[] = [{ x: points[0].x, z: points[0].z }];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (distance(out[out.length - 1], p) >= minStep) {
      out.push({ x: p.x, z: p.z });
    }
  }
  return out;
}

/**
 * Resample a polyline so consecutive samples are exactly `step` apart along
 * the polyline (last segment may be slightly shorter).
 */
export function resampleByArcLength(points: ReadonlyArray<Vec2>, step: number): Vec2[] {
  if (points.length < 2) return points.map((p) => ({ x: p.x, z: p.z }));
  const out: Vec2[] = [{ x: points[0].x, z: points[0].z }];
  let acc = 0;
  let prev = points[0];
  for (let i = 1; i < points.length; i++) {
    const curr = points[i];
    let segLen = distance(prev, curr);
    while (acc + segLen >= step) {
      const t = (step - acc) / segLen;
      const nx = prev.x + (curr.x - prev.x) * t;
      const nz = prev.z + (curr.z - prev.z) * t;
      out.push({ x: nx, z: nz });
      prev = { x: nx, z: nz };
      segLen = distance(prev, curr);
      acc = 0;
    }
    acc += segLen;
    prev = curr;
  }
  // Always keep the original last point.
  const last = points[points.length - 1];
  if (distance(out[out.length - 1], last) > 1e-3) {
    out.push({ x: last.x, z: last.z });
  }
  return out;
}

/**
 * Catmull-Rom spline through `controls`. Returns ~`samplesPerSeg` interior
 * points per segment plus the endpoints. Uniform parameterization (tension=0.5
 * is the classic value baked into the formula below).
 *
 * Endpoint handling: virtual control points are reflected across the endpoints
 * so the curve starts/ends exactly at the first/last control point with a
 * sensible tangent.
 */
export function catmullRom(controls: ReadonlyArray<Vec2>, samplesPerSeg: number): Vec2[] {
  if (controls.length < 2) return controls.map((p) => ({ x: p.x, z: p.z }));
  const n = controls.length;
  const get = (i: number): Vec2 => {
    if (i < 0) {
      const a = controls[0];
      const b = controls[1];
      return { x: 2 * a.x - b.x, z: 2 * a.z - b.z };
    }
    if (i >= n) {
      const a = controls[n - 1];
      const b = controls[n - 2];
      return { x: 2 * a.x - b.x, z: 2 * a.z - b.z };
    }
    return controls[i];
  };

  const out: Vec2[] = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    const p3 = get(i + 2);
    const steps = i === n - 2 ? samplesPerSeg + 1 : samplesPerSeg;
    for (let s = 0; s < steps; s++) {
      const t = s / samplesPerSeg;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 *
        (2 * p1.x +
          (-p0.x + p2.x) * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const z =
        0.5 *
        (2 * p1.z +
          (-p0.z + p2.z) * t +
          (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 +
          (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3);
      out.push({ x, z });
    }
  }
  return out;
}

/** 2D tangent at point i along a polyline. Uses central differences. */
export function tangentAt(points: ReadonlyArray<Vec2>, i: number): Vec2 {
  const n = points.length;
  const prev = points[Math.max(0, i - 1)];
  const next = points[Math.min(n - 1, i + 1)];
  const dx = next.x - prev.x;
  const dz = next.z - prev.z;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len };
}

/**
 * Replace sharp corners with circular arcs.
 *
 * The goal is: every output corner has a circular fillet with radius
 * **at least `minRadius`**. The road ribbon is offset by half-width from
 * the centerline; if any corner's inner radius is smaller than half-width,
 * the inner offset crosses the centerline and the road tears (and the
 * outer edge line ends up inside the road). So `minRadius` must be
 * strictly larger than half the road width.
 *
 * Hand-drawn paths frequently have very short edges between sharp turns,
 * which makes a per-corner local fillet impossible: there isn't enough
 * room on either side to cut back `minRadius / tan(θ/2)` along the edges.
 *
 * Two-pass strategy:
 *   1. Walk the polyline and **drop** any interior vertex whose remaining
 *      edge budget can't support a `minRadius` fillet. Each accepted vertex
 *      records how much edge length it has "consumed" on either side, so
 *      consecutive sharp corners are merged into a single rounded turn
 *      instead of fighting over the same straight piece.
 *   2. Emit the fillet arcs in a second pass.
 */
export function roundSharpCorners(
  points: ReadonlyArray<Vec2>,
  minRadius: number,
  minAngleDeg: number,
  arcSamples = 8,
): Vec2[] {
  if (points.length < 3) return points.map((p) => ({ x: p.x, z: p.z }));
  const minAngle = (minAngleDeg * Math.PI) / 180;

  // Pre-compute edge lengths.
  const n = points.length;
  const edgeLen: number[] = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) edgeLen[i] = distance(points[i], points[i + 1]);

  // First pass: pick which vertices to round and how far to cut back on
  // each side. We greedily consume up to half of each adjacent edge; if
  // the budget required by `minRadius` exceeds that, we still cap at half
  // the edge (so neighbouring corners always have room left for their own
  // fillet), accepting a slightly smaller-than-requested radius. Corners
  // we can't fit at all get **collapsed**: the vertex is dropped and the
  // path is treated as a straight line through it.
  interface Corner {
    vertexIndex: number;
    cut: number;      // distance to cut back along each adjacent edge
    radius: number;   // resulting fillet radius
    theta: number;    // interior angle at vertex
  }
  const corners: Corner[] = [];
  const collapsed = new Set<number>();
  // Per-vertex remaining length on each side of the vertex. Updated as
  // we walk so consecutive corners don't double-spend the same edge.
  const remainingBefore = edgeLen.slice(); // edge i ends at vertex i+1
  const remainingAfter = edgeLen.slice();  // edge i starts at vertex i

  for (let i = 1; i < n - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];

    let ax = prev.x - curr.x, az = prev.z - curr.z;
    let bx = next.x - curr.x, bz = next.z - curr.z;
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 1e-4 || lb < 1e-4) continue;
    ax /= la; az /= la; bx /= lb; bz /= lb;

    const cosTheta = Math.max(-1, Math.min(1, ax * bx + az * bz));
    const theta = Math.acos(cosTheta);
    if (theta >= Math.PI - minAngle) continue; // pretty straight — keep as-is

    const tanHalf = Math.tan(theta / 2);
    if (tanHalf < 1e-4) continue;
    const idealCut = minRadius / tanHalf;

    const budgetA = remainingAfter[i - 1] * 0.5;
    const budgetB = remainingBefore[i] * 0.5;
    const cut = Math.min(idealCut, budgetA, budgetB);
    if (cut < 1e-3) {
      collapsed.add(i);
      continue;
    }

    const radius = cut * tanHalf;
    corners.push({ vertexIndex: i, cut, radius, theta });

    remainingAfter[i - 1] -= cut;
    remainingBefore[i] -= cut;
  }

  // Second pass: emit the polyline, inserting arcs for the corners.
  const out: Vec2[] = [{ x: points[0].x, z: points[0].z }];
  let nextCorner = 0;
  for (let i = 1; i < n - 1; i++) {
    if (nextCorner < corners.length && corners[nextCorner].vertexIndex === i) {
      const c = corners[nextCorner++];
      const prev = points[i - 1];
      const curr = points[i];
      const next = points[i + 1];

      let ax = prev.x - curr.x, az = prev.z - curr.z;
      let bx = next.x - curr.x, bz = next.z - curr.z;
      const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
      ax /= la; az /= la; bx /= lb; bz /= lb;

      const ta = { x: curr.x + ax * c.cut, z: curr.z + az * c.cut };
      const tb = { x: curr.x + bx * c.cut, z: curr.z + bz * c.cut };

      const bisX = ax + bx, bisZ = az + bz;
      const bisLen = Math.hypot(bisX, bisZ);
      if (bisLen < 1e-4) { out.push({ x: curr.x, z: curr.z }); continue; }
      const distCenter = c.radius / Math.sin(c.theta / 2);
      const cx = curr.x + (bisX / bisLen) * distCenter;
      const cz = curr.z + (bisZ / bisLen) * distCenter;

      const a0 = Math.atan2(ta.z - cz, ta.x - cx);
      const a1 = Math.atan2(tb.z - cz, tb.x - cx);
      let dA = a1 - a0;
      while (dA > Math.PI) dA -= 2 * Math.PI;
      while (dA < -Math.PI) dA += 2 * Math.PI;

      out.push(ta);
      for (let s = 1; s < arcSamples; s++) {
        const t = s / arcSamples;
        const a = a0 + dA * t;
        out.push({ x: cx + Math.cos(a) * c.radius, z: cz + Math.sin(a) * c.radius });
      }
      out.push(tb);
    } else if (!collapsed.has(i)) {
      out.push({ x: points[i].x, z: points[i].z });
    }
  }
  out.push({ x: points[n - 1].x, z: points[n - 1].z });
  return out;
}

/**
 * Single-pass Laplacian smoothing: each interior point is moved toward the
 * midpoint of its neighbors by `lambda`. Repeat for `iters` iterations.
 * Endpoints are pinned so the player's drawn start/end aren't lost.
 */
export function laplacianSmooth(
  points: ReadonlyArray<Vec2>,
  lambda: number,
  iters: number,
): Vec2[] {
  if (points.length < 3) return points.map((p) => ({ x: p.x, z: p.z }));
  let cur: Vec2[] = points.map((p) => ({ x: p.x, z: p.z }));
  for (let it = 0; it < iters; it++) {
    const next: Vec2[] = [cur[0]];
    for (let i = 1; i < cur.length - 1; i++) {
      const a = cur[i - 1];
      const b = cur[i];
      const c = cur[i + 1];
      const mx = 0.5 * (a.x + c.x);
      const mz = 0.5 * (a.z + c.z);
      next.push({
        x: b.x + (mx - b.x) * lambda,
        z: b.z + (mz - b.z) * lambda,
      });
    }
    next.push(cur[cur.length - 1]);
    cur = next;
  }
  return cur;
}

/**
 * Adaptive Laplacian smoothing: each pass measures the turn angle at every
 * interior vertex and applies a per-vertex lambda that scales with how sharp
 * the turn is (∝ 1 - cos(θ)). High-curvature vertices get pulled hard toward
 * their neighbor midpoint; near-straight ones are left alone. This preserves
 * long straights while aggressively flattening the kinks a hand-drawn path
 * usually has.
 */
export function adaptiveSmooth(
  points: ReadonlyArray<Vec2>,
  baseLambda: number,
  iters: number,
): Vec2[] {
  if (points.length < 3) return points.map((p) => ({ x: p.x, z: p.z }));
  let cur: Vec2[] = points.map((p) => ({ x: p.x, z: p.z }));
  for (let it = 0; it < iters; it++) {
    const next: Vec2[] = [cur[0]];
    for (let i = 1; i < cur.length - 1; i++) {
      const a = cur[i - 1], b = cur[i], c = cur[i + 1];
      // Direction vectors away from `b`.
      const ax = a.x - b.x, az = a.z - b.z;
      const bx = c.x - b.x, bz = c.z - b.z;
      const la = Math.hypot(ax, az) || 1;
      const lb = Math.hypot(bx, bz) || 1;
      const cos = Math.max(-1, Math.min(1, (ax * bx + az * bz) / (la * lb)));
      // Curvature weight: 0 when straight (cos = -1), 1 when 90° (cos = 0),
      // up to ~2 at hairpins (cos = 1, which means a → b → a folded back).
      const curv = (1 - cos) * 0.5; // in [0, 1]
      const lambda = Math.min(0.9, baseLambda + curv * 0.7);
      const mx = 0.5 * (a.x + c.x);
      const mz = 0.5 * (a.z + c.z);
      next.push({ x: b.x + (mx - b.x) * lambda, z: b.z + (mz - b.z) * lambda });
    }
    next.push(cur[cur.length - 1]);
    cur = next;
  }
  return cur;
}
