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
 * Scatter low-poly trees, grass tufts, flowers, rocks, barrels, signs and a
 * distant mountain ring around the ground, staying clear of the drawn track.
 * Everything uses instanced meshes so the 1500+ props cost only a few dozen
 * draw calls total.
 *
 * Layout is deterministic (seeded PRNG) so the same track always shows the
 * same world.
 */

const SCATTER_RADIUS = 700;
const TRACK_CLEARANCE = 6.5;
const SPAWN_CLEARANCE = 12;

const COUNTS = {
  pineTrees: 140,
  roundTrees: 140,
  bushes: 240,
  grass: 900,
  flowers: 380,
  rocks: 220,
  boulders: 40,
  barrels: 30,
  signs: 18,
  billboards: 6,
  haybales: 24,
  houses: 18,
  warehouses: 7,
  towers: 5,
  mountains: 18,
};

export interface Vegetation {
  root: TransformNode;
  updateLOD(carPos: { x: number; z: number }): void;
  dispose(): void;
}

export function buildVegetation(
  scene: Scene,
  centerline: ReadonlyArray<Vec2>,
  spawn: { x: number; z: number },
): Vegetation {
  const root = new TransformNode("veg.root", scene);
  const rng = mulberry32(0x6a09e667);

  const proto = buildPrototypes(scene);
  for (const m of Object.values(proto)) {
    if (m instanceof Mesh) m.parent = root;
  }

  const instances: InstancedMesh[] = [];
  const lodItems: Array<{ mesh: InstancedMesh; maxD2: number }> = [];
  const density = isLowPowerDevice() ? 0.45 : 1;
  const count = (v: number): number => Math.max(1, Math.round(v * density));
  const track = (m: InstancedMesh, maxDistance: number = 520) => {
    instances.push(m);
    m.parent = root;
    m.freezeWorldMatrix();
    lodItems.push({ mesh: m, maxD2: maxDistance * maxDistance });
  };

  // ── Pine trees (cone + trunk) ─────────────────────────────────────────
  scatter(count(COUNTS.pineTrees), rng, centerline, spawn, (x, z) => {
    const s = 0.9 + rng() * 0.9;
    const yaw = rng() * Math.PI * 2;
    const trunk = proto.pineTrunk.createInstance(`veg.ptrunk.${instances.length}`);
    trunk.position.set(x, 0.7 * s, z);
    trunk.scaling.set(s, s, s);
    trunk.rotation.y = yaw;
    track(trunk);
    // Stacked cones for the layered pine look.
    for (let i = 0; i < 3; i++) {
      const layer = proto.pineLayer.createInstance(`veg.player.${instances.length}`);
      const ly = 1.3 * s + i * 0.85 * s;
      const lscale = s * (1.0 - i * 0.2);
      layer.position.set(x, ly, z);
      layer.scaling.set(lscale, lscale, lscale);
      layer.rotation.y = yaw + i * 0.4;
      track(layer);
    }
  });

  // ── Round/deciduous trees (trunk + foliage sphere) ────────────────────
  scatter(count(COUNTS.roundTrees), rng, centerline, spawn, (x, z) => {
    const s = 1.0 + rng() * 0.7;
    const yaw = rng() * Math.PI * 2;
    const trunk = proto.trunk.createInstance(`veg.trunk.${instances.length}`);
    trunk.position.set(x, 0.8 * s, z);
    trunk.scaling.set(s, s, s);
    trunk.rotation.y = yaw;
    track(trunk);

    // Pick one of three foliage shades for variety.
    const choice = Math.floor(rng() * 3);
    const fol = (
      choice === 0 ? proto.foliageA :
      choice === 1 ? proto.foliageB :
      proto.foliageC
    ).createInstance(`veg.foliage.${instances.length}`);
    fol.position.set(x, 1.7 * s + 0.4, z);
    fol.scaling.set(s, s * (0.9 + rng() * 0.3), s);
    fol.rotation.y = yaw;
    track(fol);
  });

  // ── Bushes ────────────────────────────────────────────────────────────
  scatter(count(COUNTS.bushes), rng, centerline, spawn, (x, z) => {
    const s = 0.6 + rng() * 0.7;
    const inst = proto.bush.createInstance(`veg.bush.${instances.length}`);
    inst.position.set(x, 0.25 * s, z);
    inst.scaling.set(s, s * 0.65, s);
    inst.rotation.y = rng() * Math.PI * 2;
    track(inst);
  });

  // ── Grass tufts ───────────────────────────────────────────────────────
  scatter(count(COUNTS.grass), rng, centerline, spawn, (x, z) => {
    const s = 0.5 + rng() * 0.6;
    const inst = proto.grass.createInstance(`veg.grass.${instances.length}`);
    inst.position.set(x, 0.18 * s, z);
    inst.scaling.set(s, s, s);
    inst.rotation.y = rng() * Math.PI * 2;
    track(inst, 160);
  });

  // ── Flowers (3 colors) ────────────────────────────────────────────────
  scatter(count(COUNTS.flowers), rng, centerline, spawn, (x, z) => {
    const s = 0.6 + rng() * 0.4;
    const stem = proto.flowerStem.createInstance(`veg.fstem.${instances.length}`);
    stem.position.set(x, 0.18 * s, z);
    stem.scaling.set(s, s, s);
    track(stem, 180);

    const choice = Math.floor(rng() * 3);
    const head = (
      choice === 0 ? proto.flowerHeadYellow :
      choice === 1 ? proto.flowerHeadPink :
      proto.flowerHeadWhite
    ).createInstance(`veg.fhead.${instances.length}`);
    head.position.set(x, 0.36 * s, z);
    head.scaling.set(s, s, s);
    track(head, 180);
  });

  // ── Small rocks ──────────────────────────────────────────────────────
  scatter(count(COUNTS.rocks), rng, centerline, spawn, (x, z) => {
    const s = 0.3 + rng() * 0.5;
    const inst = proto.rock.createInstance(`veg.rock.${instances.length}`);
    inst.position.set(x, 0.18 * s, z);
    inst.scaling.set(s, s * (0.6 + rng() * 0.4), s);
    inst.rotation.y = rng() * Math.PI * 2;
    track(inst);
  });

  // ── Boulders (larger, more clearance) ────────────────────────────────
  scatter(count(COUNTS.boulders), rng, centerline, spawn, (x, z) => {
    const s = 1.2 + rng() * 1.4;
    const inst = proto.boulder.createInstance(`veg.boulder.${instances.length}`);
    inst.position.set(x, 0.5 * s, z);
    inst.scaling.set(s, s * (0.7 + rng() * 0.3), s);
    inst.rotation.y = rng() * Math.PI * 2;
    track(inst);
  }, /*clearance*/ 14);

  // ── Oil barrels (clusters of 1–3 near the track) ─────────────────────
  scatter(count(COUNTS.barrels), rng, centerline, spawn, (x, z) => {
    const groupSize = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < groupSize; i++) {
      const inst = proto.barrel.createInstance(`veg.barrel.${instances.length}`);
      const ox = (rng() - 0.5) * 1.4;
      const oz = (rng() - 0.5) * 1.4;
      inst.position.set(x + ox, 0.45, z + oz);
      inst.rotation.y = rng() * Math.PI * 2;
      track(inst);
    }
  }, /*clearance*/ 10);

  // ── Roadside signs (chevron arrows pointing along the road) ──────────
  scatter(count(COUNTS.signs), rng, centerline, spawn, (x, z) => {
    // Aim the sign roughly tangent to the nearest segment.
    const { tx, tz } = nearestTangent(x, z, centerline);
    const post = proto.signPost.createInstance(`veg.signpost.${instances.length}`);
    post.position.set(x, 0.55, z);
    track(post);
    const face = proto.signFace.createInstance(`veg.signface.${instances.length}`);
    face.position.set(x, 1.05, z);
    face.rotation.y = Math.atan2(tx, tz);
    track(face);
  }, /*clearance*/ 9);

  // ── Big billboards (rare) ────────────────────────────────────────────
  scatter(count(COUNTS.billboards), rng, centerline, spawn, (x, z) => {
    const { tx, tz } = nearestTangent(x, z, centerline);
    for (const sx of [-1, 1]) {
      const leg = proto.bbLeg.createInstance(`veg.bbleg.${instances.length}`);
      leg.position.set(x + sx * 1.4, 1.7, z);
      track(leg);
    }
    const board = proto.bbBoard.createInstance(`veg.bbboard.${instances.length}`);
    board.position.set(x, 3.6, z);
    board.rotation.y = Math.atan2(tx, tz);
    track(board);
  }, /*clearance*/ 18);

  // ── Hay bales (cylinders on their side) ──────────────────────────────
  scatter(count(COUNTS.haybales), rng, centerline, spawn, (x, z) => {
    const inst = proto.hayBale.createInstance(`veg.hay.${instances.length}`);
    inst.position.set(x, 0.45, z);
    inst.rotation.y = rng() * Math.PI * 2;
    track(inst);
  }, /*clearance*/ 9);

  scatter(count(COUNTS.houses), rng, centerline, spawn, (x, z) => {
    const yaw = rng() * Math.PI * 2;
    const sx = 1.0 + rng() * 0.6;
    const sz = 0.9 + rng() * 0.5;
    const body = proto.houseBody.createInstance(`veg.house.${instances.length}`);
    body.position.set(x, 1.1, z);
    body.scaling.set(sx, 1.0 + rng() * 0.4, sz);
    body.rotation.y = yaw;
    track(body);
    const roof = proto.houseRoof.createInstance(`veg.houseRoof.${instances.length}`);
    roof.position.set(x, 2.25 + body.scaling.y * 0.3, z);
    roof.scaling.set(sx * 1.1, 0.7, sz * 1.1);
    roof.rotation.y = yaw;
    track(roof);
  }, 26);

  scatter(count(COUNTS.warehouses), rng, centerline, spawn, (x, z) => {
    const yaw = rng() * Math.PI * 2;
    const inst = proto.warehouse.createInstance(`veg.warehouse.${instances.length}`);
    inst.position.set(x, 1.6, z);
    inst.scaling.set(1.4 + rng() * 1.0, 1.0 + rng() * 0.5, 1.0 + rng() * 0.8);
    inst.rotation.y = yaw;
    track(inst);
  }, 36);

  scatter(count(COUNTS.towers), rng, centerline, spawn, (x, z) => {
    const yaw = rng() * Math.PI * 2;
    const base = proto.towerBase.createInstance(`veg.tower.${instances.length}`);
    base.position.set(x, 2.2, z);
    base.scaling.set(0.8 + rng() * 0.4, 1.0 + rng() * 0.6, 0.8 + rng() * 0.4);
    base.rotation.y = yaw;
    track(base);
    const cap = proto.towerCap.createInstance(`veg.towerCap.${instances.length}`);
    cap.position.set(x, 4.65 + base.scaling.y * 0.7, z);
    cap.scaling.set(base.scaling.x * 1.2, 0.55, base.scaling.z * 1.2);
    cap.rotation.y = yaw;
    track(cap);
  }, 42);

  // ── Distant mountains ring (placed at fixed far radius for parallax) ─
  for (let i = 0; i < COUNTS.mountains; i++) {
    const a = (i / COUNTS.mountains) * Math.PI * 2 + rng() * 0.18;
    const r = 900 + rng() * 250;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const s = 40 + rng() * 50;
    const inst = proto.mountain.createInstance(`veg.mountain.${i}`);
    inst.position.set(x, s * 0.35, z);
    inst.scaling.set(s, s * (0.6 + rng() * 0.5), s);
    inst.rotation.y = rng() * Math.PI * 2;
    track(inst);
  }

  return {
    root,
    updateLOD(carPos): void {
      for (const item of lodItems) {
        const dx = item.mesh.position.x - carPos.x;
        const dz = item.mesh.position.z - carPos.z;
        item.mesh.isVisible = dx * dx + dz * dz <= item.maxD2;
      }
    },
    dispose(): void {
      const mats = collectMaterials(Object.values(proto));
      root.dispose(false, true);
      for (const v of Object.values(proto)) {
        if (v instanceof Mesh) v.dispose();
      }
      for (const m of mats) m.dispose();
    },
  };
}

