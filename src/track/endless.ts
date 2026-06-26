/**
 * Endless track generator.
 *
 * A deterministic stream of road segments (straights + arcs) driven by a
 * seeded PRNG. Segments are emitted as runs of (x, z) centerline points along
 * a forward-moving "cursor". Visual + collision are built in chunks, so
 * memory stays bounded as the player drives forward.
 */

import type { Vec2 } from "./spline";

export interface Segment {
  /** Cumulative arc-length from the start of the track to the BEGIN of this segment. */
  startDistance: number;
  /** Length of this segment along the centerline. */
  length: number;
  /** Centerline samples for this segment, every ~`step` meters. Includes both ends. */
  points: Vec2[];
  /** Heading (rad) at the END of the segment, in world XZ. */
  endHeading: number;
  /** End position of the segment in world XZ. */
  endX: number;
  endZ: number;
}

/** Soft cap on the cumulative heading deviation from the original direction.
 *  Going much past this would let the track loop back on itself; we want it
 *  to keep flowing forward. ~60° is enough to give variety without u-turns. */
const MAX_HEADING_RAD = Math.PI / 3; // 60°

export class EndlessTrackGenerator {
  /** Cursor: where the next segment will start. */
  private x = 0;
  private z = 0;
  private heading = 0; // rad — world XZ angle, 0 = +Z, π/2 = +X (right-handed)
  private distance = 0;

  private rng: () => number;
  private segmentIndex = 0;

  /** Sample step in meters for the centerline polyline. */
  static readonly STEP = 1.5;

  constructor(seed: number, opts?: { startX?: number; startZ?: number; startHeading?: number }) {
    this.rng = mulberry32(seed >>> 0);
    if (opts?.startX !== undefined) this.x = opts.startX;
    if (opts?.startZ !== undefined) this.z = opts.startZ;
    if (opts?.startHeading !== undefined) this.heading = opts.startHeading;
  }

  /**
   * Generate the next segment from the cursor; advance the cursor.
   *
   * Two constraints we honour:
   *   1. Junction continuity: each segment starts at the previous one's
   *      end position + heading, so there are no kinks at joins.
   *   2. Forward bias: the cumulative heading is gently restored toward 0
   *      so the track always flows along +Z. When |heading| approaches
   *      MAX_HEADING_RAD the next arc is FORCED to bend back toward 0.
   */
  next(): Segment {
    const i = this.segmentIndex++;
    if (i === 0) return this.straight(160);
    if (i === 1) return this.straight(120);

    const r = this.rng();
    if (r < 0.50) {
      const len = 80 + this.rng() * 160;
      return this.straight(len);
    }
    if (r < 0.94) return this.arcWithBias();
    return this.chicane();
  }

  /** Pick an arc whose direction biases the heading back toward 0. */
  private arcWithBias(): Segment {
    // Probability the arc bends toward zero (i.e. correcting). Linearly
    // increases from 0.5 (neutral, at heading=0) to 1.0 (always corrects)
    // as |heading| approaches MAX_HEADING_RAD.
    const tNorm = Math.min(1, Math.abs(this.heading) / MAX_HEADING_RAD);
    const correctBias = 0.5 + 0.5 * tNorm;
    // "Correcting" means turn toward heading=0:
    //   if heading > 0  → need negative dHeading → dir = -1 (left)
    //   if heading < 0  → need positive dHeading → dir = +1 (right)
    const correctingDir: -1 | 1 = this.heading > 0 ? -1 : 1;
    const wantCorrect = this.rng() < correctBias;
    const dir: -1 | 1 = wantCorrect ? correctingDir : (correctingDir === 1 ? -1 : 1);

    // Choose a sweep that doesn't blow past MAX_HEADING_RAD if we're not
    // correcting. Cap so heading never exceeds the soft limit.
    let sweepDeg = 12 + this.rng() * 28; // 12°–40°
    let sweepRad = (sweepDeg * Math.PI) / 180;

    const projected = this.heading + dir * sweepRad;
    if (Math.abs(projected) > MAX_HEADING_RAD) {
      // Clamp the sweep so heading lands at most AT the cap, with a tiny
      // margin to leave room for next segment's randomness.
      const target = Math.sign(projected) * (MAX_HEADING_RAD - 0.05);
      sweepRad = Math.max(0.12, Math.abs(target - this.heading));
      sweepDeg = (sweepRad * 180) / Math.PI;
      // If sweep collapsed to nothing, just emit a short straight instead.
      if (sweepRad < 0.15) return this.straight(60 + this.rng() * 60);
    }

    const radius = 70 + this.rng() * 130; // 70–200 m
    return this.arc(radius, sweepRad, dir);
  }

