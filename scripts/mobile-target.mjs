import { spawn } from "node:child_process";
import { resolve } from "node:path";

const command = process.argv[2];
if (command !== "dev" && command !== "build") {
  console.error("用法: node scripts/mobile-target.mjs <dev|build>");
  process.exitCode = 2;
} else {
  const viteEntry = resolve("node_modules/vite/bin/vite.js");
  const child = spawn(process.execPath, [viteEntry, ...(command === "build" ? ["build"] : [])], {
    stdio: "inherit",
    env: { ...process.env, VITE_APP_TARGET: "mobile" },
  });
  child.on("error", (error) => {
    console.error(`启动移动端构建失败: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