// ─── prototypes ────────────────────────────────────────────────────────────

interface Prototypes {
  // trees
  trunk: Mesh;
  foliageA: Mesh;
  foliageB: Mesh;
  foliageC: Mesh;
  pineTrunk: Mesh;
  pineLayer: Mesh;
  // ground cover
  bush: Mesh;
  grass: Mesh;
  flowerStem: Mesh;
  flowerHeadYellow: Mesh;
  flowerHeadPink: Mesh;
  flowerHeadWhite: Mesh;
  // rocks
  rock: Mesh;
  boulder: Mesh;
  // props
  barrel: Mesh;
  signPost: Mesh;
  signFace: Mesh;
  bbLeg: Mesh;
  bbBoard: Mesh;
  hayBale: Mesh;
  houseBody: Mesh;
  houseRoof: Mesh;
  warehouse: Mesh;
  towerBase: Mesh;
  towerCap: Mesh;
  mountain: Mesh;
  // mats kept on the protos via material; we don't list them separately
  // because Object.values disposal works either way.
}

function buildPrototypes(scene: Scene): Prototypes {
  const trunkMat   = flatMat("veg.trunkMat", scene, new Color3(0.36, 0.25, 0.18));
  const leafMatA   = flatMat("veg.leafA",    scene, new Color3(0.21, 0.45, 0.20));
  const leafMatB   = flatMat("veg.leafB",    scene, new Color3(0.30, 0.55, 0.22));
  const leafMatC   = flatMat("veg.leafC",    scene, new Color3(0.46, 0.50, 0.20));
  const pineMat    = flatMat("veg.pineMat",  scene, new Color3(0.14, 0.36, 0.22));
  const bushMat    = flatMat("veg.bushMat",  scene, new Color3(0.27, 0.50, 0.22));
  const grassMat   = flatMat("veg.grassMat", scene, new Color3(0.40, 0.62, 0.28));
  const flowerY    = flatMat("veg.flY",      scene, new Color3(0.95, 0.78, 0.30));
  const flowerP    = flatMat("veg.flP",      scene, new Color3(0.92, 0.50, 0.66));
  const flowerW    = flatMat("veg.flW",      scene, new Color3(0.98, 0.96, 0.92));
  const rockMat    = flatMat("veg.rockMat",  scene, new Color3(0.55, 0.55, 0.55));
  const boulderMat = flatMat("veg.boulderMat", scene, new Color3(0.42, 0.42, 0.44));
  const barrelMat  = flatMat("veg.barrelMat", scene, new Color3(0.78, 0.32, 0.20));
  const postMat    = flatMat("veg.postMat",   scene, new Color3(0.32, 0.32, 0.34));
  const signMat    = flatMat("veg.signMat",   scene, new Color3(0.92, 0.65, 0.18));
  const bbBoardMat = flatMat("veg.bbBoardMat",scene, new Color3(0.96, 0.95, 0.92));
  const hayMat     = flatMat("veg.hayMat",    scene, new Color3(0.88, 0.74, 0.38));
  const wallMatA   = flatMat("veg.wallA",     scene, new Color3(0.78, 0.72, 0.62));
  const wallMatB   = flatMat("veg.wallB",     scene, new Color3(0.62, 0.67, 0.70));
  const roofMat    = flatMat("veg.roof",      scene, new Color3(0.52, 0.20, 0.16));
  const towerMat   = flatMat("veg.towerMat",  scene, new Color3(0.58, 0.55, 0.50));
  const mountainMat = flatMat("veg.mountainMat", scene, new Color3(0.50, 0.58, 0.62));

  const trunk = cyl("veg.trunk.proto", scene, { diameterTop: 0.18, diameterBottom: 0.28, height: 1.6, tessellation: 8 }, trunkMat);

  const foliageA = sphere("veg.folA", scene, 4, 1.7, leafMatA);
  const foliageB = sphere("veg.folB", scene, 4, 1.5, leafMatB);
  const foliageC = sphere("veg.folC", scene, 4, 1.8, leafMatC);

  const pineTrunk = cyl("veg.pineTrunk", scene, { diameterTop: 0.16, diameterBottom: 0.26, height: 1.4, tessellation: 6 }, trunkMat);
  const pineLayer = cyl("veg.pineLayer", scene, { diameterTop: 0, diameterBottom: 1.6, height: 1.4, tessellation: 8 }, pineMat);

  const bush = sphere("veg.bush.proto", scene, 4, 1.0, bushMat);

  const grass = cyl("veg.grass.proto", scene, { diameterTop: 0, diameterBottom: 0.45, height: 0.4, tessellation: 5 }, grassMat);

  const flowerStem = cyl("veg.fstem.proto", scene, { diameter: 0.04, height: 0.36, tessellation: 4 }, grassMat);
  const flowerHeadYellow = sphere("veg.fheadY", scene, 3, 0.18, flowerY);
  const flowerHeadPink   = sphere("veg.fheadP", scene, 3, 0.18, flowerP);
  const flowerHeadWhite  = sphere("veg.fheadW", scene, 3, 0.18, flowerW);

  // Rocks: low-poly polyhedra.
  const rock = MeshBuilder.CreatePolyhedron("veg.rock.proto", { type: 1, size: 0.6 }, scene);
  rock.material = rockMat;
  const boulder = MeshBuilder.CreatePolyhedron("veg.boulder.proto", { type: 2, size: 1.4 }, scene);
  boulder.material = boulderMat;

  // Oil barrel: cylinder with a darker top.
  const barrel = cyl("veg.barrel.proto", scene, { diameter: 0.6, height: 0.9, tessellation: 10 }, barrelMat);

  // Sign post & face.
  const signPost = cyl("veg.signpost.proto", scene, { diameter: 0.12, height: 1.1, tessellation: 6 }, postMat);
  const signFace = MeshBuilder.CreateBox("veg.signface.proto", { width: 0.7, height: 0.5, depth: 0.06 }, scene);
  signFace.material = signMat;

  // Billboard.
  const bbLeg = cyl("veg.bbleg.proto", scene, { diameter: 0.18, height: 3.4, tessellation: 6 }, postMat);
  const bbBoard = MeshBuilder.CreateBox("veg.bbboard.proto", { width: 4.2, height: 1.6, depth: 0.15 }, scene);
  bbBoard.material = bbBoardMat;

  // Hay bale: a fat cylinder laid on its side.
  const hayBale = cyl("veg.hay.proto", scene, { diameter: 0.9, height: 1.2, tessellation: 10 }, hayMat);
  hayBale.rotation.z = Math.PI / 2;
  hayBale.bakeCurrentTransformIntoVertices();

  const houseBody = MeshBuilder.CreateBox("veg.houseBody.proto", { width: 3.0, height: 2.2, depth: 2.4 }, scene);
  houseBody.material = wallMatA;
  const houseRoof = cyl("veg.houseRoof.proto", scene, { diameterTop: 0, diameterBottom: 3.4, height: 1.2, tessellation: 4 }, roofMat);
  houseRoof.rotation.y = Math.PI / 4;
  houseRoof.bakeCurrentTransformIntoVertices();

  const warehouse = MeshBuilder.CreateBox("veg.warehouse.proto", { width: 5.0, height: 3.2, depth: 4.0 }, scene);
  warehouse.material = wallMatB;

  const towerBase = MeshBuilder.CreateBox("veg.towerBase.proto", { width: 2.0, height: 4.4, depth: 2.0 }, scene);
  towerBase.material = towerMat;
  const towerCap = cyl("veg.towerCap.proto", scene, { diameterTop: 0, diameterBottom: 2.6, height: 1.2, tessellation: 4 }, roofMat);
  towerCap.rotation.y = Math.PI / 4;
  towerCap.bakeCurrentTransformIntoVertices();

  // Distant mountain: low-poly cone, double-tess so silhouette reads.
  const mountain = cyl("veg.mountain.proto", scene, { diameterTop: 0, diameterBottom: 2.0, height: 2.0, tessellation: 9 }, mountainMat);

  for (const m of [
    trunk, foliageA, foliageB, foliageC, pineTrunk, pineLayer,
    bush, grass, flowerStem, flowerHeadYellow, flowerHeadPink, flowerHeadWhite,
    rock, boulder, barrel, signPost, signFace, bbLeg, bbBoard, hayBale,
    houseBody, houseRoof, warehouse, towerBase, towerCap, mountain,
  ]) {
    m.isPickable = false;
  }

  return {
    trunk, foliageA, foliageB, foliageC, pineTrunk, pineLayer,
    bush, grass, flowerStem, flowerHeadYellow, flowerHeadPink, flowerHeadWhite,
    rock, boulder, barrel, signPost, signFace, bbLeg, bbBoard, hayBale,
    houseBody, houseRoof, warehouse, towerBase, towerCap, mountain,
  };
}

