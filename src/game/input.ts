export interface InputState {
  throttle: number; // 0..1
  brake: number; // 0..1
  steer: number; // -1..1 (left negative, right positive)
  handbrake: boolean;
  reset: boolean;
}

/**
 * Touch input bound to on-screen pedals (throttle / brake) and device-
 * orientation tilt for steering. Coexists with keyboard input — whichever
 * source has the strongest signal each frame wins.
 *
 * iOS Safari hides DeviceOrientationEvent behind a permission prompt that
 * can only be requested from a user gesture. We expose `requestMotion()` so
 * the UI can call it from a button tap.
 */
export interface MobileBindings {
  /** Bind a DOM element as the throttle pedal (held = 1, released = 0). */
  bindThrottle(el: HTMLElement): void;
  /** Bind a DOM element as the brake pedal. */
  bindBrake(el: HTMLElement): void;
  /** Request DeviceOrientation permission (iOS) and start tilt steering. */
  requestMotion(): Promise<boolean>;
  /** True once tilt steering is actively receiving data. */
  isTiltActive(): boolean;
}

/**
 * Map a tilt angle (γ, degrees) into a steering value in -1..1.
 * Below the dead zone we return 0 to avoid drift; past the full-lock angle
 * we clamp. The shape between is linear — easy to predict while driving.
 */
function tiltToSteer(gammaDeg: number, deadDeg: number, fullDeg: number): number {
  const a = Math.abs(gammaDeg);
  if (a < deadDeg) return 0;
  const t = Math.min(1, (a - deadDeg) / (fullDeg - deadDeg));
  return gammaDeg < 0 ? -t : t;
}

function readLandscapeAwareTilt(e: DeviceOrientationEvent): number | null {
  const angle = screen.orientation?.angle ?? getLegacyOrientationAngle();
  const beta = e.beta;
  const gamma = e.gamma;
  if ((angle === 90 || angle === -270) && beta != null) return beta;
  if ((angle === -90 || angle === 270) && beta != null) return -beta;
  if (gamma != null) return gamma;
  if (beta != null) return beta;
  return null;
}

function getLegacyOrientationAngle(): number {
  const w = window as Window & { orientation?: number };
  return typeof w.orientation === "number" ? w.orientation : 0;
}

export class Input implements MobileBindings {
  private keys = new Set<string>();
  state: InputState = {
    throttle: 0,
    brake: 0,
    steer: 0,
    handbrake: false,
    reset: false,
  };

  private steerSmoothed = 0;

  // Touch button hold states.
  private touchThrottle = 0;
  private touchBrake = 0;
  private cleanupFns: Array<() => void> = [];

  // Tilt steering.
  private tiltActive = false;
  private tiltSteer = 0;
  private tiltNeutral: number | null = null;
  private readonly tiltDeadDeg = 4;
  private readonly tiltFullDeg = 28;

  constructor() {
    window.addEventListener("keydown", this.onDown);
    window.addEventListener("keyup", this.onUp);
    window.addEventListener("blur", this.clear);
  }

  private onDown = (e: KeyboardEvent) => {
    this.keys.add(e.code);
    if (e.code === "KeyR") this.state.reset = true;
  };
  private onUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };
  private clear = () => {
    this.keys.clear();
    this.touchThrottle = 0;
    this.touchBrake = 0;
  };

  // ── touch pedals ────────────────────────────────────────────────────────

  bindThrottle(el: HTMLElement): void {
    this.bindHoldButton(el, (v) => { this.touchThrottle = v; });
  }
  bindBrake(el: HTMLElement): void {
    this.bindHoldButton(el, (v) => { this.touchBrake = v; });
  }

  private bindHoldButton(el: HTMLElement, set: (v: number) => void): void {
    const press = (e: Event) => {
      e.preventDefault();
      set(1);
      el.classList.add("pressed");
    };
    const release = (e: Event) => {
      e.preventDefault();
      set(0);
      el.classList.remove("pressed");
    };
    const preventTouch = (e: TouchEvent) => e.preventDefault();
    const preventContext = (e: Event) => e.preventDefault();
    el.addEventListener("pointerdown", press);
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
    el.addEventListener("pointerleave", release);
    el.addEventListener("touchstart", preventTouch, { passive: false });
    el.addEventListener("contextmenu", preventContext);
    this.cleanupFns.push(() => {
      el.removeEventListener("pointerdown", press);
      el.removeEventListener("pointerup", release);
      el.removeEventListener("pointercancel", release);
      el.removeEventListener("pointerleave", release);
      el.removeEventListener("touchstart", preventTouch);
      el.removeEventListener("contextmenu", preventContext);
    });
  }

  // ── tilt steering ───────────────────────────────────────────────────────

  async requestMotion(): Promise<boolean> {
    type IOSDOE = typeof DeviceOrientationEvent & {
      requestPermission?: () => Promise<"granted" | "denied">;
    };
    const DOE = window.DeviceOrientationEvent as IOSDOE | undefined;
    if (!DOE) return false;
    try {
      if (typeof DOE.requestPermission === "function") {
        const res = await DOE.requestPermission();
        if (res !== "granted") return false;
      }
    } catch {
      return false;
    }
    window.removeEventListener("deviceorientation", this.onOrientation, true);
    window.addEventListener("deviceorientation", this.onOrientation, true);
    this.tiltNeutral = null;
    this.tiltActive = true;
    return true;
  }

  isTiltActive(): boolean {
    return this.tiltActive;
  }

  private onOrientation = (e: DeviceOrientationEvent) => {
    const raw = readLandscapeAwareTilt(e);
    if (raw == null) return;
    if (this.tiltNeutral == null) this.tiltNeutral = raw;
    this.tiltSteer = tiltToSteer(raw - this.tiltNeutral, this.tiltDeadDeg, this.tiltFullDeg);
    this.tiltActive = true;
  };

  // ── per-frame update ────────────────────────────────────────────────────

  update(dt: number) {
    const up = this.keys.has("KeyW") || this.keys.has("ArrowUp");
    const down = this.keys.has("KeyS") || this.keys.has("ArrowDown");
    const left = this.keys.has("KeyA") || this.keys.has("ArrowLeft");
    const right = this.keys.has("KeyD") || this.keys.has("ArrowRight");

    // Throttle/brake: whichever source is pressing harder wins.
    this.state.throttle = Math.max(up ? 1 : 0, this.touchThrottle);
    this.state.brake = Math.max(down ? 1 : 0, this.touchBrake);

    // Steering target: keyboard if any arrow key held, otherwise tilt.
    let target: number;
    if (left || right) {
      target = (left ? -1 : 0) + (right ? 1 : 0);
    } else if (this.tiltActive) {
      target = this.tiltSteer;
    } else {
      target = 0;
    }

    // Smooth steering toward target; faster return-to-center.
    const rate = target === 0 ? 6 : 4;
    this.steerSmoothed += (target - this.steerSmoothed) * Math.min(1, rate * dt);
    this.state.steer = this.steerSmoothed;

    this.state.handbrake = this.keys.has("Space");
  }

  consumeReset(): boolean {
    const r = this.state.reset;
    this.state.reset = false;
    return r;
  }

  triggerReset(): void {
    this.state.reset = true;
  }

  dispose() {
    window.removeEventListener("keydown", this.onDown);
    window.removeEventListener("keyup", this.onUp);
    window.removeEventListener("blur", this.clear);
    window.removeEventListener("deviceorientation", this.onOrientation, true);
    for (const fn of this.cleanupFns) fn();
    this.cleanupFns = [];
  }
}
