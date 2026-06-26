import {
  MeshBuilder,
  Mesh,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
  Color3,
} from "@babylonjs/core";
import type { Materials } from "../render/scene";

/**
 * All tunable parameters that distinguish one car from another. The vehicle
 * physics module is generic over this spec — adding a new car means filling
 * in numbers + a visual-builder callback, no engine code changes.
 */
export interface CarSpec {
  id: string;
  label: string;
  description: string;

  // ── geometry ──
  /** Half-extents of the physics collider (cuboid). */
  chassisHalf: { x: number; y: number; z: number };
  /** Half-height of the visual body (decoupled from collider for ground clearance). */
  bodyVisHalfY: number;
  /** Mass in kg. */
  mass: number;
  /** Wheel radii. */
  wheelRadiusFront: number;
  wheelRadiusRear: number;
  /** Where the suspension attachment sits on each wheel relative to body center. */
  wheelLocalPos: {
    frontX: number;     // ± offset
    rearX: number;
    frontZ: number;     // ± offset (front +Z, rear -Z)
    rearZ: number;
    y: number;          // attachment height above body center
  };

  // ── suspension ──
  suspensionRest: number;
  suspensionTravel: number;
  suspensionStiffness: number;
  suspensionDamping: number;

  // ── powertrain & controls ──
  maxSteer: number;        // radians
  engineForce: number;     // N peak axle force
  brakeForce: number;
  handbrakeForce: number;
  rollingResistance: number;

  // ── tires ──
  tireLatStiffness: number;
  tireLatMaxMuFront: number;
  tireLatMaxMuRear: number;
  tireLongMaxMuRear: number;
  handbrakeRearGrip: number;       // 0–1 multiplier on rear lateral grip
  powerOverRearScale: number;

  // ── body damping (rapier rigid body) ──
  linearDamping: number;
  angularDamping: number;

  // ── visual ──
  /** Colors used by buildVisual. */
  bodyColor: Color3;
  /** Build the cosmetic mesh hierarchy and parent everything to `root`. */
  buildVisual(root: TransformNode, scene: Scene, materials: Materials, spec: CarSpec): void;
}

// ── shared helper ─────────────────────────────────────────────────────────

function makeMat(name: string, scene: Scene, color: Color3): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = color;
  m.specularColor.set(0, 0, 0);
  m.emissiveColor = color.scale(0.25);
  return m;
}

// ── Porsche 911 GT3 RS (992) ──────────────────────────────────────────────

