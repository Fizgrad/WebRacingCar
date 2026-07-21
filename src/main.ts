import { Quaternion, Vector3 } from "@babylonjs/core";
import { createRenderContext } from "./render/scene";
import { buildSky } from "./render/sky";
import { createPhysicsWorld } from "./physics/world";
import {
  buildGround,
  buildPlayerTrack,
  buildPresetTrack,
  PRESETS,
  type BuiltTrack,
  type Ground,
} from "./track/builder";
import { buildEndlessTrack, type EndlessTrack } from "./track/streamer";
import { TrackDesigner } from "./track/designer";
import { createVehicle, type Vehicle } from "./vehicle/vehicle";
import { CARS, APEX_RS, type CarSpec } from "./vehicle/cars";
import { buildVegetation, type Vegetation } from "./world/vegetation";
import { buildEndlessProps, type EndlessProps } from "./world/endlessProps";
import { buildTerrainFeatures, type TerrainFeatures } from "./world/terrain";
import { Input } from "./game/input";
import { FollowCamera } from "./game/camera";
import { Minimap } from "./game/minimap";
import { EngineAudio, TireScreech } from "./game/audio";
import { createCarPreview, type CarPreview } from "./game/carPreview";
import { RaceTimer, formatLap } from "./game/race";
import { TireEffects } from "./game/tireEffects";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
const hud = document.getElementById("hud");
const designHint = document.getElementById("designHint");
const designPanel = document.getElementById("designPanel");
const curveSlider = document.getElementById("curveSlider") as HTMLInputElement | null;
const segmentMode = document.getElementById("segmentMode") as HTMLSelectElement | null;
const closedTrackToggle = document.getElementById("closedTrackToggle") as HTMLInputElement | null;
const editorHintToggle = document.getElementById("editorHintToggle") as HTMLInputElement | null;
const clearTrackBtn = document.getElementById("clearTrackBtn");
const startTrackBtn = document.getElementById("startTrackBtn");
const designStats = document.getElementById("designStats");
const menuEl = document.getElementById("menu");
const appRoot = document.getElementById("app");
if (!canvas) throw new Error("renderCanvas not found");
if (!appRoot) throw new Error("#app not found");
if (!menuEl) throw new Error("#menu not found");

const ctx = createRenderContext(canvas);
const phys = await createPhysicsWorld();

buildSky(ctx.scene);
const ground: Ground = buildGround(ctx, phys);

const input = new Input();
const followCam = new FollowCamera(ctx.scene, canvas);
const designer = new TrackDesigner(ctx.scene, ctx.engine, canvas);
const minimap = new Minimap(appRoot);
const engineAudio = new EngineAudio();
const tireScreech = new TireScreech(engineAudio.ctx);
const tireEffects = new TireEffects(ctx.scene);
let raceTimer: RaceTimer | null = null;

// ── mobile touch controls ──────────────────────────────────────────────────

const isTouchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0;
const hasMotion = typeof DeviceOrientationEvent !== "undefined";

const btnThrottle = document.getElementById("btnThrottle");
const btnBrake = document.getElementById("btnBrake");
const btnMenu = document.getElementById("btnMenu");
const mobileControls = document.getElementById("mobileControls");
const motionGate = document.getElementById("motionGate");
const motionGateBtn = document.getElementById("motionGateBtn");

const onMobileMenuClick = (): void => {
  if (mode === "drive") showMenu();
};
const onMotionGateClick = async (): Promise<void> => {
  await input.requestMotion();
  motionGate?.classList.remove("visible");
};

if (isTouchDevice && mobileControls) {
  mobileControls.classList.add("visible");

  if (btnThrottle) input.bindThrottle(btnThrottle);
  if (btnBrake) input.bindBrake(btnBrake);

  if (btnMenu) btnMenu.addEventListener("click", onMobileMenuClick);

  if (hasMotion && motionGate && motionGateBtn) {
    motionGate.classList.add("visible");
    motionGateBtn.addEventListener("click", onMotionGateClick, { once: true });
  }
}

type Mode = "menu" | "design" | "drive";
let mode: Mode = "menu";
let track: BuiltTrack | null = null;
let endless: EndlessTrack | null = null;
let vehicle: Vehicle | null = null;
let vegetation: Vegetation | null = null;
let terrainFeatures: TerrainFeatures | null = null;
let endlessProps: EndlessProps | null = null;
let selectedCar: CarSpec = APEX_RS;
let carPreviews: CarPreview[] = [];

// ── menu ──────────────────────────────────────────────────────────────────

let menuStep: "car" | "track" = "car";

