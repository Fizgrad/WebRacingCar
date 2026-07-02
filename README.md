# Car Racing

Minimalist 3D browser racing simulator built with **Babylon.js**, **Vite**, **TypeScript**, and **Rapier** physics.

## Features

- Low-poly minimalist 3D visuals
- Raycast-suspension vehicle physics
- Selectable cars:
  - Apex RS
  - Retro Wedge
  - V10 Strada
- Built-in tracks:
  - Infinite Straight
  - Speedway Oval
  - Endless Highway
- Custom track keypoint editor
- Procedural endless track streaming
- Car-centered speed-scaling minimap
- Procedural engine and tire-slip audio
- Mobile touch controls:
  - screen gas/brake buttons
  - tilt steering via device orientation
- Low-poly scenery:
  - trees, flowers, rocks, hills, water patches, buildings, signs, billboards

## Stack

- Runtime: Babylon.js (`@babylonjs/core`)
- Physics: Rapier (`@dimforge/rapier3d-compat`)
- Tooling: Vite + TypeScript
- Package manager: npm

## Setup

```bash
npm install
npm run dev
```

Open the dev server URL shown by Vite.

## Scripts

```bash
npm run dev        # start Vite dev server
npm run typecheck  # TypeScript check only
npm run lint       # ESLint over src/**/*.ts
npm run build      # typecheck + production build
npm run preview    # serve production build
```

Before considering changes complete, run:

```bash
npm run typecheck && npm run lint && npm run build
```

## Controls

### Desktop

- `W` / `ArrowUp`: throttle
- `S` / `ArrowDown`: brake
- `A/D` / `ArrowLeft/ArrowRight`: steer
- `Space`: handbrake
- `R`: reset to start
- `T`: back to menu
- `Enter`: start driving from custom track editor
- `Esc`: leave track editor

### Mobile

- Tilt phone left/right to steer
- Right button: gas
- Left button: brake
- Top-right button: menu

For Android/Samsung device orientation, test through a secure context. `http://<LAN-IP>:5173` may block motion sensors in Chrome. Use HTTPS, localhost tunneling, or a trusted local setup.

## Custom Track Mode

Choose **Custom — Draw Your Own** to open the top-down keypoint editor.

- Click empty ground to add key points.
- Drag existing points to reshape the route.
- Green point = start, red point = end, blue points = intermediate controls.
- Use the curve smoothness slider to move between straighter connections and smoother arc-like bends.
- Use the mouse wheel to zoom; the side panel shows the approximate view scale.
- Click **Start driving** or press `Enter` when the route is ready.

The final path is still processed by the track builder: high-curvature regions are smoothed, unsafe corners are rounded, the road ribbon is generated from centerline normals, and Rapier trimesh colliders are created.

## Project Layout

```text
src/
  main.ts              # bootstrap, menu, mode switching, render loop
  game/                # input, camera, minimap, audio, car previews
  physics/             # Rapier world and fixed timestep
  render/              # Babylon scene, sky, palette
  track/               # track builder, designer, endless generator/streamer
  vehicle/             # car specs and raycast vehicle physics
  world/               # vegetation, terrain features, endless scenery props
```

## Notes

- Babylon scene uses `scene.useRightHandedSystem = true` to match Rapier.
- Rapier forces are persistent; vehicle update resets forces/torques before applying new ones each frame.
- Visual style intentionally avoids heavy assets, PBR materials, HDR, skyboxes, and postprocessing.
- Do not commit `dist/`, `node_modules/`, or Vite cache output.
