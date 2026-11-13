import { randomBytes } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";

const [tag, assetsDirectory] = process.argv.slice(2);
const token = process.env.GITEE_TOKEN;
const owner = process.env.GITEE_OWNER || "cloudhub-tools";
const repository = process.env.GITEE_REPOSITORY || "cloudhub-tools";

if (!tag || !/^v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(tag)) {
  throw new Error("Usage: node scripts/sync-gitee-release.mjs <version-tag> <assets-directory>");
}
if (!assetsDirectory || !fs.existsSync(assetsDirectory)) {
  throw new Error("Release assets directory does not exist.");
}
if (!token) throw new Error("GITEE_TOKEN is required.");

const files = fs.readdirSync(assetsDirectory)
  .map((name) => path.join(assetsDirectory, name))
  .filter((file) => fs.statSync(file).isFile())
  .sort((left, right) => fs.statSync(left).size - fs.statSync(right).size);
if (files.length === 0) throw new Error("No release assets were downloaded.");

const api = `https://gitee.com/api/v5/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
const headers = { Authorization: `token ${token}` };

async function request(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
  } catch {
    throw new Error("Gitee API request failed due to a network error.");
  }
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Gitee API request failed (${response.status}).`);
  }
  try {
    return body ? JSON.parse(body) : null;
  } catch {
    throw new Error(`Gitee API returned an invalid response (${response.status}).`);
  }
}

let release;
let lookup;
try {
  lookup = await fetch(`${api}/releases/tags/${encodeURIComponent(tag)}`, { headers });
} catch {
  throw new Error("Gitee API request failed due to a network error.");
}
if (lookup.ok) {
  try {
    release = await lookup.json();
  } catch {
    throw new Error(`Gitee API returned an invalid response (${lookup.status}).`);
  }
}
if (lookup.status === 404 || (lookup.ok && release === null)) {
  let source;
  try {
    source = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`, {
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
    });
  } catch {
    throw new Error("GitHub API request failed due to a network error.");
  }
  if (!source.ok) throw new Error(`Could not read GitHub release (${source.status}).`);
  let githubRelease;
  try {
    githubRelease = await source.json();
  } catch {
    throw new Error(`GitHub API returned an invalid response (${source.status}).`);
  }
  const payload = {
    tag_name: tag,
    name: githubRelease.name || tag,
    body: githubRelease.body || "",
    prerelease: String(githubRelease.prerelease),
    target_commitish: "main",
  };
  release = await request(`${api}/releases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  // Gitee may create the release but return an empty response body. Resolve the
  // resource by tag before declaring failure or attempting attachment uploads.
  if (!release?.id) {
    let createdRelease;
    try {
      createdRelease = await fetch(`${api}/releases/tags/${encodeURIComponent(tag)}`, { headers });
    } catch {
      throw new Error("Gitee release was created, but could not be verified due to a network error.");
    }
    if (!createdRelease.ok) throw new Error(`Gitee release ${tag} was created but could not be verified (${createdRelease.status}).`);
    try {
      release = await createdRelease.json();
    } catch {
      throw new Error(`Gitee release ${tag} was created but its lookup response was invalid.`);
    }
  }
} else {
  if (!lookup.ok) throw new Error(`Could not find Gitee release (${lookup.status}).`);
}
if (!release || !release.id) {
  throw new Error(`Gitee release ${tag} was not returned by the API.`);
}

const attachmentsUrl = `${api}/releases/${release.id}/attach_files`;
const existing = await request(`${attachmentsUrl}?page=1&per_page=100`);

// fetch() applies undici's default 300s headers timeout, which aborts large
// attachment uploads to Gitee midway. Stream the multipart body over
// node:https instead and allow a much longer upload window.
const uploadTimeoutMs = 30 * 60 * 1000;
function uploadAttachment(file, filename) {
  const endpoint = new URL(attachmentsUrl);
  const boundary = `----cloudhub-release-${randomBytes(12).toString("hex")}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="access_token"\r\n\r\n` +
      `${token}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const size = fs.statSync(file).size;
  return new Promise((resolve, reject) => {
    const upload = https.request(
      {
        method: "POST",
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port || undefined,
        path: `${endpoint.pathname}${endpoint.search}`,
        headers: {
          Authorization: `token ${token}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": head.length + size + tail.length,
          "User-Agent": "cloudhub-tools-release-sync",
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`Gitee attachment upload failed (${response.statusCode}).`));
            return;
          }
          resolve(body);
        });
      },
    );
    upload.setTimeout(uploadTimeoutMs, () => {
      upload.destroy(new Error("Gitee attachment upload timed out."));
    });
    upload.on("error", reject);
    upload.write(head);
    const stream = fs.createReadStream(file);
    stream.on("error", (error) => {
      upload.destroy(error);
    });
    stream.on("end", () => {
      upload.end(tail);
    });
    stream.pipe(upload, { end: false });
  });
}

for (const file of files) {
  const filename = path.basename(file);
  for (const attachment of existing.filter((item) => item.name === filename)) {
    await request(`${attachmentsUrl}/${attachment.id}`, { method: "DELETE" });
  }
  await uploadAttachment(file, filename);
  console.log(`Mirrored ${filename}`);
}

console.log(`Gitee release ${tag} synchronized (${files.length} attachments).`);