  /** Chicane: arc one way, then opposite arc — net heading change is small. */
  private chicane(): Segment {
    const r1 = 80 + this.rng() * 60;
    const r2 = 80 + this.rng() * 60;
    const sweep = ((10 + this.rng() * 16) * Math.PI) / 180;
    const dir: -1 | 1 = this.heading > 0 ? -1 : 1; // start by correcting
    const oppo: -1 | 1 = dir === 1 ? -1 : 1;

    const a = this.arc(r1, sweep, dir);
    const b = this.arc(r2, sweep, oppo);
    a.points.pop();
    for (const p of b.points) a.points.push(p);
    a.length += b.length;
    a.endHeading = b.endHeading;
    a.endX = b.endX;
    a.endZ = b.endZ;
    return a;
  }

  // ── primitives ──

  private straight(len: number): Segment {
    const startD = this.distance;
    const points: Vec2[] = [];
    const steps = Math.max(2, Math.ceil(len / EndlessTrackGenerator.STEP));
    const dx = Math.sin(this.heading);
    const dz = Math.cos(this.heading);
    for (let s = 0; s <= steps; s++) {
      const t = (s / steps) * len;
      points.push({ x: this.x + dx * t, z: this.z + dz * t });
    }
    this.x += dx * len;
    this.z += dz * len;
    this.distance += len;
    return {
      startDistance: startD,
      length: len,
      points,
      endHeading: this.heading,
      endX: this.x,
      endZ: this.z,
    };
  }

  private arc(radius: number, sweepRad: number, dir: -1 | 1): Segment {
    const startD = this.distance;
    const arcLen = radius * sweepRad;
    const steps = Math.max(8, Math.ceil(arcLen / EndlessTrackGenerator.STEP));

    const nx = dir === 1 ? Math.cos(this.heading) : -Math.cos(this.heading);
    const nz = dir === 1 ? -Math.sin(this.heading) : Math.sin(this.heading);
    const cx = this.x + nx * radius;
    const cz = this.z + nz * radius;

    // Initial angle from center to current cursor.
    const phi0 = Math.atan2(this.z - cz, this.x - cx);
    const points: Vec2[] = [];
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      // dir = +1 (right) sweeps phi DECREASING (CW). dir = -1 sweeps INCREASING.
      const phi = phi0 + (dir === 1 ? -1 : +1) * sweepRad * t;
      const px = cx + Math.cos(phi) * radius;
      const pz = cz + Math.sin(phi) * radius;
      points.push({ x: px, z: pz });
    }
    const last = points[points.length - 1];
    this.x = last.x;
    this.z = last.z;
    this.heading += (dir === 1 ? +1 : -1) * sweepRad;
    this.distance += arcLen;
    return {
      startDistance: startD,
      length: arcLen,
      points,
      endHeading: this.heading,
      endX: this.x,
      endZ: this.z,
    };
  }

  // ── inspection ──

  get cursor(): { x: number; z: number; heading: number; distance: number } {
    return { x: this.x, z: this.z, heading: this.heading, distance: this.distance };
  }
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
