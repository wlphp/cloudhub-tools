import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

let child;
let waiting;
let queue = Promise.resolve();
let queued = 0;
const root = fileURLToPath(new URL("../../", import.meta.url));
function close() { child?.kill(); child = undefined; }
export function closeAuthenticatorBridge() { close(); }
function start() {
  if (child) return child;
  const filename = process.platform === "win32" ? "cloudhub-tools.exe" : "cloudhub-tools";
  const executable = ["debug", "release"].map(mode => path.join(root, "src-tauri", "target", mode, filename)).find(existsSync);
  if (!executable) throw new Error("请先运行 cargo build --manifest-path src-tauri/Cargo.toml，再打开浏览器验证器");
  const processHandle = spawn(executable, ["--browser-authenticator"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  child = processHandle;
  createInterface({ input: processHandle.stdout }).on("line", line => {
    if (!waiting || waiting.process !== processHandle) return;
    const { resolve, reject, timeout } = waiting; waiting = undefined; clearTimeout(timeout);
    try {
      if (line.length > 30 * 1024 * 1024) throw new Error();
      const response = JSON.parse(line);
      if (response.error) { const error = new Error(response.error); error.code = response.code; reject(error); }
      else resolve(response.result);
    } catch { reject(new Error("验证器响应无效")); close(); }
  });
  const stopped = () => {
    if (child === processHandle) child = undefined;
    if (waiting?.process === processHandle) { clearTimeout(waiting.timeout); waiting.reject(new Error("本机验证器进程已停止，请重试")); waiting = undefined; }
  };
  processHandle.once("error", stopped); processHandle.once("exit", stopped);
  return processHandle;
}
export function callAuthenticator(op, args = {}) {
  if (queued >= 30) return Promise.reject(new Error("验证器操作过多，请稍后重试"));
  queued++;
  const job = queue.then(() => new Promise((resolve, reject) => {
    let processHandle;
    try { processHandle = start(); } catch (error) { reject(error); return; }
    const timeout = setTimeout(() => { waiting = undefined; close(); reject(new Error("验证器操作超时，请重试")); }, 120000);
    waiting = { process: processHandle, resolve, reject, timeout };
    processHandle.stdin.write(JSON.stringify({ op, args }) + "\n", error => {
      if (error && waiting?.process === processHandle) { clearTimeout(timeout); waiting = undefined; close(); reject(new Error("验证器请求失败")); }
    });
  }));
  queue = job.catch(() => {}).finally(() => { queued--; });
  return job;
}
process.once("exit", close);