function buildPorsche911Visual(
  root: TransformNode,
  scene: Scene,
  materials: Materials,
  spec: CarSpec,
): void {
  const half = spec.chassisHalf;
  const visY = spec.bodyVisHalfY;

  const bodyMat = makeMat("p911.body.mat", scene, spec.bodyColor);
  // Carbon-fibre weave look for the aero parts — near-black with a hint of
  // grey so they read separately from the painted body.
  const carbonMat = makeMat("p911.carbon.mat", scene, new Color3(0.08, 0.09, 0.10));

  // ── main body (lower, wider stance than a base 911) ──
  const bodyMesh = MeshBuilder.CreateBox(
    "p911.body",
    { width: half.x * 2, height: visY * 1.4, depth: half.z * 2 },
    scene,
  );
  bodyMesh.parent = root;
  bodyMesh.material = bodyMat;

  // ── wide rear fenders (GT3 RS is 1900 mm wide) ──
  for (const sx of [-1, 1]) {
    const fender = MeshBuilder.CreateBox(
      "p911.fender",
      { width: 0.16, height: visY * 1.0, depth: half.z * 0.95 },
      scene,
    );
    fender.position.set(sx * (half.x - 0.04), visY * 0.05, -half.z * 0.25);
    fender.parent = root;
    fender.material = bodyMat;
  }

  // ── greenhouse / fastback cabin (set toward rear, RS has roll cage hints) ──
  const cabin = MeshBuilder.CreateBox(
    "p911.cabin",
    { width: half.x * 1.55, height: 0.50, depth: half.z * 0.60 },
    scene,
  );
  cabin.position.set(0, visY * 0.75 + 0.25, -0.35);
  cabin.parent = root;
  const glassMat = materials.carDark.clone("p911.glass");
  glassMat.emissiveColor.set(0.05, 0.06, 0.08);
  cabin.material = glassMat;

  // ── front splitter (huge on the RS) ──
  const splitter = MeshBuilder.CreateBox(
    "p911.splitter",
    { width: half.x * 2.05, height: 0.05, depth: 0.30 },
    scene,
  );
  splitter.position.set(0, -visY * 0.72, half.z - 0.02);
  splitter.parent = root;
  splitter.material = carbonMat;

  // ── front lip / dive planes ──
  const lip = MeshBuilder.CreateBox(
    "p911.lip",
    { width: half.x * 1.75, height: 0.07, depth: 0.20 },
    scene,
  );
  lip.position.set(0, -visY * 0.5, half.z - 0.12);
  lip.parent = root;
  lip.material = carbonMat;
  // Canards at each side of the bumper.
  for (const sx of [-1, 1]) {
    const canard = MeshBuilder.CreateBox(
      "p911.canard",
      { width: 0.30, height: 0.03, depth: 0.18 },
      scene,
    );
    canard.position.set(sx * (half.x - 0.08), -visY * 0.30, half.z - 0.05);
    canard.rotation.z = sx * 0.12;
    canard.parent = root;
    canard.material = carbonMat;
  }

  // ── NACA hood ducts (two black slits on the front hood) ──
  for (const sx of [-1, 1]) {
    const naca = MeshBuilder.CreateBox(
      "p911.naca",
      { width: 0.16, height: 0.04, depth: 0.55 },
      scene,
    );
    naca.position.set(sx * 0.30, visY * 0.72, half.z - 0.7);
    naca.parent = root;
    naca.material = carbonMat;
  }

  // ── side intake fins (engine cooling, RS hallmark) ──
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const fin = MeshBuilder.CreateBox(
        "p911.sideFin",
        { width: 0.04, height: 0.18, depth: 0.32 },
        scene,
      );
      fin.position.set(sx * (half.x - 0.02), visY * 0.30, -half.z * 0.4 - i * 0.14);
      fin.parent = root;
      fin.material = carbonMat;
    }
  }

  // ── rear deck lid louvres ──
  for (let i = 0; i < 4; i++) {
    const slat = MeshBuilder.CreateBox(
      "p911.slat",
      { width: half.x * 1.35, height: 0.03, depth: 0.05 },
      scene,
    );
    slat.position.set(0, visY * 0.78, -half.z + 0.5 + i * 0.18);
    slat.parent = root;
    slat.material = carbonMat;
  }

  // ── SWAN-NECK rear wing (the GT3 RS signature) ──
  // Wing is mounted *from the top* via two slender uprights that curve over
  // and attach to the upper surface of the airfoil. Boxes can't curve, so
  // we fake it with a vertical pylon + a forward-leaning strut.
  const wingY = visY * 1.0 + 0.78;
  const wingZ = -half.z + 0.05;
  const airfoil = MeshBuilder.CreateBox(
    "p911.wing.airfoil",
    { width: half.x * 1.95, height: 0.06, depth: 0.46 },
    scene,
  );
  airfoil.position.set(0, wingY, wingZ);
  airfoil.parent = root;
  airfoil.material = carbonMat;

  // End plates — large vertical fins at each tip.
  for (const sx of [-1, 1]) {
    const plate = MeshBuilder.CreateBox(
      "p911.wing.endplate",
      { width: 0.04, height: 0.30, depth: 0.50 },
      scene,
    );
    plate.position.set(sx * (half.x * 0.98), wingY + 0.06, wingZ);
    plate.parent = root;
    plate.material = carbonMat;
  }

  // Vertical pylons rising from the deck to attach ABOVE the airfoil.
  const pylonTop = wingY + 0.14;
  const pylonBot = visY * 0.85;
  const pylonMid = (pylonTop + pylonBot) / 2;
  const pylonH = pylonTop - pylonBot;
  for (const sx of [-1, 1]) {
    const pylon = MeshBuilder.CreateBox(
      "p911.wing.pylon",
      { width: 0.05, height: pylonH, depth: 0.08 },
      scene,
    );
    pylon.position.set(sx * 0.42, pylonMid, wingZ - 0.04);
    pylon.parent = root;
    pylon.material = carbonMat;

    // Short forward-leaning strut that simulates the swan-neck curve over
    // the top of the airfoil.
    const strut = MeshBuilder.CreateBox(
      "p911.wing.strut",
      { width: 0.05, height: 0.06, depth: 0.16 },
      scene,
    );
    strut.position.set(sx * 0.42, pylonTop - 0.04, wingZ + 0.04);
    strut.parent = root;
    strut.material = carbonMat;
  }

  // ── rear diffuser ──
  const diffuser = MeshBuilder.CreateBox(
    "p911.diffuser",
    { width: half.x * 1.85, height: 0.06, depth: 0.35 },
    scene,
  );
  diffuser.position.set(0, -visY * 0.70, -half.z + 0.10);
  diffuser.parent = root;
  diffuser.material = carbonMat;

  // ── headlights (round, sunk into the front fenders) ──
  const hlMat = new StandardMaterial("p911.headlight", scene);
  hlMat.diffuseColor.set(0.92, 0.9, 0.78);
  hlMat.emissiveColor.set(0.18, 0.16, 0.12);
  hlMat.specularColor.set(0, 0, 0);
  for (const sx of [-1, 1]) {
    const hl = MeshBuilder.CreateDisc(
      "p911.hl",
      { radius: 0.14, tessellation: 12 },
      scene,
    );
    hl.position.set(sx * 0.58, visY * 0.20, half.z - 0.02);
    hl.parent = root;
    hl.material = hlMat;
  }

  // ── center-lock magnesium wheels accent (a low ring around each wheel hub
  //    is drawn by the vehicle module; here we add nothing extra). ──
}

