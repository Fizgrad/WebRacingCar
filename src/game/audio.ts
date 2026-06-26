/**
 * Procedural engine sound using the Web Audio API.
 *
 * Simulates a flat-six (Porsche) engine: fundamental + harmonics modulated
 * by speed (RPM) and throttle. No external audio files.
 */
export class EngineAudio {
  readonly ctx: AudioContext;
  private masterGain: GainNode;
  private oscs: OscillatorNode[];
  private gainNodes: GainNode[];
  private running = false;
  private enabled = false;

  // Harmonics relative amplitudes for a flat-six timbre.
  private static readonly HARMONICS = [
    { mult: 1.0, amp: 0.55 },  // fundamental
    { mult: 2.0, amp: 0.35 },  // 2nd harmonic
    { mult: 3.0, amp: 0.18 },  // 3rd
    { mult: 4.0, amp: 0.09 },  // 4th
    { mult: 0.5, amp: 0.22 },  // sub-harmonic (growl)
  ];

  /** Speed → RPM mapping. 0 m/s = 900 RPM idle, 85 m/s ≈ 7400 RPM redline. */
  private static readonly SPEED_TO_RPM = 76.5;

  constructor() {
    this.ctx = new AudioContext();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0;
    this.masterGain.connect(this.ctx.destination);

    this.oscs = [];
    this.gainNodes = [];

    // Create oscillators per harmonic.
    for (const h of EngineAudio.HARMONICS) {
      const osc = this.ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = 40 * h.mult;
      osc.start();

      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.masterGain);
      osc.connect(gain);

      this.oscs.push(osc);
      this.gainNodes.push(gain);
    }
  }

  /** Call every frame. `throttle` 0–1, `speedMs` in m/s (world velocity). */
  update(throttle: number, speedMs: number, _dt: number): void {
    // Auto-resume on first user interaction (browser policy).
    if (this.ctx.state === "suspended") {
      this.ctx.resume();
    }

    const absSpeed = Math.max(0, Math.abs(speedMs));
    const rpm = 900 + absSpeed * EngineAudio.SPEED_TO_RPM; // idle ~900, redline ~7400
    const rpmClamped = Math.min(rpm, 7800);
    const baseFreq = (rpmClamped * 3) / 60; // 6-cyl 4-stroke → 3 pulses / rev

    const volume = 0.07 + throttle * 0.13; // 0.07 idle, 0.20 full throttle

    // Smooth target on the master gain.
    const targetGain = this.enabled ? volume : 0;
    const currentGain = this.masterGain.gain.value;
    this.masterGain.gain.setValueAtTime(currentGain, this.ctx.currentTime);
    this.masterGain.gain.linearRampToValueAtTime(targetGain, this.ctx.currentTime + 0.05);

    for (let i = 0; i < this.oscs.length; i++) {
      const h = EngineAudio.HARMONICS[i];
      const freq = baseFreq * h.mult;
      this.oscs[i].frequency.setValueAtTime(freq, this.ctx.currentTime);
      this.gainNodes[i].gain.setValueAtTime(h.amp * volume, this.ctx.currentTime);
    }

    this.enabled = absSpeed > 0.2 || throttle > 0.01;
  }

  start(): void {
    if (!this.running) {
      this.ctx.resume();
      this.running = true;
    }
  }

  dispose(): void {
    for (const osc of this.oscs) osc.stop();
    this.masterGain.disconnect();
    this.ctx.close();
  }
}

/**
 * Tire screech synthesised from band-passed white noise.
 *
 * `slip` — 0–1 measure of lateral tyre scrub (0 = grip, 1 = fully sliding).
 * `speedMs` — vehicle speed in m/s (controls pitch and intensity).
 */
export class TireScreech {
  private ctx: AudioContext;
  private noiseNode: AudioBufferSourceNode | null = null;
  private bandPass: BiquadFilterNode;
  private gainNode: GainNode;

  constructor(audioCtx: AudioContext) {
    this.ctx = audioCtx;
    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = 0;

    this.bandPass = this.ctx.createBiquadFilter();
    this.bandPass.type = "bandpass";
    this.bandPass.frequency.value = 800;
    this.bandPass.Q.value = 1.2;

    this.bandPass.connect(this.gainNode);
    this.gainNode.connect(this.ctx.destination);
  }

  update(slip: number, speedMs: number): void {
    if (this.ctx.state === "suspended") return;

    const absSpeed = Math.abs(speedMs);
    const active = slip > 0.1 && absSpeed > 1.0;

    if (!active) {
      if (this.noiseNode) {
        try { this.noiseNode.stop(); } catch { /* already stopped */ }
        this.noiseNode = null;
      }
      this.gainNode.gain.setValueAtTime(0, this.ctx.currentTime);
      return;
    }

    // Re-create noise buffer periodically (AudioBufferSourceNode is one-shot).
    if (!this.noiseNode) {
      this.startNoise();
    }

    // Pitch: higher speed → higher tire squeal.
    const pitch = 400 + slip * 1400 + absSpeed * 18;
    this.bandPass.frequency.setValueAtTime(Math.min(pitch, 4000), this.ctx.currentTime);

    // Volume: slip × speed intensity.
    const vol = Math.min(0.22, slip * 0.25 * Math.min(1, absSpeed / 25));
    this.gainNode.gain.setValueAtTime(vol, this.ctx.currentTime);
  }

  private startNoise(): void {
    const sampleRate = this.ctx.sampleRate;
    const duration = 2.0; // seconds — longer than a frame, we recreate on expiry
    const length = sampleRate * duration;
    const buffer = this.ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.connect(this.bandPass);
    src.start();
    this.noiseNode = src;
  }

  dispose(): void {
    try { this.noiseNode?.stop(); } catch { /* ok */ }
    this.bandPass.disconnect();
    this.gainNode.disconnect();
  }
}
