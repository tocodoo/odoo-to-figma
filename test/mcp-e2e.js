'use strict';
// End-to-end test of the MCP flow with a fake Figma plugin:
// Claude (MCP stdio) → open page → click → export the modal → plugin builds it.
// Usage: node test/mcp-e2e.js [url] [button text]

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 4999;
const SERVER = `http://127.0.0.1:${PORT}`;
const URL = process.argv[2] || 'https://getbootstrap.com/docs/5.3/components/modal/';
const BUTTON = new RegExp(process.argv[3] || 'Launch demo modal', 'i');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'o2f-'));

function log(...a) { console.log('·', ...a); }

// ----- render server on a test port ------------------------------------------
const server = spawn(process.execPath, [path.join(__dirname, '../server/index.js')], {
  env: { ...process.env, PORT: String(PORT), O2F_PROFILE: path.join(tmp, 'profile') }, stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write('  [server] ' + d));

// ----- fake Figma plugin: listens to SSE, builds jobs with the strict mock ---
let pluginResults = [];
async function fakePlugin() {
  const r = await fetch(SERVER + '/figma/events');
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /event: (\w+)/.exec(block), data = /data: (.*)/.exec(block);
      if (!ev || ev[1] !== 'job') continue;
      const { id, name } = JSON.parse(data[1]);
      const job = await (await fetch(`${SERVER}/figma/jobs/${id}`)).json();
      const file = path.join(tmp, id + '.json');
      if (job.name) job.capture.meta.name = job.name;
      fs.writeFileSync(file, JSON.stringify(job.capture));
      let out;
      try { out = execFileSync(process.execPath, [path.join(__dirname, 'run-plugin.js'), file, '--auto-layout'], { encoding: 'utf8' }); } catch (e) { out = e.stdout || ''; }
      const m = /"nodes": (\d+)/.exec(out), err = /"errors": (\d+)/.exec(out);
      const ok = !!m && err && err[1] === '0';
      pluginResults.push({ id, name, ok, nodes: m ? +m[1] : 0, root: job.capture.root, file });
      log(`plugin built "${name}": ${m ? m[1] : '?'} layers, ${err ? err[1] : '?'} error(s)`);
      await fetch(`${SERVER}/figma/jobs/${id}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok, nodes: m ? +m[1] : 0, autoLayouts: 1 }) });
    }
  }
}

// ----- MCP client over stdio ---------------------------------------------------
const mcp = spawn(process.execPath, [path.join(__dirname, '../server/mcp.js')], {
  env: { ...process.env, O2F_SERVER: SERVER, O2F_LAUNCHER: 'http://127.0.0.1:1' }, stdio: ['pipe', 'pipe', 'pipe'],
});
mcp.stderr.on('data', (d) => process.stderr.write('  [mcp] ' + d));
let nextId = 1, pendingCalls = new Map(), outBuf = '';
mcp.stdout.on('data', (d) => {
  outBuf += d;
  let i;
  while ((i = outBuf.indexOf('\n')) >= 0) {
    const line = outBuf.slice(0, i); outBuf = outBuf.slice(i + 1);
    const msg = JSON.parse(line);
    const p = pendingCalls.get(msg.id);
    if (p) { pendingCalls.delete(msg.id); p(msg); }
  }
});
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => { pendingCalls.set(id, resolve); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
}
const tool = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r.error) throw new Error(r.error.message);
  const text = r.result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const img = r.result.content.find((c) => c.type === 'image');
  return { text, img, isError: r.result.isError };
};

(async () => {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(SERVER + '/health')).ok) break; } catch (e) { /* not yet */ } await new Promise((r) => setTimeout(r, 250)); }
  fakePlugin().catch(() => {});
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  log('initialize →', init.result.serverInfo.name, init.result.protocolVersion);
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await rpc('tools/list', {});
  log('outils :', list.result.tools.map((t) => t.name).join(', '));

  const status = await tool('figma_status', {});
  log('figma_status →', status.text.split('\n')[0]);

  let page = await tool('open_page', { url: URL });
  log('open_page →', page.text.split('\n').slice(0, 2).join(' | '), `(${page.text.split('\n').length} lines, screenshot ${page.img ? Math.round(page.img.data.length / 1024) + ' KB' : 'missing'})`);
  let line = page.text.split('\n').find((l) => /^e\d+ /.test(l) && BUTTON.test(l));
  if (!line) {
    page = await tool('get_page', { all: true, screenshot: false });
    line = page.text.split('\n').find((l) => /^e\d+ /.test(l) && BUTTON.test(l));
    log('get_page all=true →', page.text.split('\n').length, 'lines');
  }
  if (!line) throw new Error('button not found in the page description');
  const ref = line.split(' ')[0];
  log('click on', line);
  page = await tool('click', { ref });
  const dlg = page.text.split('\n').filter((l) => /^d\d+ /.test(l));
  log('open dialogs:', dlg.join(' | ') || 'none');
  const dm = /content only: (d\d+)/.exec(dlg.join(' ')) || /^(d\d+)/.exec(dlg[0] || '');
  const contentRef = dm ? dm[1] : null;
  if (!contentRef) {
    log('no open dialog, page after click:', page.text.split('\n').slice(0, 2).join(' | '));
    const e = await tool('export_to_figma', { scope: 'viewport', name: 'Test – Screen after click' });
    log('export_to_figma (screen) →', e.text);
    const ok2 = /✓/.test(e.text);
    console.log(ok2 ? '\n✓ Full MCP scenario passed' : '\n✗ MCP scenario failed');
    mcp.stdin.end(); server.kill('SIGINT');
    setTimeout(() => process.exit(ok2 ? 0 : 1), 1500);
    return;
  }
  if (page.img) fs.writeFileSync(path.join(tmp, 'after-click.jpg'), Buffer.from(page.img.data, 'base64'));

  const exp = await tool('export_to_figma', { ref: contentRef, name: 'Test – Modal', autoLayout: true });
  log('export_to_figma (modal only) →', exp.text);
  const exp2 = await tool('export_to_figma', { scope: 'viewport', name: 'Test – Screen with modal' });
  log('export_to_figma (screen) →', exp2.text);
  const esc = await tool('press_key', { key: 'Escape' });
  log('press_key Escape → dialogs:', esc.text.split('\n').filter((l) => /^d\d+ /.test(l)).join(' | ') || 'none');

  const modal = pluginResults.find((r) => r.name === 'Test – Modal');
  if (modal) log(`exported modal: frame ${modal.root.name} ${Math.round(modal.root.w)}×${Math.round(modal.root.h)}, ${modal.root.children.length} children`);
  console.log('\ntest files:', tmp);
  const ok = modal && modal.ok && /✓/.test(exp.text) && /✓/.test(exp2.text);
  console.log(ok ? '\n✓ Full MCP scenario passed' : '\n✗ MCP scenario failed');
  mcp.stdin.end();
  server.kill('SIGINT');
  setTimeout(() => process.exit(ok ? 0 : 1), 1500);
})().catch((e) => { console.error('✗', e); mcp.kill(); server.kill('SIGKILL'); process.exit(1); });