export const PORSCHE_911_GT3_RS: CarSpec = {
  id: "porsche-911-gt3-rs",
  label: "Porsche 911 GT3 RS (992)",
  description:
    "1450 kg • 525 PS NA flat-six RWD • swan-neck wing, huge aero, razor-sharp turn-in.",
  chassisHalf: { x: 0.95, y: 0.16, z: 2.21 },
  bodyVisHalfY: 0.50,
  mass: 1450,
  wheelRadiusFront: 0.34,
  wheelRadiusRear: 0.36,
  wheelLocalPos: { frontX: 0.82, rearX: 0.84, frontZ: 1.24, rearZ: 1.24, y: 0.12 },

  // Stiffer than a base 911 — track-focused damper rates.
  suspensionRest: 0.30,
  suspensionTravel: 0.14,
  suspensionStiffness: 46000,
  suspensionDamping: 8800,

  // 525 PS, 470 Nm. Strong brakes (PCCB ceramic).
  maxSteer: 0.58,
  engineForce: 28000,
  brakeForce: 36000,
  handbrakeForce: 18000,
  rollingResistance: 0.011,

  // Massive downforce → high lateral grip everywhere; nose is the sharper
  // end thanks to DRS-tuned splitter + canards.
  tireLatStiffness: 62,
  tireLatMaxMuFront: 1.72,
  tireLatMaxMuRear: 1.62,
  tireLongMaxMuRear: 1.70,
  handbrakeRearGrip: 0.20,
  powerOverRearScale: 0.92,

  linearDamping: 0.09,
  angularDamping: 0.78,        // less yaw damping than base 911 → more agile

  // Iconic Python Green PTS color associated with the GT3 RS.
  bodyColor: new Color3(0.51, 0.74, 0.20),
  buildVisual: buildPorsche911Visual,
};

