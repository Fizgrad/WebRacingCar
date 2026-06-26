import {
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
  Mesh,
} from "@babylonjs/core";
import { palette } from "./palette";

/**
 * Minimalist sky: a static cluster of low-poly white "clouds" floating high
 * above the playable area. No skybox texture, no shaders — just a few flat
 * spheres / discs against the scene clear color (blue).
 *
 * Clouds are unlit (emissive = white) so they don't darken on the shaded side
 * and don't react to fog (which is handy because they sit beyond fog range).
 */
export function buildSky(scene: Scene): TransformNode {
  const root = new TransformNode("sky.root", scene);

  const mat = new StandardMaterial("sky.cloud", scene);
  mat.diffuseColor = palette.cloud;
  mat.emissiveColor = palette.cloud; // unlit
  mat.specularColor.set(0, 0, 0);
  mat.disableLighting = true;
  // Clouds sit far away and shouldn't fade into fog.
  mat.disableDepthWrite = false;

  // Place ~28 puffy clouds over a wide area centered on origin.
  const seed = mulberry32(0x9e37);

  for (let i = 0; i < 60; i++) {
    const cluster = makeCluster(scene, mat, seed);
    const angle = seed() * Math.PI * 2;
    const dist = 400 + seed() * 600; // 400–1000 m radius
    const height = 110 + seed() * 110;
    cluster.position.set(
      Math.cos(angle) * dist,
      height,
      Math.sin(angle) * dist,
    );
    cluster.parent = root;
  }

  return root;
}

/** Small group of 3–5 spheres glued together to form a single fluffy cloud. */
function makeCluster(scene: Scene, mat: StandardMaterial, rnd: () => number): TransformNode {
  const cluster = new TransformNode("cloud", scene);
  const puffs = 3 + Math.floor(rnd() * 3);
  const baseSize = 12 + rnd() * 10;
  for (let i = 0; i < puffs; i++) {
    const s = MeshBuilder.CreateSphere(
      "cloud.puff",
      { diameter: baseSize * (0.7 + rnd() * 0.7), segments: 6 },
      scene,
    );
    s.position.set(
      (rnd() - 0.5) * baseSize * 1.4,
      (rnd() - 0.5) * baseSize * 0.25,
      (rnd() - 0.5) * baseSize * 1.4,
    );
    s.scaling.y = 0.55; // squash vertically — clouds are flat-ish
    s.material = mat;
    s.isPickable = false;
    s.applyFog = false;
    s.parent = cluster;
    // Disable shadow casting (we have none, but be explicit for any future use).
    s.receiveShadows = false;
    void Mesh; void Vector3;
  }
  return cluster;
}

/** Tiny seeded PRNG so cloud layout is deterministic across reloads. */
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
