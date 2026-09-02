import fs from "node:fs";
import path from "node:path";

const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, "AppData", "Local");
export const dataDir = path.join(localAppData, "CloudHubTools");
const legacyDataDir = path.join(localAppData, "AliyunTools");
export const dbPath = path.join(dataDir, "cloudhub_tools.sqlite3");
export const keyPath = path.join(dataDir, ".key");

function migrateLegacyData() {
  if (fs.existsSync(dataDir) || !fs.existsSync(legacyDataDir)) return;
  fs.mkdirSync(dataDir, { recursive: true });
  for (const [legacyName, currentName] of [["aliyun_tools.sqlite3", "cloudhub_tools.sqlite3"], [".key", ".key"]]) {
    const source = path.join(legacyDataDir, legacyName);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(dataDir, currentName));
  }
}

export function ensureDataDir() {
  migrateLegacyData();
  fs.mkdirSync(dataDir, { recursive: true });
}

ensureDataDir();