function renderMenu(): void {
  for (const p of carPreviews) p.dispose();
  carPreviews = [];
  menuEl!.innerHTML = "";
  if (menuStep === "car") {
    const h = document.createElement("h2");
    h.textContent = "Choose your car";
    menuEl!.appendChild(h);

    for (const car of CARS) {
      const b = document.createElement("button");
      b.className = "opt carOpt";
      const preview = createCarPreview(car);
      carPreviews.push(preview);
      const copy = document.createElement("div");
      copy.className = "carCopy";
      copy.innerHTML = `<strong>${car.label}</strong><span>${car.description}</span>`;
      b.appendChild(preview.canvas);
      b.appendChild(copy);
      b.addEventListener("click", () => {
        selectedCar = car;
        menuStep = "track";
        renderMenu();
      });
      menuEl!.appendChild(b);
    }
  } else {
    const h = document.createElement("h2");
    h.textContent = `Choose a track — ${selectedCar.label}`;
    menuEl!.appendChild(h);

    for (const p of PRESETS) {
      const b = document.createElement("button");
      b.className = "opt";
      b.innerHTML = `<strong>${p.label}</strong><span>${p.description}</span>`;
      b.addEventListener("click", () => enterDriveModePreset(p.id));
      menuEl!.appendChild(b);
    }

    const endlessBtn = document.createElement("button");
    endlessBtn.className = "opt";
    endlessBtn.innerHTML =
      `<strong>Endless Highway</strong>` +
      `<span>Procedural mix of straights, sweepers and chicanes that streams forever from a random seed.</span>`;
    endlessBtn.addEventListener("click", () => enterDriveModeEndless());
    menuEl!.appendChild(endlessBtn);

    const draw = document.createElement("button");
    draw.className = "opt";
    draw.innerHTML =
      `<strong>Custom — Draw Your Own</strong>` +
      `<span>Sketch any path on the ground from a top-down view.</span>`;
    draw.addEventListener("click", () => enterDesignMode());
    menuEl!.appendChild(draw);

    const back = document.createElement("button");
    back.className = "opt";
    back.innerHTML = `<strong>← Back</strong><span>Pick a different car.</span>`;
    back.addEventListener("click", () => {
      menuStep = "car";
      renderMenu();
    });
    menuEl!.appendChild(back);
  }
}
renderMenu();

function showMenu(): void {
  mode = "menu";
  if (vehicle) { vehicle.dispose(); vehicle = null; }
  if (track) { track.dispose(); track = null; }
  if (endless) { endless.dispose(); endless = null; }
  if (vegetation) { vegetation.dispose(); vegetation = null; }
  if (terrainFeatures) { terrainFeatures.dispose(); terrainFeatures = null; }
  if (endlessProps) { endlessProps.dispose(); endlessProps = null; }
  if (raceTimer) { raceTimer.dispose(); raceTimer = null; }
  tireEffects.clear();
  designer.deactivate();
  designHint?.classList.remove("visible");
  designPanel?.classList.remove("visible");
  minimap.hide();
  setMobilePedalsVisible(false);
  menuStep = "car";
  renderMenu();
  menuEl!.classList.add("visible");
}

function setMobilePedalsVisible(v: boolean): void {
  // The container itself stays visible on touch devices (so MENU button works),
  // but we hide the pedals when not actively driving.
  if (!isTouchDevice) return;
  if (btnThrottle) (btnThrottle as HTMLElement).style.display = v ? "" : "none";
  if (btnBrake) (btnBrake as HTMLElement).style.display = v ? "" : "none";
  if (btnMenu) (btnMenu as HTMLElement).style.display = v ? "" : "none";
}

// ── design mode (custom drawing) ──────────────────────────────────────────

function enterDesignMode(): void {
  mode = "design";
  if (vehicle) { vehicle.dispose(); vehicle = null; }
  if (track) { track.dispose(); track = null; }
  if (endless) { endless.dispose(); endless = null; }
  if (vegetation) { vegetation.dispose(); vegetation = null; }
  if (terrainFeatures) { terrainFeatures.dispose(); terrainFeatures = null; }
  if (endlessProps) { endlessProps.dispose(); endlessProps = null; }
  if (raceTimer) { raceTimer.dispose(); raceTimer = null; }
  tireEffects.clear();
  designer.clear();
  designer.activate();
  designHint?.classList.toggle("visible", !!editorHintToggle?.checked);
  designPanel?.classList.add("visible");
  updateDesignStats();
  minimap.hide();
  setMobilePedalsVisible(false);
  menuEl!.classList.remove("visible");
}

// ── drive mode ────────────────────────────────────────────────────────────

