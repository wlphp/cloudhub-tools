import { createHash } from "node:crypto";

const [tag] = process.argv.slice(2);
const token = process.env.GITEE_TOKEN;
const githubToken = process.env.GITHUB_TOKEN;
const githubRepository = process.env.GITHUB_REPOSITORY;
const owner = process.env.GITEE_OWNER || "cloudhub-tools";
const repository = process.env.GITEE_REPOSITORY || "cloudhub-tools";

if (!tag || !/^v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(tag)) {
  throw new Error("Usage: node scripts/verify-gitee-release.mjs <version-tag>");
}
if (!token) throw new Error("GITEE_TOKEN is required.");
if (!githubRepository) throw new Error("GITHUB_REPOSITORY is required.");

const giteeApi = `https://gitee.com/api/v5/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;

async function giteeRelease() {
  let response;
  try {
    response = await fetch(`${giteeApi}/releases/tags/${encodeURIComponent(tag)}`, {
      headers: { Authorization: `token ${token}` },
    });
  } catch {
    throw new Error("Gitee API request failed due to a network error.");
  }
  if (!response.ok) throw new Error(`Gitee release lookup failed (${response.status}).`);
  return response.json();
}

async function githubRelease() {
  const headers = { Accept: "application/vnd.github+json" };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
  let response;
  try {
    response = await fetch(`https://api.github.com/repos/${githubRepository}/releases/tags/${encodeURIComponent(tag)}`, { headers });
  } catch {
    throw new Error("GitHub API request failed due to a network error.");
  }
  if (!response.ok) throw new Error(`GitHub release lookup failed (${response.status}).`);
  return response.json();
}

async function digest(url) {
  let response;
  try {
    response = await fetch(url, { redirect: "follow" });
  } catch {
    return { error: "network error" };
  }
  if (!response.ok) return { error: `download failed (${response.status})` };
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

const [github, gitee] = await Promise.all([githubRelease(), giteeRelease()]);
const expected = github.assets || [];
const mirrored = new Map((gitee.assets || []).map((asset) => [asset.name, asset]));
const missing = expected.map((asset) => asset.name).filter((name) => !mirrored.has(name));

if (expected.length === 0) throw new Error(`GitHub release ${tag} has no assets to verify.`);
console.log(`GitHub assets: ${expected.length}; Gitee assets: ${mirrored.size}`);
if (missing.length) console.log(`Missing on Gitee: ${missing.join(", ")}`);

let failures = missing.length;
for (const asset of expected) {
  const mirror = mirrored.get(asset.name);
  if (!mirror) continue;
  const result = await digest(mirror.browser_download_url);
  if (result.error) {
    console.log(`${asset.name} | ${result.error}`);
    failures += 1;
    continue;
  }
  const expectedDigest = String(asset.digest || "").replace(/^sha256:/, "");
  const sizeOk = result.bytes === asset.size;
  const digestOk = expectedDigest ? result.sha256 === expectedDigest : null;
  console.log(`${asset.name} | bytes=${result.bytes}/${asset.size} sizeOk=${sizeOk} sha256Ok=${digestOk === null ? "n/a" : digestOk}`);
  if (!sizeOk || digestOk === false) failures += 1;
  if (digestOk === false) console.log(`  gitee=${result.sha256} github=${expectedDigest}`);
}

console.log(failures === 0 ? "VERIFY_OK" : `VERIFY_FAILED (${failures})`);
if (failures > 0) process.exitCode = 1;
