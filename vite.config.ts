import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({plugins: [react()],
  // Keep the main bundle small so the React tree mounts before the user notices
  // a blank workbench. Heavy, only-on-demand modules (xterm, the Tauri runtime,
  // feature workspaces) are pushed into separate chunks.
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes("node_modules/@xterm/")) return "xterm";
          if (id.includes("node_modules/@tauri-apps/")) return "tauri-runtime";
          if (id.includes("node_modules/react-dom")) return "react-dom";
          if (id.includes("node_modules/lucide-react")) return "icons";
          return undefined;
        },
      },
    },
  },
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