function startDrive(built: BuiltTrack): void {
  track = built;
  vehicle = createVehicle(ctx, phys, built.spawn, selectedCar);
  vegetation = buildVegetation(
    ctx.scene,
    built.centerline,
    { x: built.spawn.position.x, z: built.spawn.position.z },
  );
  terrainFeatures = buildTerrainFeatures(
    ctx.scene,
    built.centerline,
    { x: built.spawn.position.x, z: built.spawn.position.z },
  );
  if (raceTimer) raceTimer.dispose();
  raceTimer = new RaceTimer(ctx.scene, built.centerline, built.closed);
  tireEffects.clear();
  ctx.scene.activeCamera = followCam.camera;
  mode = "drive";
  designHint?.classList.remove("visible");
  designPanel?.classList.remove("visible");
  menuEl!.classList.remove("visible");
  minimap.setCenterline(built.centerline);
  minimap.show();
  setMobilePedalsVisible(true);
}

function enterDriveModeFromDesigner(): void {
  const drawn = designer.deactivate();
  if (drawn.length < 2) { designer.activate(); return; }
  const built = buildPlayerTrack(ctx, phys, drawn, { closed: designer.isClosed() });
  if (!built) { designer.activate(); return; }
  startDrive(built);
}

function enterDriveModePreset(presetId: string): void {
  const built = buildPresetTrack(ctx, phys, presetId);
  if (!built) return;
  startDrive(built);
}

function enterDriveModeEndless(): void {
  if (vehicle) { vehicle.dispose(); vehicle = null; }
  if (track) { track.dispose(); track = null; }
  if (endless) { endless.dispose(); endless = null; }
  if (vegetation) { vegetation.dispose(); vegetation = null; }
  if (terrainFeatures) { terrainFeatures.dispose(); terrainFeatures = null; }
  if (endlessProps) { endlessProps.dispose(); endlessProps = null; }
  if (raceTimer) { raceTimer.dispose(); raceTimer = null; }
  tireEffects.clear();

  // Random seed every time. Could expose a seed input later.
  const seed = (Math.random() * 0xffffffff) >>> 0;
  endless = buildEndlessTrack(ctx, phys, seed);
  vehicle = createVehicle(ctx, phys, endless.spawn, selectedCar);
  endlessProps = buildEndlessProps(ctx.scene, seed);
  endlessProps.setCenterline(endless.centerline);
  ctx.scene.activeCamera = followCam.camera;
  mode = "drive";
  designHint?.classList.remove("visible");
  designPanel?.classList.remove("visible");
  menuEl!.classList.remove("visible");
  minimap.setCenterline(endless.centerline);
  minimap.show();
  setMobilePedalsVisible(true);
}

// ── input wiring ──────────────────────────────────────────────────────────

function updateDesignStats(): void {
  if (!designStats) return;
  designStats.textContent = designer.statsText();
}

const onCurveInput = (): void => {
  const value = Number(curveSlider?.value ?? 65) / 100;
  designer.setCurve(value);
  updateDesignStats();
};
const onSegmentModeChange = (): void => {
  designer.setSegmentMode(segmentMode?.value === "line" ? "line" : "curve");
  updateDesignStats();
};
const onClosedTrackChange = (): void => {
  designer.setClosed(!!closedTrackToggle?.checked);
  updateDesignStats();
};
const onEditorHintToggle = (): void => {
  designHint?.classList.toggle("visible", !!editorHintToggle?.checked && mode === "design");
};
const onClearTrack = (): void => {
  designer.clear();
  updateDesignStats();
};
const onStartTrack = (): void => {
  if (mode === "design" && designer.hasUsableStroke()) enterDriveModeFromDesigner();
};
curveSlider?.addEventListener("input", onCurveInput);
segmentMode?.addEventListener("change", onSegmentModeChange);
closedTrackToggle?.addEventListener("change", onClosedTrackChange);
editorHintToggle?.addEventListener("change", onEditorHintToggle);
clearTrackBtn?.addEventListener("click", onClearTrack);
startTrackBtn?.addEventListener("click", onStartTrack);

const onGlobalKeyDown = (e: KeyboardEvent): void => {
  if (e.code === "Enter") {
    if (mode === "design" && designer.hasUsableStroke()) enterDriveModeFromDesigner();
  } else if (e.code === "KeyT") {
    if (mode === "drive") showMenu();
  } else if (e.code === "Escape") {
    if (mode === "design") showMenu();
  }
};
window.addEventListener("keydown", onGlobalKeyDown);

const onResize = (): void => ctx.engine.resize();
window.addEventListener("resize", onResize);

const onFirstPointerDown = (): void => engineAudio.start();
window.addEventListener("pointerdown", onFirstPointerDown, { once: true });

// Initial state: menu.
showMenu();

// ── render loop ───────────────────────────────────────────────────────────

const tmpQ = new Quaternion();
let last = performance.now();
let frameCounter = 0;