// ── Ferrari F40 ───────────────────────────────────────────────────────────

function buildFerrariF40Visual(
  root: TransformNode,
  scene: Scene,
  materials: Materials,
  spec: CarSpec,
): void {
  const half = spec.chassisHalf;
  const visY = spec.bodyVisHalfY;

  const bodyMat = makeMat("f40.body.mat", scene, spec.bodyColor);

  // Main wedge body.
  const bodyMesh = MeshBuilder.CreateBox(
    "f40.body",
    { width: half.x * 2, height: visY * 1.4, depth: half.z * 2 },
    scene,
  );
  bodyMesh.parent = root;
  bodyMesh.material = bodyMat;

  // Pop-up headlight area is flat — F40 has a very low, blunt nose.
  // Lower nose section: a thin slab at the front, lower than main body.
  const nose = MeshBuilder.CreateBox(
    "f40.nose",
    { width: half.x * 1.85, height: visY * 0.85, depth: 0.6 },
    scene,
  );
  nose.position.set(0, -visY * 0.30, half.z - 0.30);
  nose.parent = root;
  nose.material = bodyMat;

  // Cockpit greenhouse — positioned in the middle, very small.
  const cabin = MeshBuilder.CreateBox(
    "f40.cabin",
    { width: half.x * 1.4, height: 0.40, depth: half.z * 0.55 },
    scene,
  );
  cabin.position.set(0, visY * 0.7 + 0.20, 0.05);
  cabin.parent = root;
  const glassMat = materials.carDark.clone("f40.glass");
  glassMat.emissiveColor.set(0.04, 0.05, 0.07);
  cabin.material = glassMat;

  // NACA-duct shoulders along the side — two narrow strakes.
  for (const sx of [-1, 1]) {
    const strake = MeshBuilder.CreateBox(
      "f40.strake",
      { width: 0.05, height: 0.06, depth: half.z * 1.2 },
      scene,
    );
    strake.position.set(sx * (half.x - 0.02), visY * 0.45, -0.1);
    strake.parent = root;
    strake.material = materials.carDark;
  }

  // Engine cover slats at the rear (the F40's signature louvered deck).
  for (let i = 0; i < 5; i++) {
    const slat = MeshBuilder.CreateBox(
      "f40.slat",
      { width: half.x * 1.4, height: 0.04, depth: 0.05 },
      scene,
    );
    slat.position.set(0, visY * 0.78, -half.z + 0.45 + i * 0.18);
    slat.parent = root;
    slat.material = materials.carDark;
  }

  // The iconic huge rear wing — wider, taller pylon-mounted than the 911.
  const wingY = visY * 0.95 + 0.45;
  const wingZ = -half.z + 0.05;
  const airfoil = MeshBuilder.CreateBox(
    "f40.wing.airfoil",
    { width: half.x * 1.95, height: 0.06, depth: 0.42 },
    scene,
  );
  airfoil.position.set(0, wingY, wingZ);
  airfoil.parent = root;
  airfoil.material = bodyMat;

  // End plates on the wing — vertical fins at each tip.
  for (const sx of [-1, 1]) {
    const plate = MeshBuilder.CreateBox(
      "f40.wing.endplate",
      { width: 0.04, height: 0.18, depth: 0.42 },
      scene,
    );
    plate.position.set(sx * (half.x * 0.97), wingY + 0.06, wingZ);
    plate.parent = root;
    plate.material = bodyMat;
  }

  // Wing pylons / uprights.
  const upTop = wingY - 0.04;
  const upBot = visY * 0.70;
  const upMid = (upTop + upBot) / 2;
  const upH = upTop - upBot;
  for (const sx of [-1, 1]) {
    const upright = MeshBuilder.CreateBox(
      "f40.wing.upright",
      { width: 0.06, height: upH, depth: 0.10 },
      scene,
    );
    upright.position.set(sx * 0.55, upMid, wingZ);
    upright.parent = root;
    upright.material = bodyMat;
  }

  // Headlights — small rectangles set into the wedge nose.
  const hlMat = new StandardMaterial("f40.headlight", scene);
  hlMat.diffuseColor.set(0.92, 0.9, 0.78);
  hlMat.emissiveColor.set(0.15, 0.14, 0.10);
  hlMat.specularColor.set(0, 0, 0);
  for (const sx of [-1, 1]) {
    const hl = MeshBuilder.CreateBox(
      "f40.hl",
      { width: 0.32, height: 0.06, depth: 0.04 },
      scene,
    );
    hl.position.set(sx * 0.42, visY * 0.05, half.z - 0.01);
    hl.parent = root;
    hl.material = hlMat;
  }
}

