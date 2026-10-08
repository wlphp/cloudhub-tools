import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { resolve } from "node:path";

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
        apiChild = spawn(process.execPath, [resolve("web-api.mjs")], { stdio: "inherit", env: process.env });
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

    viteChild = spawn(process.execPath, [viteEntry, ...(command === "build" ? ["build"] : [])], {
      stdio: "inherit",
      env: { ...process.env, VITE_APP_TARGET: "mobile" },
    });
    viteChild.on("error", (error) => {
      console.error(`启动移动端构建失败: ${error.message}`);
      stop(1);
    });
    viteChild.on("exit", (code, signal) => {
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
