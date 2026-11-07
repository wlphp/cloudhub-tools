import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
const devPort = Number(process.env.VITE_DEV_PORT) || 1420;
// 桌面与移动构建分目录输出：两端 beforeBuildCommand 共享仓库但产物互不覆盖，
// 并发跑 npm run build 与 npm run build:mobile 时各自嵌入各自的目标产物。
const mobileTarget = process.env.VITE_APP_TARGET === "mobile";

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  build: {
    outDir: mobileTarget ? "dist-mobile" : "dist",
    emptyOutDir: true,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: devPort,
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
      // 4. Windows 上 chokidar 事件偶发丢失导致热更新漏推，改用轮询确保可靠
      usePolling: true,
      interval: 300,
    },
  },
}));
