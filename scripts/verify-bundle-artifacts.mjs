import fs from "node:fs";
import path from "node:path";

const platform = process.argv[2] === "--platform" ? process.argv[3] : "";
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const targetRoot = path.resolve("src-tauri", "target");
const bundleRoots = [path.join(targetRoot, "release", "bundle")];
if (fs.existsSync(targetRoot)) {
  for (const entry of fs.readdirSync(targetRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== "release" && entry.name !== "debug") {
      bundleRoots.push(path.join(targetRoot, entry.name, "release", "bundle"));
    }
  }
}
const failures = [];

function filesIn(relativePath, pattern) {
  return bundleRoots.flatMap((bundleRoot) => {
    const directory = path.join(bundleRoot, relativePath);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
      .filter((name) => pattern.test(name))
      .map((name) => path.join(directory, name));
  });
}

if (platform !== "windows") failures.push("当前脚本只支持 --platform windows");
// WiX（MSI）打包在 CI 上因 WixTools314 light.exe 无法运行已停用（v0.1.87 起 Windows 仅产出 NSIS），审计只校验 NSIS。
const nsis = filesIn("nsis", /\.exe$/i).filter((file) => path.basename(file).includes(version));
if (nsis.length < 1) failures.push(`未找到版本 ${version} 的 NSIS 安装包`);
for (const file of nsis) {
  if (fs.statSync(file).size <= 0) failures.push(`安装包为空：${file}`);
}

if (failures.length) {
  console.error("Bundle artifact checks failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Bundle artifact checks passed: ${nsis.length} NSIS for v${version}`);
}
