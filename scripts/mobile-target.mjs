import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { cpSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const command = process.argv[2];
if (command !== "dev" && command !== "build") {
  console.error("用法: node scripts/mobile-target.mjs <dev|build>");
  process.exitCode = 2;
} else {
  const viteEntry = resolve("node_modules/vite/bin/vite.js");
  const start = async () => {
    let apiChild;
    let viteChild;
    let stopping = false;
    const stop = (code, signal = "SIGTERM") => {
      if (stopping) return;
      stopping = true;
      process.exitCode = code;
      apiChild?.kill(signal);
      viteChild?.kill(signal);
    };
    const apiPortIsOpen = () => new Promise((resolveProbe) => {
      const socket = createConnection({ host: "127.0.0.1", port: 1430 });
      socket.setTimeout(500);
      socket.once("connect", () => { socket.destroy(); resolveProbe(true); });
      socket.once("error", () => resolveProbe(false));
      socket.once("timeout", () => { socket.destroy(); resolveProbe(false); });
    });

    if (command === "dev") {
      if (await apiPortIsOpen()) {
        console.log("复用已运行的本地 Web API：127.0.0.1:1430");
      } else {
        apiChild = spawn(process.execPath, ["--watch", resolve("web-api.mjs")], { stdio: "inherit", env: process.env });
        apiChild.on("error", (error) => {
          console.error(`启动本地 Web API 失败: ${error.message}`);
          stop(1);
        });
        apiChild.on("exit", (code, signal) => {
          if (!stopping) {
            console.error("本地 Web API 已停止，移动端预览也将关闭。");
            stop(code ?? (signal ? 1 : 0));
          }
        });
      }
    }

    if (command === "build") {
      // Android init can retain the template launcher. Copy the maintained icon
      // resources before packaging instead of editing generated manifests.
      const androidResources = resolve("src-tauri/gen/android/app/src/main/res");
      if (existsSync(androidResources)) {
        cpSync(resolve("src-tauri/icons/android"), androidResources, { recursive: true });
        console.log("Android 桌面图标已同步为 CloudHub 图标。");
      }
    }

    viteChild = spawn(process.execPath, [viteEntry, ...(command === "build" ? ["build"] : [])], {
      stdio: "inherit",
      env: {
        ...process.env,
        VITE_APP_TARGET: "mobile",
        VITE_DEV_PORT: process.env.VITE_DEV_PORT || "1422",
      },
    });
    viteChild.on("error", (error) => {
      console.error(`启动移动端构建失败: ${error.message}`);
      stop(1);
    });
    viteChild.on("exit", (code, signal) => {
      if (command === "build" && code === 0 && !stopping) {
        // 桌宠精灵图只服务桌面端窗口；移动端构建把前端资产整体嵌入 libapp.so，
        // 不剔除会让四张 PNG（约 7.4MB）白白进入 APK。面板在移动端有诚实提示兜底。
        try {
          const distAssets = resolve("dist/assets");
          let removed = 0;
          if (existsSync(distAssets)) {
            for (const entry of readdirSync(distAssets)) {
              if (/(dog|penguin|alpaca|fish)-sprites-[^.]+\.png$/.test(entry)) {
                unlinkSync(join(distAssets, entry));
                removed += 1;
              }
            }
          }
          if (removed > 0) console.log(`移动端构建已剔除桌宠精灵图 ${removed} 张，节省约 7.4MB 安装体积。`);
        } catch (error) {
          console.error(`剔除桌宠精灵图失败: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (!stopping) stop(code ?? (signal ? 1 : 0));
    });
    process.once("SIGINT", () => stop(0, "SIGINT"));
    process.once("SIGTERM", () => stop(0, "SIGTERM"));
  };
  start().catch((error) => {
    console.error(`启动移动端预览失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
