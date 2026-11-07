import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 与 src-tauri/src/core/paths.rs 中 desktop_development() 的数据目录保持一致。
export function devDataDir(platform = process.platform, env = process.env) {
  if (platform === "win32") {
    return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "CloudHubTools-Dev");
  }
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "CloudHubTools-Dev");
  }
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "CloudHubTools-Dev");
}

// 调试端以读写模式打开 SQLite；若当前进程无写权限，Windows 会静默回退为只读连接，
// 之后所有保存操作都报 SQLite ReadOnly。这里在启动前主动探测并给出明确指引。
export function checkDevDataWriteAccess(dir = devDataDir(), pid = process.pid) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    return `无法创建调试版数据目录：${error.message}`;
  }
  const probe = join(dir, `.dev-write-probe-${pid}.tmp`);
  try {
    writeFileSync(probe, "probe");
    return null;
  } catch (error) {
    return `当前进程对调试版数据目录没有写入权限（${error.code ?? error.message}），启动后所有本地保存都会失败。\n`
      + `常见原因：本终端运行在受限沙箱（如 Codex 沙箱用户组对 AppData 仅有读权限）。\n`
      + `请改用普通终端运行 run-desktop-dev.bat，或退出沙箱会话后重试。目标目录：${dir}`;
  } finally {
    // 清理失败不能覆盖上面的主错误：只读目录下 writeFileSync 失败时，
    // 这里同样可能抛错，而那正是最需要看到明确提示的场景。
    try { rmSync(probe, { force: true }); } catch { /* 探针文件不存在或无法删除都不影响结论 */ }
  }
}

async function main() {
  const failure = checkDevDataWriteAccess();
  if (failure) {
    console.error(`[tauri-dev] ${failure}`);
    process.exit(1);
  }

  const tauriCli = resolve("node_modules/@tauri-apps/cli/tauri.js");
  const child = spawn(
    process.execPath,
    [tauriCli, "dev", "--config", "src-tauri/tauri.dev.conf.json"],
    {
      stdio: "inherit",
      env: { ...process.env, CARGO_PROFILE_DEV_DEBUG: "0" },
    },
  );

  let stopping = false;
  const forwardSignal = (signal) => {
    if (stopping) return;
    stopping = true;
    child.kill(signal);
  };

  process.once("SIGINT", () => forwardSignal("SIGINT"));
  process.once("SIGTERM", () => forwardSignal("SIGTERM"));
  child.once("error", (error) => {
    console.error(`启动 Tauri 桌面调试端失败: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal && !stopping) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? (stopping ? 0 : 1);
  });
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && entry.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main();
}
