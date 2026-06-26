import { defineConfig } from "vite";

export default defineConfig({
  base: "/WebRacingCar/",
  server: {
    port: 5173,
    host: true,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