export const FERRARI_F40: CarSpec = {
  id: "ferrari-f40",
  label: "Ferrari F40",
  description: "1100 kg • 478 PS twin-turbo V8 • raw, light, snappy.",
  chassisHalf: { x: 0.97, y: 0.15, z: 2.15 },
  bodyVisHalfY: 0.45,
  mass: 1100,
  wheelRadiusFront: 0.33,
  wheelRadiusRear: 0.36,
  wheelLocalPos: { frontX: 0.84, rearX: 0.86, frontZ: 1.22, rearZ: 1.18, y: 0.10 },

  suspensionRest: 0.32,
  suspensionTravel: 0.16,
  suspensionStiffness: 32000,
  suspensionDamping: 6500,

  // 478 PS in 1100 kg → much better p/w than the 911. Raw and quick.
  maxSteer: 0.52,
  engineForce: 26000,
  brakeForce: 24000,
  handbrakeForce: 14000,
  rollingResistance: 0.008,

  // F40 is famously twitchy — sharper turn-in (front grip), less rear grip.
  tireLatStiffness: 44,
  tireLatMaxMuFront: 1.20,    // more nose bite
  tireLatMaxMuRear: 0.98,     // tail lets go earlier
  tireLongMaxMuRear: 1.42,
  handbrakeRearGrip: 0.16,
  powerOverRearScale: 0.78,    // dramatic but not instant

  linearDamping: 0.07,
  angularDamping: 0.40,        // less yaw damping → snappier

  bodyColor: new Color3(0.92, 0.13, 0.07), // Rosso Corsa
  buildVisual: buildFerrariF40Visual,
};

// ── Lamborghini Huracán STO ───────────────────────────────────────────────

