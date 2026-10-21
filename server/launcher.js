'use strict';
// Odoo To Figma – launcher.
// A tiny always-on service (installed once as a macOS LaunchAgent by
// `npm run install-launcher`) that starts and stops the render server when
// the plugin asks for it. A Figma plugin cannot run commands by itself.
//
//   GET  /health → { ok, launcher: true, running }
//   POST /start  → starts the render server (same as `npm start`)
//   POST /stop   → stops it (and Chrome)
//   GET  /update → { ok, behind }: commits the git clone is behind GitHub
//   POST /update → git pull + npm install, refreshes this copy, then restarts

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const renderServer = require('./index');

const PORT = parseInt(process.env.LAUNCHER_PORT || '3998', 10);
const HOST = process.env.HOST || '127.0.0.1';

let running = null; // { close() }
let pending = null; // Promise while starting / stopping
let lastError = null;

// The git clone this copy was installed from (set by install-launcher).
const REPO = process.env.REPO_DIR;
const APP = path.resolve(__dirname, '..');

function run(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: REPO, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (e, stdout, stderr) => {
      if (e) reject(new Error(String(stderr || e.message).trim()));
      else resolve(String(stdout).trim());
    });
  });
}

async function behindCount() {
  if (!REPO) return 0;
  await run('git', ['fetch', '--quiet'], 15000);
  return parseInt(await run('git', ['rev-list', '--count', 'HEAD..@{u}'], 5000), 10) || 0;
}

async function update() {
  await run('git', ['pull', '--ff-only', '--quiet'], 60000);
  await run(path.join(path.dirname(process.execPath), 'npm'), ['install', '--no-audit', '--no-fund', '--loglevel=error'], 300000);
  if (path.resolve(REPO) === APP) return; // running straight from the clone
  // Swap in a fresh copy of the server; launchd restarts us on it (KeepAlive).
  const next = APP + '.new';
  fs.rmSync(next, { recursive: true, force: true });
  for (const item of ['server', 'node_modules', 'package.json']) {
    fs.cpSync(path.join(REPO, item), path.join(next, item), { recursive: true });
  }
  fs.rmSync(APP, { recursive: true, force: true });
  fs.renameSync(next, APP);
}

function serverAnswers() {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port: renderServer.PORT, path: '/health', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function startRender() {
  if (running) return;
  if (await serverAnswers()) return; // already started elsewhere (e.g. `npm start`)
  running = await renderServer.start();
  lastError = null;
}

async function stopRender() {
  if (!running) return;
  const r = running;
  running = null;
  await r.close();
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const path = req.url.split('?')[0];

  if (req.method === 'GET' && (path === '/health' || path === '/')) {
    return json(res, 200, { ok: true, launcher: true, running: !!running || (await serverAnswers()), error: lastError });
  }
  if (req.method === 'POST' && (path === '/start' || path === '/stop')) {
    const action = path === '/start' ? startRender : stopRender;
    try {
      while (pending) await pending.catch(() => {});
      pending = action();
      await pending;
      return json(res, 200, { ok: true, running: !!running || (await serverAnswers()) });
    } catch (e) {
      lastError = e.code === 'EADDRINUSE' ? `Port ${renderServer.PORT} is used by another program.` : e.message || String(e);
      console.error('✗', lastError);
      return json(res, 500, { ok: false, error: lastError });
    } finally {
      pending = null;
    }
  }
  if (req.method === 'GET' && path === '/update') {
    try {
      return json(res, 200, { ok: true, behind: await behindCount() });
    } catch (e) {
      return json(res, 200, { ok: false, behind: 0, error: e.message });
    }
  }
  if (req.method === 'POST' && path === '/update') {
    try {
      await update();
      json(res, 200, { ok: true });
      setTimeout(shutdown, 300);
    } catch (e) {
      console.error('✗ update:', e.message);
      json(res, 500, { ok: false, error: e.message });
    }
    return;
  }
  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, HOST, () => console.log(`Odoo To Figma – launcher ready on http://localhost:${PORT}`));
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use: the launcher is probably already running.` : e);
  process.exit(1);
});

async function shutdown() {
  await stopRender().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
