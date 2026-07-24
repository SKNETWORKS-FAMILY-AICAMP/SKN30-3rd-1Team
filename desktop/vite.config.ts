import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { astryxStylex, LIGHTNINGCSS_TARGETS } from "@astryxdesign/build/vite";

export default defineConfig({
  base: "./",
  plugins: [
    ...astryxStylex({ lightningcssTargets: LIGHTNINGCSS_TARGETS }),
    react(),
  ],
  clearScreen: false,
  server: {
    strictPort: true,
  },
});
