import {
  Engine,
  Scene,
  Color3,
  HemisphericLight,
  DirectionalLight,
  Vector3,
  StandardMaterial,
} from "@babylonjs/core";
import { palette } from "./palette";

export interface Materials {
  ground: StandardMaterial;
  groundDark: StandardMaterial;
  road: StandardMaterial;
  roadEdge: StandardMaterial;
  carBody: StandardMaterial;
  carDark: StandardMaterial;
  cone: StandardMaterial;
  shadow: StandardMaterial;
}

export interface RenderContext {
  engine: Engine;
  scene: Scene;
  materials: Materials;
}

function flatMat(name: string, scene: Scene, color: Color3): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = color;
  m.specularColor = new Color3(0, 0, 0);
  m.emissiveColor = color.scale(0.25);
  return m;
}

export function createRenderContext(canvas: HTMLCanvasElement): RenderContext {
  const engine = new Engine(canvas, true, {
    antialias: true,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
  });
  engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio, 2));

  const scene = new Scene(engine);
  // Right-handed to match Rapier. Documented in AGENTS.md.
  scene.useRightHandedSystem = true;
  scene.clearColor = palette.sky;
  scene.ambientColor = new Color3(0.6, 0.62, 0.65);

  // Distance fog blends the ground into the sky color near the horizon.
  scene.fogMode = Scene.FOGMODE_LINEAR;
  scene.fogColor = palette.fog;
  scene.fogStart = 280;
  scene.fogEnd = 720;

  // One hemispheric for fill + one weak directional for shape. No shadows.
  const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.85;
  hemi.diffuse = new Color3(1, 1, 0.98);
  hemi.groundColor = new Color3(0.4, 0.42, 0.45);

  const dir = new DirectionalLight("sun", new Vector3(-0.4, -1, -0.3), scene);
  dir.intensity = 0.35;

  const materials = {
    ground: flatMat("mat.ground", scene, palette.ground),
    groundDark: flatMat("mat.groundDark", scene, palette.groundDark),
    road: flatMat("mat.road", scene, palette.road),
    roadEdge: flatMat("mat.roadEdge", scene, palette.roadEdge),
    carBody: flatMat("mat.carBody", scene, palette.carBody),
    carDark: flatMat("mat.carDark", scene, palette.carDark),
    cone: flatMat("mat.cone", scene, palette.cone),
    shadow: flatMat("mat.shadow", scene, palette.shadow),
  };
  materials.shadow.alpha = 0.35;
  // Negative zOffset pulls the shadow forward in the depth buffer so it always
  // wins over the road ribbon and the ground beneath it (no flicker).
  materials.shadow.zOffset = -8;

  return { engine, scene, materials };
}
