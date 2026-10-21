'use strict';
// Odoo To Figma – local render server.
//   POST /capture {url, viewport, theme}   → NDJSON stream of progress + result (plugin "Import")
//   POST /session/*                        → browser session driven by Claude (MCP)
//   POST /session/export, /figma/import-*  → captures queued for the Figma plugin
//   GET  /figma/events                     → Server-Sent Events listened to by the plugin

const http = require('http');
const { capture, captureHtml, getBrowser, closeBrowser, findChrome } = require('./capture');
const session = require('./session');
const jobs = require('./jobs');
const pkg = require('../package.json');

const PORT = parseInt(process.env.PORT || '3999', 10);
const HOST = process.env.HOST || '127.0.0.1';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 25e6) reject(new Error('Body too large')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function handle(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const path = req.url.split('?')[0];

  if (req.method === 'GET' && (path === '/health' || path === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, name: 'Odoo To Figma', version: pkg.version, chrome: !!findChrome() }));
  }

  if (req.method === 'POST' && path === '/capture') {
    let body;
    try { body = await readBody(req); } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', message: 'Invalid request.' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
    const send = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch (e) { /* client gone */ } };
    const started = Date.now();
    console.log(`→ capture ${body.url} [${typeof body.viewport === 'object' ? body.viewport.width : body.viewport || 'desktop'}]`);
    try {
      const result = await capture(body, (message, pct) => send({ type: 'progress', message, pct }));
      send({ type: 'result', data: result });
      const s = result.meta.stats;
      console.log(`✓ ${result.meta.title || body.url} – ${s.frames} frames, ${s.texts} textes, ${Object.keys(result.images).length} images (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    } catch (e) {
      console.error('✗', e && e.stack ? e.stack : e);
      send({ type: 'error', message: e && e.message ? e.message : String(e) });
    }
    return res.end();
  }

  // ----- Claude (MCP) -------------------------------------------------------
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const SESSION = {
    '/session/open': 'open', '/session/describe': 'describe', '/session/click': 'click', '/session/hover': 'hover', '/session/type': 'type',
    '/session/key': 'key', '/session/back': 'back', '/session/scroll': 'scroll', '/session/close': 'close',
  };
  if (req.method === 'POST' && SESSION[path]) {
    try { return json(200, await session.actions[SESSION[path]](await readBody(req))); } catch (e) { return json(500, { error: e.message || String(e) }); }
  }
  if (req.method === 'POST' && (path === '/session/export' || path === '/figma/import-url' || path === '/figma/import-html')) {
    try {
      const body = await readBody(req);
      const captures = [];
      if (path === '/session/export') captures.push(await session.actions.capture(body));
      else if (path === '/figma/import-html') captures.push(await captureHtml(body));
      else {
        const vps = Array.isArray(body.viewports) && body.viewports.length ? body.viewports : [body.viewport || 'desktop'];
        for (const vp of vps) captures.push(await capture({ ...body, viewport: vp }));
      }
      console.log(`→ Claude : ${captures.length} export(s) vers Figma (${captures.map((c) => c.meta.name || c.meta.title).join(', ')})`);
      const queued = captures.map((c) => jobs.add(c, { name: body.name ? (captures.length > 1 ? `${body.name} — ${c.meta.viewport.label}` : body.name) : null, autoLayout: body.autoLayout }));
      const waitMs = Math.max(0, Math.min(170, body.wait == null ? 120 : body.wait)) * 1000;
      const t0 = Date.now();
      for (const j of queued) await jobs.wait(j, Math.max(0, waitMs - (Date.now() - t0)));
      return json(200, {
        plugin: jobs.status().pluginConnected,
        jobs: queued.map((j) => ({ id: j.id, name: j.name, status: j.status, result: j.result })),
      });
    } catch (e) {
      console.error('✗', e && e.stack ? e.stack : e);
      return json(500, { error: e.message || String(e) });
    }
  }
  if (req.method === 'GET' && path === '/figma/events') return jobs.subscribe(req, res);
  if (req.method === 'GET' && path === '/figma/status') return json(200, jobs.status());
  let m;
  if (req.method === 'GET' && (m = /^\/figma\/jobs\/([\w-]+)$/.exec(path))) {
    const job = jobs.fetchJob(m[1]);
    return job ? json(200, job) : json(404, { error: 'Unknown or already imported export.' });
  }
  if (req.method === 'POST' && (m = /^\/figma\/jobs\/([\w-]+)\/result$/.exec(path))) {
    return json(jobs.complete(m[1], await readBody(req)) ? 200 : 404, { ok: true });
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

/** Start the render server. Resolves once it listens; `close()` stops it and Chrome. */
function start({ port = PORT, host = HOST } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handle);
    server.requestTimeout = 0; // exports wait for the Figma plugin
    server.headersTimeout = 60000;
    server.once('error', reject);
    server.listen(port, host, () => {
      console.log(`Odoo To Figma – server ready on http://localhost:${port}`);
      if (!findChrome()) console.warn('⚠ Google Chrome not found: set CHROME_PATH.');
      getBrowser().catch((e) => console.error('Chrome :', e.message));
      resolve({
        close: () => new Promise((done) => {
          server.close(() => done());
          server.closeAllConnections && server.closeAllConnections();
        }).then(() => Promise.all([closeBrowser(), session.close()])),
      });
    });
  });
}

module.exports = { start, PORT };

if (require.main === module) {
  start().catch((e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use: the server is probably already running.` : e);
    process.exit(1);
  });
  process.on('SIGINT', async () => {
    await Promise.all([closeBrowser(), session.close()]);
    process.exit(0);
  });
}
