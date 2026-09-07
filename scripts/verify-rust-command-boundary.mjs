import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const sourceRoot = join(process.cwd(), "src-tauri", "src");
const rustFiles = readdirSync(sourceRoot, { recursive: true })
  .filter((entry) => entry.endsWith(".rs"))
  .map((entry) => join(sourceRoot, entry));
const violations = [];
let commandCount = 0;

for (const file of rustFiles) {
  const source = readFileSync(file, "utf8");
  const relativePath = relative(sourceRoot, file).replaceAll("\\", "/");
  const attributes = [...source.matchAll(/#\[tauri::command(?:[^\]]*)\]/g)];
  if (attributes.length === 0) continue;
  commandCount += attributes.length;
  if (!relativePath.startsWith("commands/")) {
    violations.push(`${relativePath}: Tauri command must live under commands/`);
  }
  for (const attribute of attributes) {
    const declaration = source.slice(attribute.index + attribute[0].length, attribute.index + attribute[0].length + 1000);
    if (!/(?:pub(?:\(crate\))?\s+)?(?:async\s+)?fn\s+\w+\s*\([^]*?\)\s*->\s*PlatformResult\s*</s.test(declaration)) {
      violations.push(`${relativePath}: command must return PlatformResult<T>`);
    }
  }
}

if (violations.length > 0) {
  console.error("Rust command boundary checks failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`Rust command boundary checks passed: ${commandCount} commands`);
}
