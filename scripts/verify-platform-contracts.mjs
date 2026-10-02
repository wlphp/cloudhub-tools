import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function filesUnder(directory, extension) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(target, extension));
    else if (entry.name.endsWith(extension)) files.push(target);
  }
  return files;
}

async function joinedSource(files) {
  return (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
}

function declaresHttpRoute(source, method, routePath) {
  const needle = `"${routePath}"`;
  let index = source.indexOf(needle);
  while (index >= 0) {
    const context = source.slice(Math.max(0, index - 180), index + needle.length + 180);
    if (context.includes(`"${method}"`)) return true;
    index = source.indexOf(needle, index + needle.length);
  }
  return false;
}

const contract = JSON.parse(await readFile(path.join(root, "contracts/platform-clients.json"), "utf8"));
assert.equal(contract.version, 1);
assert.deepEqual(contract.domains.map((domain) => domain.name), ["accounts", "resources", "servers", "logs", "preferences", "domains", "certificates", "storage", "remote", "app"]);

const clientSource = await joinedSource(await filesUnder(path.join(root, "src/platform/clients"), ".ts"));
const rustSource = await joinedSource(await filesUnder(path.join(root, "src-tauri/src"), ".rs"));
const rustLibSource = await readFile(path.join(root, "src-tauri/src/lib.rs"), "utf8");
const desktopHandlerMatch = rustLibSource.match(/#\[cfg\(desktop\)\]\s*let builder = builder\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/);
const mobileHandlerMatch = rustLibSource.match(/#\[cfg\(mobile\)\]\s*let builder = builder\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/);
assert.ok(desktopHandlerMatch, "未找到桌面 Tauri 命令注册表");
assert.ok(mobileHandlerMatch, "未找到移动端 Tauri 命令注册表");
const handlerSource = desktopHandlerMatch[1];
const mobileHandlerCommands = mobileHandlerMatch[1].split(",").map((command) => command.trim()).filter(Boolean).sort();
const expectedMobileCommands = [...contract.mobileCommands].sort();
assert.equal(new Set(expectedMobileCommands).size, expectedMobileCommands.length, "mobileCommands 中存在重复项");
assert.deepEqual(mobileHandlerCommands, expectedMobileCommands, "手机命令注册必须严格匹配移动端白名单");
const nodeSource = [
  await readFile(path.join(root, "web-api.mjs"), "utf8"),
  await joinedSource(await filesUnder(path.join(root, "web-api"), ".mjs")),
].join("\n");
const componentFiles = [
  path.join(root, "src/App.tsx"),
  ...await filesUnder(path.join(root, "src/features/domains"), ".tsx"),
  ...await filesUnder(path.join(root, "src/features/storage"), ".tsx"),
  ...await filesUnder(path.join(root, "src/features/resources"), ".tsx"),
  ...await filesUnder(path.join(root, "src/features/servers"), ".tsx"),
  ...await filesUnder(path.join(root, "src/features/certificates"), ".tsx"),
];
const componentSource = await joinedSource(componentFiles);

const operationNames = new Set();
const commands = new Set();
const previewPaths = new Set();
for (const domain of contract.domains) {
  assert.ok(domain.operations.length > 0, `${domain.name} 没有契约操作`);
  for (const operation of domain.operations) {
    const operationKey = `${domain.name}:${operation.name}`;
    assert.equal(operationNames.has(operationKey), false, `重复操作 ${operationKey}`);
    operationNames.add(operationKey);
    for (const command of operation.native) {
      commands.add(command);
      assert.ok(clientSource.includes(`"${command}"`), `client 未声明 Tauri 命令 ${command}`);
      assert.ok(rustSource.includes(command), `Rust 未实现或注册 Tauri 命令 ${command}`);
      assert.ok(handlerSource.includes(command), `Tauri generate_handler! 未注册命令 ${command}`);
    }
    for (const preview of operation.preview) {
      assert.match(preview.method, /^(GET|POST|PUT|PATCH|DELETE)$/);
      assert.match(preview.path, /^\/api\/[a-z0-9-]+$/);
      previewPaths.add(preview.path);
      assert.ok(clientSource.includes(`"${preview.path}"`), `client 未声明 Web 路径 ${preview.path}`);
      assert.ok(nodeSource.includes(`"${preview.path}"`), `Node 未实现 Web 路径 ${preview.path}`);
      assert.ok(declaresHttpRoute(nodeSource, preview.method, preview.path), `Node 路由 ${preview.path} 未声明 ${preview.method} 方法`);
    }
  }
}

for (const command of commands) {
  assert.equal(componentSource.includes(`"${command}"`), false, `组件不得直接引用 Tauri 命令 ${command}`);
}
for (const command of expectedMobileCommands) {
  assert.ok(clientSource.includes(`"${command}"`), `mobileCommands 中的 ${command} 未由客户端声明`);
  assert.ok(rustSource.includes(command), `mobileCommands 中的 ${command} 未在 Rust 中实现`);
}
for (const previewPath of previewPaths) {
  assert.equal(componentSource.includes(previewPath), false, `组件不得直接引用 Web 路径 ${previewPath}`);
}

console.log(`Platform contract checks passed: ${contract.domains.length} domains, ${operationNames.size} operations, ${commands.size} desktop commands, ${expectedMobileCommands.length} mobile commands, ${previewPaths.size} preview paths`);
