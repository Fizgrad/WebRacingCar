import {
  Color3,
  Engine,
  HemisphericLight,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
  FreeCamera,
} from "@babylonjs/core";
import type { CarSpec } from "../vehicle/cars";
import type { Materials } from "../render/scene";

export interface CarPreview {
  canvas: HTMLCanvasElement;
  dispose(): void;
}

export function createCarPreview(car: CarSpec): CarPreview {
  const canvas = document.createElement("canvas");
  canvas.width = 180;
  canvas.height = 110;
  canvas.className = "carPreviewCanvas";
  canvas.style.pointerEvents = "none";

  const engine = new Engine(canvas, true, {
    antialias: true,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: "low-power",
  });
  engine.setHardwareScalingLevel(1);

  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  scene.clearColor.set(0, 0, 0, 0);
  scene.ambientColor = new Color3(0.75, 0.78, 0.8);

  const light = new HemisphericLight("preview.light", new Vector3(0.2, 1, 0.4), scene);
  light.intensity = 1.2;

  const camera = new FreeCamera("preview.camera", new Vector3(3.1, 1.7, -5.2), scene);
  camera.setTarget(new Vector3(0, 0.45, 0));
  scene.activeCamera = camera;

  const materials = createMaterials(scene, car.bodyColor);
  const root = new TransformNode("preview.root", scene);
  car.buildVisual(root, scene, materials, car);
  root.scaling.setAll(0.72);
  root.rotation.y = -0.35;

  let disposed = false;
  engine.runRenderLoop(() => {
    if (disposed) return;
    root.rotation.y += engine.getDeltaTime() * 0.00055;
    scene.render();
  });

  return {
    canvas,
    dispose(): void {
      disposed = true;
      engine.stopRenderLoop();
      scene.dispose();
      engine.dispose();
    },
  };
}

function createMaterials(scene: Scene, carColor: Color3): Materials {
  return {
    ground: mat("preview.ground", scene, new Color3(0.55, 0.62, 0.42)),
    groundDark: mat("preview.groundDark", scene, new Color3(0.42, 0.49, 0.32)),
    road: mat("preview.road", scene, new Color3(0.32, 0.32, 0.34)),
    roadEdge: mat("preview.roadEdge", scene, new Color3(0.92, 0.92, 0.9)),
    carBody: mat("preview.carBody", scene, carColor),
    carDark: mat("preview.carDark", scene, new Color3(0.07, 0.08, 0.09)),
    cone: mat("preview.cone", scene, new Color3(0.95, 0.55, 0.18)),
    shadow: mat("preview.shadow", scene, new Color3(0.18, 0.2, 0.22)),
  };
}

function mat(name: string, scene: Scene, color: Color3): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = color;
  m.specularColor = new Color3(0, 0, 0);
  m.emissiveColor = color.scale(0.24);
  return m;
}
