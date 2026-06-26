# AGENTS.md

## Project

Minimalist 3D rally racing simulator running in the browser via WebGL.

- Stack: **Babylon.js + Vite + TypeScript**
- Physics: **Rapier (`@dimforge/rapier3d-compat`)** — the `-compat` build is required so the WASM is inlined and Vite doesn't need extra WASM plumbing.
- Package manager: **npm** (do not introduce pnpm/yarn/bun lockfiles).
- Repo is currently empty. First scaffold should match the choices above before adding gameplay code.

## Aesthetic constraint (treat as hard requirement)

"简约风格 / minimalist." Default to:
- flat / unlit or single-directional-light shading, no PBR, no postprocessing stack
- low-poly primitives, vertex colors or solid materials over textures
- limited palette, no skyboxes (solid color or simple gradient/fog)
- no HDR, no shadows beyond a simple blob/projected shadow unless asked

Do not pull in heavy assets, GLTF environments, or `@babylonjs/materials` PBR variants without being asked.

## Commands (once scaffolded)

- `npm run dev` — Vite dev server (entry `index.html` -> `src/main.ts`)
- `npm run build` — `tsc --noEmit && vite build`
- `npm run preview` — serve the production build
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — ESLint over `src/**/*.ts`

Required order before declaring work done: **typecheck -> lint -> build**. `vite build` does not type-check on its own; rely on the `tsc --noEmit` step.

## Babylon + Rapier wiring notes

- Use Babylon's ES module entrypoint (`@babylonjs/core`), not the UMD bundle. Tree-shaking matters; import named symbols (`import { Engine, Scene } from "@babylonjs/core"`), avoid `import * as BABYLON`.
- Rapier must be initialized before any physics calls:
  ```ts
  import RAPIER from "@dimforge/rapier3d-compat";
  await RAPIER.init();
  ```
  Top-level `await` is fine (Vite + ES2022). Do not create the world before `init()` resolves.
- Step order each frame: `world.step()` -> read rigid body transforms -> write to Babylon `TransformNode`s -> `scene.render()`. Do not drive physics from Babylon's `onBeforeRenderObservable` without accounting for variable dt; use a fixed timestep accumulator.
- Babylon is **left-handed** by default; Rapier is **right-handed**. Either call `scene.useRightHandedSystem = true` (preferred for this project) or flip Z when copying transforms. Pick one and stick to it — mixing causes mirrored steering bugs.
- Vehicle: Rapier has no built-in raycast vehicle. Implement a 4-wheel raycast suspension on top of a single dynamic `RigidBody` for the chassis. Do not model wheels as separate rigid bodies connected by joints — that path is slow and unstable for arcade rally feel.

## Suggested layout

```
src/
  main.ts          # bootstrap: engine, scene, game loop
  game/            # game state, input, camera
  vehicle/         # chassis + raycast wheels + tire model
  physics/         # Rapier world, fixed-timestep stepper
  track/           # track generation / loading
  render/          # Babylon scene setup, materials, minimalist look
public/            # static assets served as-is
```

Keep modules small and side-effect-free except `main.ts`.

## Conventions

- TypeScript `strict: true`. No `any` in committed code; use `unknown` + narrowing.
- Units: meters, seconds, radians. Car mass in kg. Document any deviation in code.
- Do not commit `dist/`, `node_modules/`, or `.vite/`.

## Gotchas

- `@dimforge/rapier3d` (non-compat) requires `vite-plugin-wasm` + top-level await config and breaks `vite preview` on some hosts. Prefer `-compat`.
- **`body.addForce*` is PERSISTENT in Rapier — it does NOT auto-clear between steps.** If you rebuild forces each frame (e.g. raycast suspension), call `body.resetForces(false)` and `body.resetTorques(false)` at the top of your per-frame update or the car will accumulate force every frame and rocket into orbit. Hit this hard during initial development.
- Main-loop order matters: apply forces (`vehicle.update`) **before** `world.step()` so this frame's forces get integrated this frame. Stepping first and then adding forces just delays everything by one step and hides timing bugs.
- Suspension damping must only be applied while the spring is actually compressed (`compression > 0`). Applying a damping term based on body vertical velocity alone — even when the wheel is in the air — creates a half-wave-rectified energy pump that launches the car.
- Set chassis mass via collider density (`ColliderDesc.setDensity(mass / volume)`). `ColliderDesc.setMass` and `RigidBodyDesc.setAdditionalMass` interact in non-obvious ways across Rapier versions; density is the most predictable.
- Babylon's `ArcRotateCamera` defaults steal pointer events; for a driving game use `FreeCamera` or a custom follow camera and call `camera.detachControl()` if you keep it for debug.
- Hot reload will leak Babylon `Engine` / Rapier `World` instances. Dispose them in `import.meta.hot?.dispose(...)` when adding HMR-aware modules.
- macOS dev: Safari's WebGL2 is fine, but Rapier WASM streaming compile fails on `file://`. Always test through `npm run dev` / `npm run preview`, never by opening `dist/index.html` directly.

## When in doubt

Prefer the smallest change that keeps the minimalist look and the typecheck/lint/build chain green. Ask before adding new runtime dependencies, new asset pipelines, or any postprocessing.
