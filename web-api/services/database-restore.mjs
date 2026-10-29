import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dataDir } from "../core/paths.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
let child, pending;
let queue = Promise.resolve();
let queued = 0;
const sessions = new Map();
export function closeDatabaseRestoreBridge() {
  child?.kill(); child = undefined;
  for (const [token, timer] of sessions) {
    clearTimeout(timer);
    try { fs.rmSync(path.join(dataDir, `.cloudhub-import-preview-${token}.sqlite3`), { force: true }); } catch { /* An active helper may still be releasing its file. */ }
  }
  sessions.clear();
}
function start() {
  if (child) return child;
  const filename = process.platform === "win32" ? "cloudhub-browser-database.exe" : "cloudhub-browser-database";
  const targetDir = process.env.CARGO_TARGET_DIR ? path.resolve(root, process.env.CARGO_TARGET_DIR) : path.join(root, "src-tauri", "target");
  const executable = ["debug", "release"].map(mode => path.join(targetDir, mode, filename)).find(file => fs.existsSync(file));
  if (!executable) throw new Error("请先编译本机调试程序，再使用网页恢复");
  const processHandle = spawn(executable, [], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, CLOUDHUB_BROWSER_DATA_DIR: dataDir } });
  child = processHandle;
  createInterface({ input: processHandle.stdout }).on("line", line => {
    if (pending?.process !== processHandle) return;
    const { resolve, reject, timer } = pending; pending = undefined; clearTimeout(timer);
    try {
      if (line.length > 2 * 1024 * 1024) throw new Error();
      const response = JSON.parse(line);
      if (typeof response.error === "string") reject(new Error(response.error.includes("密码") ? "备份密码错误或缺失，请填写正确密码后重新下载" : "备份恢复失败，请检查备份与恢复范围后重新下载"));
      else if (Object.hasOwn(response, "result")) resolve(response.result);
      else throw new Error();
    } catch { reject(new Error("本机恢复响应无效，请重新下载备份")); closeDatabaseRestoreBridge(); }
  });
  const stopped = () => {
    if (child === processHandle) closeDatabaseRestoreBridge();
    if (pending?.process === processHandle) { clearTimeout(pending.timer); pending.reject(new Error("本机恢复程序已停止，请重新编译调试程序后重试")); pending = undefined; }
  };
  processHandle.once("error", stopped); processHandle.once("exit", stopped);
  return processHandle;
}
export function callDatabaseRestore(request) {
  if (queued >= 8) return Promise.reject(new Error("恢复请求过多，请稍后重试"));
  queued++;
  const job = queue.then(() => new Promise((resolve, reject) => {
    let processHandle;
    try { processHandle = start(); } catch (error) { reject(error); return; }
    const timer = setTimeout(() => { pending = undefined; closeDatabaseRestoreBridge(); reject(new Error("本机恢复超时，请重新下载备份")); }, 120_000);
    pending = { process: processHandle, resolve, reject, timer };
    processHandle.stdin.write(JSON.stringify(request) + "\n", error => {
      if (error && pending?.process === processHandle) { clearTimeout(timer); pending = undefined; closeDatabaseRestoreBridge(); reject(new Error("本机恢复请求失败")); }
    });
  }));
  queue = job.catch(() => {}).finally(() => { queued--; });
  return job;
}
export function rememberRestore(token) {
  if (typeof token !== "string" || !/^[a-f0-9-]{36}$/.test(token)) throw new Error("恢复预览响应无效");
  const timer = setTimeout(() => { sessions.delete(token); void callDatabaseRestore({ op: "cancel", token }).catch(() => {}); }, 10 * 60_000);
  timer.unref(); sessions.set(token, timer);
}
export function consumeRestore(token) {
  if (typeof token !== "string" || !sessions.has(token)) throw new Error("恢复预览已失效，请重新下载备份");
  clearTimeout(sessions.get(token)); sessions.delete(token);
}
export async function createBrowserCloudBackup(tables = null) {
  const packagePath = path.join(dataDir, `.browser-upload-${crypto.randomUUID()}.chdb`);
  try {
    await callDatabaseRestore({ op: "backup", path: packagePath, tables });
    const info = await fs.promises.stat(packagePath);
    if (info.size > 256 * 1024 * 1024) throw new Error("备份超过 256 MB 限制");
    return await fs.promises.readFile(packagePath);
  } finally {
    await fs.promises.rm(packagePath, { force: true });
  }
}
process.once("exit", closeDatabaseRestoreBridge);
