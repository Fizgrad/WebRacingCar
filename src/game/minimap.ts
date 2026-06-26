import type { Vec2 } from "../track/spline";

/**
 * Car-centred top-down minimap.
 *
 * - The view is always centred on the car.
 * - The visible world radius scales with car speed: slow → zoomed in
 *   (close detail), fast → zoomed out (more anticipation).
 * - Only centerline points whose world position falls inside the current
 *   viewport (with a small margin) are drawn each frame, so even very long
 *   tracks (endless mode) cost almost nothing per draw.
 */
export class Minimap {
  private canvas: HTMLCanvasElement;
  private gctx: CanvasRenderingContext2D;
  private size = 180; // CSS px
  private centerline: ReadonlyArray<Vec2> = [];

  /** Smoothed visible-radius (m) so the zoom doesn't jitter with speed. */
  private smoothedRadius = 80;

  // Tunables — view radius (in world meters) at the two endpoints of the
  // speed range. Values in between are interpolated linearly and then low-
  // pass filtered to avoid pumping.
  private static readonly RADIUS_AT_REST = 60;       // m visible at 0 km/h
  private static readonly RADIUS_AT_TOPSPEED = 280;  // m visible at ~300 km/h
  private static readonly TOP_SPEED_MS = 83;         // ≈ 300 km/h
  private static readonly RADIUS_LERP = 4;           // exponential smoothing rate

  constructor(container: HTMLElement) {
    const dpr = window.devicePixelRatio || 1;
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.size * dpr;
    this.canvas.height = this.size * dpr;
    this.canvas.style.position = "fixed";
    this.canvas.style.right = "12px";
    this.canvas.style.top = "12px";
    this.canvas.style.width = `${this.size}px`;
    this.canvas.style.height = `${this.size}px`;
    this.canvas.style.borderRadius = "8px";
    this.canvas.style.background = "rgba(255,255,255,0.85)";
    this.canvas.style.boxShadow = "0 6px 18px rgba(20,30,40,0.18)";
    this.canvas.style.pointerEvents = "none";
    this.canvas.style.display = "none";
    container.appendChild(this.canvas);

    const c = this.canvas.getContext("2d");
    if (!c) throw new Error("Failed to acquire 2D context for minimap");
    c.scale(dpr, dpr);
    this.gctx = c;
  }

  setCenterline(points: ReadonlyArray<Vec2>): void {
    this.centerline = points;
  }

  show(): void { this.canvas.style.display = "block"; }
  hide(): void { this.canvas.style.display = "none"; }

  /**
   * Draw the minimap.
   * `speedMs` is the car's speed in m/s (used to set zoom).
   * `dt` is the frame delta in seconds (for smoothing the zoom).
   */
  draw(carX: number, carZ: number, yaw: number, speedMs: number, dt: number): void {
    const ctx = this.gctx;
    const s = this.size;

    // Target visible radius based on speed.
    const tNorm = Math.min(1, Math.max(0, speedMs / Minimap.TOP_SPEED_MS));
    const targetRadius =
      Minimap.RADIUS_AT_REST + (Minimap.RADIUS_AT_TOPSPEED - Minimap.RADIUS_AT_REST) * tNorm;
    const lerp = 1 - Math.exp(-Minimap.RADIUS_LERP * Math.max(0.001, dt));
    this.smoothedRadius += (targetRadius - this.smoothedRadius) * lerp;
    const r = this.smoothedRadius;

    // Pixels per meter so that `r` meters fit in half the canvas.
    const ppm = (s / 2) / r;
    const cx = s / 2;
    const cy = s / 2;

    ctx.clearRect(0, 0, s, s);

    // Track polyline — convert world deltas into car-local space first.
    // local +X = car right, local +Z = car forward. The minimap is heading-up:
    // forward is always screen up, right is always screen right.
    const sy = Math.sin(yaw);
    const cyaw = Math.cos(yaw);
    if (this.centerline.length >= 2) {
      ctx.lineWidth = 4;
      ctx.strokeStyle = "#3a3f47";
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();

      const margin = r + 5;
      let pen = false;
      for (let i = 0; i < this.centerline.length; i++) {
        const p = this.centerline[i];
        const dx = p.x - carX;
        const dz = p.z - carZ;
        const localX = dx * cyaw - dz * sy;
        const localZ = dx * sy + dz * cyaw;
        const inView = Math.abs(localX) < margin && Math.abs(localZ) < margin;
        if (inView) {
          const px = cx + localX * ppm;
          const py = cy - localZ * ppm;
          if (!pen) {
            ctx.moveTo(px, py);
            pen = true;
          } else {
            ctx.lineTo(px, py);
          }
        } else if (pen) {
          pen = false;
        }
      }
      ctx.stroke();

      drawDotIfVisible(ctx, this.centerline[0], carX, carZ, yaw, r, cx, cy, ppm, "#33b256");
      drawDotIfVisible(
        ctx, this.centerline[this.centerline.length - 1],
        carX, carZ, yaw, r, cx, cy, ppm, "#d94633",
      );
    }

    // Car marker — heading-up minimap, so the car always points upward.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = "#d94633";
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 5);
    ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#1f2933";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();

    // North arrow / "scale" hint at bottom-left.
    ctx.fillStyle = "rgba(31,41,51,0.55)";
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(`${(r * 2).toFixed(0)} m`, 8, s - 8);
  }

  dispose(): void {
    this.canvas.remove();
  }
}

function drawDotIfVisible(
  ctx: CanvasRenderingContext2D,
  p: { x: number; z: number },
  carX: number,
  carZ: number,
  yaw: number,
  radius: number,
  cx: number,
  cy: number,
  ppm: number,
  color: string,
): void {
  const dx = p.x - carX;
  const dz = p.z - carZ;
  const sy = Math.sin(yaw);
  const cyaw = Math.cos(yaw);
  const localX = dx * cyaw - dz * sy;
  const localZ = dx * sy + dz * cyaw;
  if (Math.abs(localX) >= radius || Math.abs(localZ) >= radius) return;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx + localX * ppm, cy - localZ * ppm, 3.5, 0, Math.PI * 2);
  ctx.fill();
}
