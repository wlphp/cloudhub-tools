import fs from "node:fs";
import path from "node:path";

const platform = process.argv[2] === "--platform" ? process.argv[3] : "";
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const bundleRoot = path.resolve("src-tauri", "target", "release", "bundle");
const failures = [];

function filesIn(relativePath, pattern) {
  const directory = path.join(bundleRoot, relativePath);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => pattern.test(name))
    .map((name) => path.join(directory, name));
}

if (platform !== "windows") failures.push("当前脚本只支持 --platform windows");
const nsis = filesIn("nsis", /\.exe$/i).filter((file) => path.basename(file).includes(version));
const msi = filesIn("msi", /\.msi$/i).filter((file) => path.basename(file).includes(version));
if (nsis.length < 1) failures.push(`未找到版本 ${version} 的 NSIS 安装包`);
if (msi.length < 2) failures.push(`未找到版本 ${version} 的两个 MSI 语言包`);
for (const file of [...nsis, ...msi]) {
  if (fs.statSync(file).size <= 0) failures.push(`安装包为空：${file}`);
}

if (failures.length) {
  console.error("Bundle artifact checks failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Bundle artifact checks passed: ${nsis.length} NSIS, ${msi.length} MSI for v${version}`);
}
