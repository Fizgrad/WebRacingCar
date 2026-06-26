import RAPIER from "@dimforge/rapier3d-compat";

export interface PhysicsWorld {
  rapier: typeof RAPIER;
  world: RAPIER.World;
  /** Advance the world by `dt` seconds using a fixed timestep accumulator. */
  step(dt: number): void;
  dispose(): void;
}

const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 8;

export async function createPhysicsWorld(): Promise<PhysicsWorld> {
  await RAPIER.init();
  const gravity = { x: 0, y: -9.81, z: 0 };
  const world = new RAPIER.World(gravity);
  world.timestep = FIXED_DT;

  let accumulator = 0;

  return {
    rapier: RAPIER,
    world,
    step(dt: number) {
      // Clamp huge frames (tab switch) so we don't spiral.
      accumulator += Math.min(dt, 0.1);
      let steps = 0;
      while (accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
        world.step();
        accumulator -= FIXED_DT;
        steps += 1;
      }
      // Drop leftover time if we hit the cap to avoid permanent debt.
      if (steps === MAX_SUBSTEPS) accumulator = 0;
    },
    dispose() {
      world.free();
    },
  };
}