function cyl(
  name: string,
  scene: Scene,
  opts: Parameters<typeof MeshBuilder.CreateCylinder>[1],
  mat: StandardMaterial,
): Mesh {
  const m = MeshBuilder.CreateCylinder(name, opts, scene);
  m.material = mat;
  return m;
}

function sphere(name: string, scene: Scene, segments: number, diameter: number, mat: StandardMaterial): Mesh {
  const m = MeshBuilder.CreateSphere(name, { diameter, segments }, scene);
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

// ─── scatter helpers ───────────────────────────────────────────────────────

function scatter(
  count: number,
  rng: () => number,
  centerline: ReadonlyArray<Vec2>,
  spawn: { x: number; z: number },
  place: (x: number, z: number) => void,
  clearance: number = TRACK_CLEARANCE,
): void {
  let placed = 0;
  let attempts = 0;
  const maxAttempts = count * 8;
  while (placed < count && attempts < maxAttempts) {
    attempts += 1;
    const r = Math.sqrt(rng()) * SCATTER_RADIUS;
    const a = rng() * Math.PI * 2;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (Math.hypot(x - spawn.x, z - spawn.z) < SPAWN_CLEARANCE) continue;
    if (distToCenterline(x, z, centerline) < clearance) continue;
    place(x, z);
    placed += 1;
  }
}

function distToCenterline(x: number, z: number, line: ReadonlyArray<Vec2>): number {
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    let t = ((x - a.x) * dx + (z - a.z) * dz) / Math.max(len2, 1e-6);
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    const ddx = x - px;
    const ddz = z - pz;
    const d2 = ddx * ddx + ddz * ddz;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

function nearestTangent(x: number, z: number, line: ReadonlyArray<Vec2>): { tx: number; tz: number } {
  let bestD = Infinity;
  let bi = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1];
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const d = (x - mx) * (x - mx) + (z - mz) * (z - mz);
    if (d < bestD) { bestD = d; bi = i; }
  }
  const a = line[bi];
  const b = line[bi + 1] ?? a;
  const dx = b.x - a.x, dz = b.z - a.z;
  const ln = Math.hypot(dx, dz) || 1;
  return { tx: dx / ln, tz: dz / ln };
}

function isLowPowerDevice(): boolean {
  return typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;
}

function collectMaterials(values: ReadonlyArray<unknown>): Set<StandardMaterial> {
  const mats = new Set<StandardMaterial>();
  for (const v of values) {
    if (v instanceof Mesh && v.material instanceof StandardMaterial) mats.add(v.material);
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