ctx.engine.runRenderLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  input.update(dt);
  frameCounter += 1;

  if (mode === "drive" && vehicle && (track || endless)) {
    if (input.consumeReset()) {
      const sp = track ? track.spawn : endless!.spawn;
      vehicle.reset(sp.position, sp.yaw);
    }
    vehicle.update(dt, input.state);
    phys.step(dt);
    vehicle.syncRender();

    const r = vehicle.body.rotation();
    tmpQ.set(r.x, r.y, r.z, r.w);
    followCam.update(dt, vehicle.root.position, tmpQ);

    const pos = vehicle.body.translation();
    const siny = 2 * (r.w * r.y + r.x * r.z);
    const cosy = 1 - 2 * (r.y * r.y + r.x * r.x);
    const yaw = Math.atan2(siny, cosy);
    minimap.draw(pos.x, pos.z, yaw, vehicle.speedKmh() / 3.6, dt);
    raceTimer?.update({ x: pos.x, z: pos.z, yaw }, dt);
    tireEffects.update({ x: pos.x, z: pos.z }, yaw, vehicle.tireSlip, vehicle.speedKmh() / 3.6, dt);

    engineAudio.update(input.state.throttle, vehicle.speedKmh() / 3.6, dt);
    tireScreech.update(vehicle.tireSlip, vehicle.speedKmh() / 3.6);

    // Keep the ground tile centred under the car so the world feels infinite.
    ground.follow({ x: pos.x, z: pos.z });

    if (frameCounter % 15 === 0) {
      vegetation?.updateLOD({ x: pos.x, z: pos.z });
      terrainFeatures?.updateLOD({ x: pos.x, z: pos.z });
    }

    // Endless mode: stream more chunks ahead, recycle behind.
    if (endless) {
      endless.update({ x: pos.x, z: pos.z });
      if (frameCounter % 30 === 0) minimap.setCenterline(endless.centerline);
      if (endlessProps) {
        if (frameCounter % 15 === 0) endlessProps.setCenterline(endless.centerline);
        endlessProps.update({ x: pos.x, z: pos.z });
      }
    }
  } else {
    input.consumeReset();
    if (mode === "design" && frameCounter % 10 === 0) updateDesignStats();
  }

  ctx.scene.render();

  if (hud) {
    if (mode === "menu") {
      hud.textContent = "";
    } else if (mode === "design") {
      hud.textContent =
        `TRACK EDITOR\n` +
        `Click empty ground     add key point\n` +
        `Drag point             adjust point\n` +
        `Mouse wheel            zoom\n` +
        `Enter / Start          drive\n` +
        `Esc                    back to menu`;
    } else if (vehicle) {
      const speed = vehicle.speedKmh().toFixed(0).padStart(3, " ");
      const mobileHud = isTouchDevice
        ? `Tilt       steer\nPedals     gas / brake\n`
        : `WASD / Arrows  drive\n`;
      const race = raceTimer?.snapshot();
      const raceHud = race?.enabled
        ? `LAP ${race.lap}  CP ${race.checkpoint}/${race.checkpointCount}\nTIME ${formatLap(race.currentLapMs)}\nBEST ${formatLap(race.bestLapMs)}\n`
        : "";
      hud.textContent =
        `SPEED ${speed} km/h\n` +
        raceHud +
        mobileHud +
        `Space          handbrake\n` +
        `R              reset to start\n` +
        `T              back to menu`;
    }
  }
});

void Vector3;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.removeEventListener("keydown", onGlobalKeyDown);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("pointerdown", onFirstPointerDown);
    btnMenu?.removeEventListener("click", onMobileMenuClick);
    motionGateBtn?.removeEventListener("click", onMotionGateClick);
    curveSlider?.removeEventListener("input", onCurveInput);
    segmentMode?.removeEventListener("change", onSegmentModeChange);
    closedTrackToggle?.removeEventListener("change", onClosedTrackChange);
    editorHintToggle?.removeEventListener("change", onEditorHintToggle);
    clearTrackBtn?.removeEventListener("click", onClearTrack);
    startTrackBtn?.removeEventListener("click", onStartTrack);
    for (const p of carPreviews) p.dispose();
    carPreviews = [];
    input.dispose();
    designer.dispose();
    minimap.dispose();
    engineAudio.dispose();
    tireScreech.dispose();
    tireEffects.dispose();
    if (raceTimer) raceTimer.dispose();
    if (vehicle) vehicle.dispose();
    if (track) track.dispose();
    if (endless) endless.dispose();
    if (vegetation) vegetation.dispose();
    if (terrainFeatures) terrainFeatures.dispose();
    if (endlessProps) endlessProps.dispose();
    ground.dispose();
    ctx.engine.stopRenderLoop();
    ctx.scene.dispose();
    ctx.engine.dispose();
    phys.dispose();
  });
}
