/**
 * Minimalist palette. Single source of truth for scene colors.
 * Keep it tight; expansion should be deliberate.
 */
import { Color3, Color4 } from "@babylonjs/core";

export const palette = {
  sky: new Color4(0.55, 0.78, 0.94, 1.0),       // bright blue
  fog: new Color3(0.78, 0.86, 0.94),             // pale haze toward horizon
  cloud: new Color3(1.0, 1.0, 1.0),              // pure white clouds
  ground: new Color3(0.55, 0.62, 0.42),
  groundDark: new Color3(0.42, 0.49, 0.32),
  road: new Color3(0.32, 0.32, 0.34),
  roadEdge: new Color3(0.92, 0.92, 0.9),
  carBody: new Color3(0.86, 0.27, 0.22),
  carDark: new Color3(0.16, 0.18, 0.2),
  cone: new Color3(0.95, 0.55, 0.18),
  shadow: new Color3(0.18, 0.2, 0.22),
} as const;
