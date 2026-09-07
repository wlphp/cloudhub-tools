import fs from "node:fs";

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

const packageJson = readJson("package.json");
const tauriConfig = readJson("src-tauri/tauri.conf.json");
const workflow = fs.readFileSync(".github/workflows/release.yml", "utf8");
const failures = [];

if (packageJson.version !== tauriConfig.version) {
  failures.push(`package.json version (${packageJson.version}) 与 Tauri version (${tauriConfig.version}) 不一致`);
}
if (tauriConfig.bundle?.active !== true) failures.push("Tauri bundle.active 必须为 true");
if (tauriConfig.bundle?.createUpdaterArtifacts !== true) failures.push("Tauri updater artifacts 未启用");
if (!String(tauriConfig.plugins?.updater?.pubkey || "").trim()) failures.push("Tauri updater 公钥为空");
const endpoints = tauriConfig.plugins?.updater?.endpoints || [];
if (!endpoints.length || endpoints.some((endpoint) => !String(endpoint).startsWith("https://"))) {
  failures.push("Tauri updater endpoint 必须存在且全部使用 HTTPS");
}

for (const command of [
  "npm run build",
  "npm run verify:platform-contracts",
  "npm run verify:rust-boundary",
  "node scripts/verify-web-api-security.mjs",
  "node scripts/verify-web-api-logs.mjs",
  "npm run test:ui",
  "cargo check --manifest-path src-tauri/Cargo.toml",
  "cargo test --manifest-path src-tauri/Cargo.toml",
]) {
  if (!workflow.includes(command)) failures.push(`发布 workflow 缺少门禁：${command}`);
}
for (const platform of ["windows-2022", "macos-15-intel", "macos-latest", "ubuntu-24.04"]) {
  if (!workflow.includes(platform)) failures.push(`发布 workflow 缺少平台：${platform}`);
}
if (!workflow.includes("tauri-apps/tauri-action@v1")) failures.push("发布 workflow 缺少 Tauri 打包动作");
if (!workflow.includes("--bundles nsis,msi")) failures.push("Windows 发布 workflow 必须同时生成 NSIS 和 MSI");
if (!workflow.includes("TAURI_SIGNING_PRIVATE_KEY is required for signed updater artifacts.")) failures.push("发布 workflow 缺少更新器签名 Secret 预检");
if (!workflow.includes("npm run verify:bundle-artifacts -- --platform windows")) failures.push("发布 workflow 缺少 Windows 安装包产物审计");

if (failures.length) {
  console.error("Release configuration checks failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Release configuration checks passed: version, updater, CI gates, and platform matrix");
}
