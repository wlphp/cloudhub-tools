#!/usr/bin/env node
// 把 latest.json 里的更新包地址规范化为 GitHub 公开下载地址。
// tauri-action 固定写入 api.github.com/.../releases/assets/<id>，而部分环境
// （桌面白名单历史版本、705810 镜像）无法处理该格式。本脚本在发布后覆盖上传，
// 使所有存量客户端都能识别更新。签名与版本内容不变，仅替换下载 URL。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const REPO = "wlphp/cloudhub-tools";
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const tagIndex = args.indexOf("--tag");
const tag = tagIndex >= 0 ? args[tagIndex + 1] : process.env.RELEASE_TAG;

if (!tag || tag.startsWith("--")) {
  console.error("用法: normalize-updater-json.mjs --tag <tag> [--dry-run]");
  process.exit(1);
}

function ghApi(path) {
  return JSON.parse(execFileSync("gh", ["api", `repos/${REPO}/${path}`], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
}

const release = ghApi(`releases/tags/${tag}`);
const assets = release.assets ?? [];
const downloadById = new Map(assets.map((asset) => [String(asset.id), asset.browser_download_url]));
const latestAsset = assets.find((asset) => asset.name === "latest.json");
if (!latestAsset) throw new Error(`Release ${tag} 缺少 latest.json 资产`);

const manifestResponseText = execFileSync(
  "gh",
  ["api", "-H", "Accept: application/octet-stream", `repos/${REPO}/releases/assets/${latestAsset.id}`],
  { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
const manifest = JSON.parse(manifestResponseText);

const ASSET_API = /^https:\/\/api\.github\.com\/repos\/wlphp\/cloudhub-tools\/releases\/assets\/(\d+)$/;
const PUBLIC_DL = /^https:\/\/github\.com\/wlphp\/cloudhub-tools\/releases\/download\/[^/?#]+\/[^?#]+$/;
const changed = [];
const failures = [];

for (const [platform, info] of Object.entries(manifest.platforms ?? {})) {
  const original = info?.url;
  if (typeof original !== "string") { failures.push(`${platform}: url 不是字符串`); continue; }
  const match = ASSET_API.exec(original);
  const replacement = match ? downloadById.get(match[1]) : original;
  if (!replacement) { failures.push(`${platform}: 找不到资产 ${original}`); continue; }
  if (!PUBLIC_DL.test(replacement)) { failures.push(`${platform}: 规范化后地址不合法 ${replacement}`); continue; }
  if (replacement !== original) { info.url = replacement; changed.push(platform); }
}

if (failures.length) {
  console.error("更新清单规范化失败:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

if (dryRun) {
  console.log(`[dry-run] ${tag} 需改写 ${changed.length} 项: ${changed.join(", ") || "无"}`);
  for (const platform of changed) console.log(`  ${platform}: ${manifest.platforms[platform].url}`);
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "cloudhub-updater-"));
const localPath = join(dir, "latest.json");
try {
  writeFileSync(localPath, JSON.stringify(manifest, null, 2) + "\n");
  execFileSync("gh", ["release", "upload", tag, localPath, "--clobber", "--repo", REPO], { stdio: "inherit" });
  console.log(`已规范化 ${tag} 的 latest.json，改写 ${changed.length} 项: ${changed.join(", ") || "无"}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
