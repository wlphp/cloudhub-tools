// Developer-only probe. Uses synthetic profiles and a local page; never opens a
// user's profile. A verified executable hash is mandatory before execution.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';

const usage = 'node scripts/verify-browser-fingerprint.mjs --executable <absolute path> --sha256 <exe hash> [--test-no-sandbox] [--real-gpu] [--canvas-real] [--cores <1..64>] [--memory <2|4|8|16|32>]';
const args = process.argv.slice(2);
let executable, expectedHash, noSandbox = false;
let realGpu = false, canvasReal = false, cores, memory;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--executable' && !executable) executable = args[++i];
  else if (args[i] === '--sha256' && !expectedHash) expectedHash = args[++i];
  else if (args[i] === '--test-no-sandbox' && !noSandbox) noSandbox = true;
  else if (args[i] === '--real-gpu' && !realGpu) realGpu = true;
  else if (args[i] === '--canvas-real' && !canvasReal) canvasReal = true;
  else if (args[i] === '--cores' && cores === undefined) cores = Number(args[++i]);
  else if (args[i] === '--memory' && memory === undefined) memory = Number(args[++i]);
  else { console.error(usage); process.exit(2); }
}
if (!executable || !isAbsolute(executable) || !/^[a-f0-9]{64}$/i.test(expectedHash ?? '')
  || cores !== undefined && (!Number.isInteger(cores) || cores < 1 || cores > 64)
  || memory !== undefined && ![2,4,8,16,32].includes(memory)) {
  console.error(usage); process.exit(2);
}
executable = await realpath(executable);
const hash = createHash('sha256');
for await (const chunk of createReadStream(executable)) hash.update(chunk);
if (hash.digest('hex') !== expectedHash.toLowerCase()) {
  console.error('Executable SHA-256 mismatch; browser was not started.'); process.exit(2);
}

// This exact function also runs in a same-origin frame and a dedicated worker.
async function sample() {
  const canvas = typeof document === 'undefined' ? new OffscreenCanvas(240, 80) : document.createElement('canvas');
  canvas.width = 240; canvas.height = 80;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#159'; ctx.fillRect(0, 0, 240, 80);
  ctx.font = '18px Arial'; ctx.fillStyle = '#e63'; ctx.fillText('CloudHub sample Ω 0123', 7, 35);
  ctx.globalCompositeOperation = 'multiply'; ctx.fillRect(41, 19, 70, 24);
  const digest = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  const first = await digest(ctx.getImageData(0, 0, 240, 80).data);
  const second = await digest(ctx.getImageData(0, 0, 240, 80).data);
  const glCanvas = typeof document === 'undefined' ? new OffscreenCanvas(16, 16) : document.createElement('canvas');
  glCanvas.width = 16; glCanvas.height = 16;
  const gl = glCanvas.getContext('webgl');
  let webgl = null;
  if (gl) {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    gl.clearColor(0.123, 0.456, 0.789, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const pixels = new Uint8Array(16 * 16 * 4); gl.readPixels(0, 0, 16, 16, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    webgl = { vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE), pixels: await digest(pixels) };
  }
  const uaData = navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'platformVersion', 'fullVersionList']) : null;
  return { canvas: first, repeatedCanvasStable: first === second, webgl,
    language: navigator.language, languages: Array.from(navigator.languages),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    cores: navigator.hardwareConcurrency, memory: navigator.deviceMemory,
    ua: navigator.userAgent, platform: navigator.platform, uaData };
}

const workerSource = `(${sample.toString()})().then(value => postMessage({value}), () => postMessage({error:true}));`;
const server = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.url === '/worker.js') {
    response.setHeader('Content-Type', 'application/javascript'); response.end(workerSource);
  } else {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><title>Local fingerprint verification</title><body>CloudHub synthetic browser test</body>');
  }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
const root = await mkdtemp(join(tmpdir(), 'cloudhub-fingerprint-probe-'));
const fingerprintFlags = [realGpu && '--disable-gpu-fingerprint', canvasReal && '--disable-canvas-noise',
  cores !== undefined && `--fingerprint-hardware-concurrency=${cores}`, memory !== undefined && `--fingerprint-device-memory=${memory}`].filter(Boolean);
