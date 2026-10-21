import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startBridge } from '../dist/bridge/server.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'e2e-token-0123456789abcdef0123456789abcd';
const EXPECTED_EXTENSION_ID = 'hlonkofbjdmaokhcnpeibplakhngfoao';
const artifacts = '/opt/cursor/artifacts';

const home = await mkdtemp(join(tmpdir(), 'agent-hand-e2e-'));
const userData = join(home, 'chrome');
const ext = join(root, 'extension', 'dist');
const devConfig = join(ext, 'dev-config.json');
let chrome;
let server;
let ffmpeg;

try {
  server = await startBridge({
    port: 0,
    token: TOKEN,
    demoDir: join(root, 'demo'),
    screenshotDir: join(home, 'shots'),
  });
  await writeFile(devConfig, JSON.stringify({ port: server.port, token: TOKEN }));
  await mkdir(userData, { recursive: true });
  const executablePath = chromium.executablePath();
  const demoUrl = `http://127.0.0.1:${server.port}/demo`;
  chrome = spawn(executablePath, [
    `--user-data-dir=${userData}`,
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-popup-blocking',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--window-size=1200,900',
    '--window-position=40,40',
    demoUrl,
  ], {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':1' },
  });
  let chromeLog = '';
  chrome.stderr.on('data', (chunk) => {
    chromeLog += chunk.toString();
    if (chromeLog.length > 20000) chromeLog = chromeLog.slice(-20000);
  });

  const health = await waitForExtension(server.port);
  if (health.extensionId !== EXPECTED_EXTENSION_ID) {
    throw new Error(`extension id ${health.extensionId} !== ${EXPECTED_EXTENSION_ID}`);
  }

  const snap = await server.call('navigate', { url: demoUrl }).then(() => server.call('snapshot'));
  const tick = mustRef(snap, 'Count trusted clicks');
  const name = mustRef(snap, 'Your name');
  const iframe = mustRef(snap, 'Iframe button');
  assert(snap.devicePixelRatio > 0, 'snapshot reports devicePixelRatio');
  assert(snap.text.includes('viewport'), snap.text);

  ffmpeg = startGrab(join(home, 'desktop.mp4'));
  await sleep(300);
  const clicked = await server.call('click', { ref: tick, duration: 1700, trace: true }, 30000);
  await sleep(400);
  await stopGrab(ffmpeg);
  ffmpeg = undefined;

  const afterClick = await server.call('get_text', { max: 8000 });
  assert(afterClick.text.includes('Trusted clicks: 1'), afterClick.text);
  assert(!afterClick.text.includes('Untrusted click ignored'), afterClick.text);

  await server.call('type', { ref: name, text: 'Ada Lovelace', submit: true });
  const afterType = await server.call('get_text', { max: 8000 });
  assert(afterType.text.includes('Hello, Ada Lovelace (trusted submit)'), afterType.text);

  await server.call('click', { ref: iframe, duration: 400 });
  const afterFrame = await server.call('get_text', { max: 8000 });
  assert(afterFrame.text.includes('Iframe trusted clicks: 1'), afterFrame.text);

  let buried;
  let buriedSnap;
  for (let attempt = 0; attempt < 5 && !buried; attempt += 1) {
    buriedSnap = await server.call('snapshot');
    buried = buriedSnap.items.find((item) => item.name === 'Buried button');
    if (!buried) await server.call('scroll', { direction: 'down', amount: 800 });
  }
  if (!buried) throw new Error(`buried button never appeared\n${buriedSnap?.text ?? ''}`);
  await server.call('click', { ref: buried.ref, duration: 400 });
  const afterBuried = await server.call('get_text', { max: 8000 });
  assert(afterBuried.text.includes('Buried trusted clicks: 1'), afterBuried.text);

  const shot = await server.call('screenshot');
  const png = await readFile(shot.path);
  assert(png[0] === 137 && png[1] === 80, 'screenshot is a png');
  const ratio = shot.width / shot.cssWidth;
  if (Math.abs(ratio - shot.devicePixelRatio) > 0.35) {
    throw new Error(`screenshot scale ${ratio} is far from dpr ${shot.devicePixelRatio} (${shot.width}x${shot.height} css ${shot.cssWidth}x${shot.cssHeight})`);
  }

  const cli = await run(process.execPath, [join(root, 'dist', 'bridge', 'index.js'), 'text', '--max', '2000'], {
    env: {
      ...process.env,
      AGENT_HAND_HOME: home,
      AGENT_HAND_TOKEN: TOKEN,
      AGENT_HAND_PORT: String(server.port),
    },
  });
  if (cli.code !== 0) throw new Error(cli.stderr || cli.stdout || 'cli failed');
  const cliText = JSON.parse(cli.stdout);
  assert(cliText.text.includes('Trusted clicks: 1'), cliText.text);

  await mkdir(artifacts, { recursive: true });
  const frames = Array.isArray(clicked.frames) ? clicked.frames : [];
  if (frames.length === 0) throw new Error(`trusted click worked but no cursor frames were captured\n${chromeLog}`);
  const mid = frames[Math.min(1, frames.length - 1)];
  const midPath = join(artifacts, 'cursor_mid_click.jpg');
  await writeFile(midPath, Buffer.from(mid, 'base64'));
  const frameDir = join(home, 'frames');
  await mkdir(frameDir, { recursive: true });
  for (let index = 0; index < frames.length; index += 1) {
    await writeFile(join(frameDir, `frame-${String(index).padStart(2, '0')}.jpg`), Buffer.from(frames[index], 'base64'));
  }
  const gif = spawnSync('ffmpeg', [
    '-y',
    '-framerate', '4',
    '-i', join(frameDir, 'frame-%02d.jpg'),
    '-vf', 'scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse',
    join(artifacts, 'cursor_click.gif'),
  ], { encoding: 'utf8' });
  if (gif.status !== 0) throw new Error(gif.stderr || 'ffmpeg gif failed');
  await writeFile(join(artifacts, 'cursor_after_click.png'), png);
  const desktop = join(home, 'desktop.mp4');
  try {
    await readFile(desktop);
    const copy = spawnSync('ffmpeg', ['-y', '-i', desktop, '-movflags', '+faststart', join(artifacts, 'cursor_desktop.mp4')], { encoding: 'utf8' });
    if (copy.status !== 0) console.error(copy.stderr);
  } catch {
    console.error('desktop recording was not produced');
  }
  console.log(JSON.stringify({
    extensionId: health.extensionId,
    click: { x: clicked.x, y: clicked.y, dpr: clicked.devicePixelRatio },
    frames: frames.length,
    screenshot: shot,
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
} finally {
  await stopGrab(ffmpeg);
  if (chrome?.pid) {
    try { process.kill(-chrome.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  spawnSync('pkill', ['-f', userData]);
  await rm(devConfig, { force: true });
  if (server) await server.close();
  await rm(home, { recursive: true, force: true });
}

function mustRef(snapshot, name) {
  const item = snapshot.items.find((entry) => entry.name === name);
  if (!item) throw new Error(`missing ref ${name}\n${snapshot.text}`);
  return item.ref;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForExtension(port) {
  const started = Date.now();
  let last = '';
  let stable = 0;
  let seen;
  while (Date.now() - started < 25000) {
    try {
      const body = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      last = JSON.stringify(body);
      if (body.extension) {
        stable += 1;
        seen = body;
        if (stable >= 3) return seen;
      } else {
        stable = 0;
      }
    } catch (error) {
      stable = 0;
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(200);
  }
  throw new Error(`extension did not connect (${last})`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function startGrab(path) {
  if (!process.env.DISPLAY) return undefined;
  const size = spawnSync('xdpyinfo', [], { encoding: 'utf8' });
  const match = size.stdout.match(/dimensions:\s+(\d+x\d+)/);
  const videoSize = match?.[1] ?? '1280x800';
  const child = spawn('ffmpeg', [
    '-y',
    '-f', 'x11grab',
    '-video_size', videoSize,
    '-framerate', '10',
    '-i', process.env.DISPLAY,
    '-t', '8',
    path,
  ], { stdio: 'ignore' });
  return child;
}

async function stopGrab(child) {
  if (!child || child.killed) return;
  child.kill('SIGINT');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(2000),
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
}