function buildLamborghiniHuracanVisual(
  root: TransformNode,
  scene: Scene,
  materials: Materials,
  spec: CarSpec,
): void {
  const half = spec.chassisHalf;
  const visY = spec.bodyVisHalfY;

  const bodyMat = makeMat("huracan.body.mat", scene, spec.bodyColor);
  const carbonMat = makeMat("huracan.carbon.mat", scene, new Color3(0.08, 0.09, 0.10));
  const stripeMat = makeMat("huracan.stripe.mat", scene, new Color3(0.05, 0.05, 0.06));

  // Hexagonal wedge body — Lambo lines are all sharp creases.
  const bodyMesh = MeshBuilder.CreateBox(
    "huracan.body",
    { width: half.x * 2, height: visY * 1.3, depth: half.z * 2 },
    scene,
  );
  bodyMesh.parent = root;
  bodyMesh.material = bodyMat;

  // Aggressively tapered nose — a thinner slab in front of the main body.
  const nose = MeshBuilder.CreateBox(
    "huracan.nose",
    { width: half.x * 1.8, height: visY * 0.65, depth: 0.7 },
    scene,
  );
  nose.position.set(0, -visY * 0.30, half.z - 0.35);
  nose.parent = root;
  nose.material = bodyMat;

  // Centered black racing stripe on the hood / roof — STO signature.
  const stripe = MeshBuilder.CreateBox(
    "huracan.stripe",
    { width: 0.55, height: 0.015, depth: half.z * 1.8 },
    scene,
  );
  stripe.position.set(0, visY * 0.73, 0);
  stripe.parent = root;
  stripe.material = stripeMat;

  // Wedge-shaped low cockpit pushed forward — mid-engine layout.
  const cabin = MeshBuilder.CreateBox(
    "huracan.cabin",
    { width: half.x * 1.45, height: 0.45, depth: half.z * 0.65 },
    scene,
  );
  cabin.position.set(0, visY * 0.75 + 0.22, 0.10);
  cabin.parent = root;
  const glassMat = materials.carDark.clone("huracan.glass");
  glassMat.emissiveColor.set(0.04, 0.05, 0.07);
  cabin.material = glassMat;

  // ── front splitter + canards ──
  const splitter = MeshBuilder.CreateBox(
    "huracan.splitter",
    { width: half.x * 2.05, height: 0.05, depth: 0.32 },
    scene,
  );
  splitter.position.set(0, -visY * 0.75, half.z - 0.02);
  splitter.parent = root;
  splitter.material = carbonMat;

  for (const sx of [-1, 1]) {
    const canard = MeshBuilder.CreateBox(
      "huracan.canard",
      { width: 0.34, height: 0.035, depth: 0.20 },
      scene,
    );
    canard.position.set(sx * (half.x - 0.10), -visY * 0.18, half.z - 0.10);
    canard.rotation.z = sx * 0.10;
    canard.parent = root;
    canard.material = carbonMat;
  }

  // Slanted side intakes — two diagonal black slabs on each flank.
  for (const sx of [-1, 1]) {
    const intake = MeshBuilder.CreateBox(
      "huracan.sideIntake",
      { width: 0.08, height: 0.30, depth: 0.55 },
      scene,
    );
    intake.position.set(sx * (half.x - 0.02), visY * 0.18, -half.z * 0.18);
    intake.rotation.y = sx * -0.20;
    intake.parent = root;
    intake.material = carbonMat;
  }

  // Roof scoop pointing toward the rear (STO style snorkel).
  const scoop = MeshBuilder.CreateBox(
    "huracan.scoop",
    { width: 0.35, height: 0.16, depth: 0.85 },
    scene,
  );
  scoop.position.set(0, visY * 0.95 + 0.45, -0.05);
  scoop.parent = root;
  scoop.material = carbonMat;

  // Rear deck lid louvres.
  for (let i = 0; i < 5; i++) {
    const slat = MeshBuilder.CreateBox(
      "huracan.slat",
      { width: half.x * 1.5, height: 0.03, depth: 0.05 },
      scene,
    );
    slat.position.set(0, visY * 0.74, -half.z + 0.6 + i * 0.16);
    slat.parent = root;
    slat.material = carbonMat;
  }

  // Big swan-neck-ish rear wing.
  const wingY = visY * 1.0 + 0.62;
  const wingZ = -half.z + 0.10;
  const airfoil = MeshBuilder.CreateBox(
    "huracan.wing.airfoil",
    { width: half.x * 1.92, height: 0.06, depth: 0.50 },
    scene,
  );
  airfoil.position.set(0, wingY, wingZ);
  airfoil.parent = root;
  airfoil.material = carbonMat;

  for (const sx of [-1, 1]) {
    const plate = MeshBuilder.CreateBox(
      "huracan.wing.endplate",
      { width: 0.04, height: 0.26, depth: 0.55 },
      scene,
    );
    plate.position.set(sx * (half.x * 0.97), wingY + 0.05, wingZ);
    plate.parent = root;
    plate.material = carbonMat;
  }

  const pylonTop = wingY - 0.04;
  const pylonBot = visY * 0.78;
  const pylonMid = (pylonTop + pylonBot) / 2;
  const pylonH = pylonTop - pylonBot;
  for (const sx of [-1, 1]) {
    const pylon = MeshBuilder.CreateBox(
      "huracan.wing.pylon",
      { width: 0.05, height: pylonH, depth: 0.10 },
      scene,
    );
    pylon.position.set(sx * 0.45, pylonMid, wingZ);
    pylon.parent = root;
    pylon.material = carbonMat;
  }

  // Rear diffuser — wide and slanted, with two big strakes.
  const diffuser = MeshBuilder.CreateBox(
    "huracan.diffuser",
    { width: half.x * 1.85, height: 0.06, depth: 0.4 },
    scene,
  );
  diffuser.position.set(0, -visY * 0.70, -half.z + 0.05);
  diffuser.parent = root;
  diffuser.material = carbonMat;
  for (const sx of [-1, 1]) {
    const strake = MeshBuilder.CreateBox(
      "huracan.diffuserStrake",
      { width: 0.05, height: 0.10, depth: 0.4 },
      scene,
    );
    strake.position.set(sx * 0.40, -visY * 0.65, -half.z + 0.05);
    strake.parent = root;
    strake.material = carbonMat;
  }

  // Y-shaped LED headlights — two thin angled bars per side.
  const hlMat = new StandardMaterial("huracan.headlight", scene);
  hlMat.diffuseColor.set(0.92, 0.94, 0.95);
  hlMat.emissiveColor.set(0.20, 0.22, 0.26);
  hlMat.specularColor.set(0, 0, 0);
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      const hl = MeshBuilder.CreateBox(
        "huracan.hl",
        { width: 0.10, height: 0.04, depth: 0.04 },
        scene,
      );
      hl.position.set(sx * (0.42 + i * 0.10), -visY * 0.02 - i * 0.06, half.z - 0.02);
      hl.rotation.z = sx * (0.35 + i * 0.10);
      hl.parent = root;
      hl.material = hlMat;
    }
  }
}