async function run(seed, profile) {
  const context = await chromium.launchPersistentContext(join(root, profile), {
    executablePath: executable, headless: true, chromiumSandbox: !noSandbox, timeout: 20000,
    args: [`--fingerprint=${seed}`, '--fingerprint-platform=windows', ...fingerprintFlags, '--no-proxy-server',
      '--disable-background-networking', '--disable-quic', '--dns-prefetch-disable',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(origin);
    const main = await page.evaluate(sample);
    const worker = await page.evaluate(() => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { worker.terminate(); reject(new Error('Worker sample timed out')); }, 10000);
      const worker = new Worker('/worker.js');
      worker.onmessage = event => { clearTimeout(timer); worker.terminate(); event.data.error ? reject(new Error('Worker sample failed')) : resolve(event.data.value); };
      worker.onerror = () => { clearTimeout(timer); worker.terminate(); reject(new Error('Worker sample failed')); };
    }));
    const frameElement = await page.evaluateHandle(() => {
      const frame = document.createElement('iframe'); frame.src = '/frame'; document.body.appendChild(frame); return frame;
    });
    const frame = await frameElement.asElement().contentFrame();
    await frame.waitForLoadState();
    const iframe = await frame.evaluate(sample);
    const extra = await page.evaluate(async () => {
      const audio = new OfflineAudioContext(1, 4096, 44100);
      const oscillator = audio.createOscillator(); oscillator.type = 'triangle'; oscillator.frequency.value = 10000;
      const compressor = audio.createDynamicsCompressor();
      oscillator.connect(compressor); compressor.connect(audio.destination); oscillator.start();
      const data = (await audio.startRendering()).getChannelData(0);
      const digest = await crypto.subtle.digest('SHA-256', data);
      const text = document.createElement('span'); text.textContent = 'CloudHub Ω 0123';
      text.style.cssText = 'position:absolute;font:18px Arial;left:0;top:0'; document.body.appendChild(text);
      const rect = text.getBoundingClientRect();
      const fonts = ['Arial', 'Calibri', 'Cambria', 'Consolas', 'Georgia', 'Times New Roman'].map(font => {
        const canvas = document.createElement('canvas').getContext('2d'); canvas.font = `18px "${font}"`; return [font, canvas.measureText('CloudHub Ω 0123').width];
      });
      return { audio: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join(''),
        rect: [rect.x, rect.y, rect.width, rect.height], fonts };
    });
    return { main, iframe, worker, ...extra };
  } finally { await context.close(); }
}
try {
  const first = await run('172904001', 'a');
  const restart = await run('172904001', 'a');
  const fresh = await run('172904001', 'same-seed-fresh-profile');
  const other = await run('172904099', 'b');
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const samples = [first, restart, fresh, other];
  const report = { executableSha256: expectedHash.toLowerCase(), testSandboxDisabled: noSandbox,
    fingerprintOptions: { realGpu, canvasReal, cores, memory },
    sameSeedRestartStable: same(first, restart),
    sameSeedFreshProfileStable: same(first, fresh),
    frameConsistent: samples.every(value => same(value.main, value.iframe)),
    workerConsistent: samples.every(value => same(value.main, value.worker)),
    repeatedCanvasStable: samples.every(value => value.main.repeatedCanvasStable),
    distinct: { canvas: first.main.canvas !== other.main.canvas, audio: first.audio !== other.audio,
      webgl: !same(first.main.webgl, other.main.webgl), fonts: !same(first.fonts, other.fonts),
      rect: !same(first.rect, other.rect), hardware: first.main.cores !== other.main.cores || first.main.memory !== other.main.memory },
    samples: { first, restart, fresh, other } };
  console.log(JSON.stringify(report, null, 2));
  if (!report.sameSeedRestartStable || !report.sameSeedFreshProfileStable || !report.frameConsistent || !report.workerConsistent || !report.repeatedCanvasStable) process.exitCode = 1;
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