export const LAMBORGHINI_HURACAN_STO: CarSpec = {
  id: "lamborghini-huracan-sto",
  label: "Lamborghini Huracán STO",
  description:
    "1340 kg • 640 PS NA V10 RWD • razor wedge, huge aero, hyper-quick turn-in.",
  chassisHalf: { x: 0.99, y: 0.15, z: 2.20 },
  bodyVisHalfY: 0.46,
  mass: 1340,
  wheelRadiusFront: 0.34,
  wheelRadiusRear: 0.36,
  wheelLocalPos: { frontX: 0.87, rearX: 0.89, frontZ: 1.26, rearZ: 1.22, y: 0.10 },

  suspensionRest: 0.30,
  suspensionTravel: 0.14,
  suspensionStiffness: 48000,
  suspensionDamping: 9200,

  // 640 PS / 1340 kg — between the RS and F40 on power-to-weight.
  // Steering even sharper than the GT3 RS, brakes the strongest of the
  // three thanks to ceramic discs and downforce.
  maxSteer: 0.60,
  engineForce: 30000,
  brakeForce: 38000,
  handbrakeForce: 18000,
  rollingResistance: 0.011,

  // Front-biased aero: nose really bites, tail is willing to step out under
  // throttle. Front mu higher than the GT3 RS; rear similar.
  tireLatStiffness: 64,
  tireLatMaxMuFront: 1.78,
  tireLatMaxMuRear: 1.58,
  tireLongMaxMuRear: 1.65,
  handbrakeRearGrip: 0.18,
  powerOverRearScale: 0.88,

  linearDamping: 0.09,
  angularDamping: 0.72,        // even less yaw damping → very agile

  bodyColor: new Color3(0.96, 0.43, 0.07), // Arancio Borealis
  buildVisual: buildLamborghiniHuracanVisual,
};

// ── registry ──────────────────────────────────────────────────────────────

export const CARS: ReadonlyArray<CarSpec> = [
  PORSCHE_911_GT3_RS,
  FERRARI_F40,
  LAMBORGHINI_HURACAN_STO,
];

export function findCar(id: string): CarSpec | undefined {
  return CARS.find((c) => c.id === id);
}

void Mesh; void Vector3;
