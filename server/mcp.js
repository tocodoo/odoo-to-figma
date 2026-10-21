#!/usr/bin/env node
'use strict';
// Odoo To Figma – MCP server (stdio).
// Lets Claude drive a browser session (open pages, click buttons, open modals…)
// and export pages, screens or single elements to Figma through the plugin.
//
//   claude mcp add odoo-to-figma -- node /path/to/server/mcp.js

// stdout carries the MCP protocol: every log goes to stderr.
console.log = (...a) => console.error(...a);

const readline = require('readline');
const pkg = require('../package.json');

const SERVER = process.env.O2F_SERVER || 'http://127.0.0.1:3999';
const LAUNCHER = process.env.O2F_LAUNCHER || 'http://127.0.0.1:3998';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Render server access
// ---------------------------------------------------------------------------

let inProcess = null;

async function alive() {
  try { return (await fetch(SERVER + '/health', { signal: AbortSignal.timeout(1500) })).ok; } catch (e) { return false; }
}

async function ensureServer() {
  if (await alive()) return;
  try { await fetch(LAUNCHER + '/start', { method: 'POST', signal: AbortSignal.timeout(30000) }); } catch (e) { /* no launcher */ }
  for (let i = 0; i < 40; i++) { if (await alive()) return; await sleep(500); }
  if (!inProcess) inProcess = await require('./index').start(); // last resort: run it here
}

async function call(path, body) {
  await ensureServer();
  const r = await fetch(SERVER + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Erreur ${r.status}`);
  return j;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const viewportSchema = {
  description: 'Screen size: "desktop" (1440), "tablet" (768), "mobile" (390) or {"width": 1280, "height": 800}.',
  anyOf: [{ type: 'string', enum: ['desktop', 'tablet', 'mobile'] }, { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } }, required: ['width'] }],
};
const refSchema = { type: 'string', description: 'Element reference from the last page description (e.g. "e12", or "d1" for an open dialog).' };
const screenshotSchema = { type: 'boolean', description: 'Include a screenshot of the screen (default true).' };

const TOOLS = [
  {
    name: 'open_page',
    description: 'Open a URL in the browser session (cookies are kept between runs). Returns the page description: open dialogs and interactive elements (links, buttons, tabs, menus, fields) with references, plus a screenshot. Use visible=true to show the Chrome window, e.g. so the user can log in.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, viewport: viewportSchema, visible: { type: 'boolean', description: 'Show the browser window (for logging in or watching).' }, screenshot: screenshotSchema }, required: ['url'] },
    run: (a) => call('/session/open', a).then(pageResult),
  },
  {
    name: 'get_page',
    description: 'Describe the current page again (fresh element references). all=true lists elements outside the visible screen too.',
    inputSchema: { type: 'object', properties: { all: { type: 'boolean' }, screenshot: screenshotSchema } },
    run: (a) => call('/session/describe', a).then(pageResult),
  },
  {
    name: 'click',
    description: 'Click an element (button, link, tab, menu item, row…) by reference, wait for the page to react, and return the new page description.',
    inputSchema: { type: 'object', properties: { ref: refSchema, screenshot: screenshotSchema }, required: ['ref'] },
    run: (a) => call('/session/click', a).then(pageResult),
  },
  {
    name: 'hover',
    description: 'Move the mouse over an element (ref, or a CSS selector such as ".o_field_widget sup" when it has no reference), or to screen coordinates x/y (e.g. a bar of a chart), and leave it there, to reveal a tooltip, a popover or a hover state. Then call export_to_figma (e.g. selector ".o-tooltip, .o_popover" for the tooltip alone, or scope "viewport").',
    inputSchema: { type: 'object', properties: { ref: refSchema, selector: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, wait: { type: 'number', description: 'Milliseconds to wait after hovering (default 900).' }, screenshot: screenshotSchema } },
    run: (a) => call('/session/hover', a).then(pageResult),
  },
  {
    name: 'type_text',
    description: 'Type text into a field (replaces its content). submit=true presses Enter afterwards.',
    inputSchema: { type: 'object', properties: { ref: refSchema, text: { type: 'string' }, submit: { type: 'boolean' }, screenshot: screenshotSchema }, required: ['ref', 'text'] },
    run: (a) => call('/session/type', a).then(pageResult),
  },
  {
    name: 'press_key',
    description: 'Press a keyboard key, e.g. "Escape" to close a dialog, "Enter", "Tab", "ArrowDown".',
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, screenshot: screenshotSchema }, required: ['key'] },
    run: (a) => call('/session/key', a).then(pageResult),
  },
  {
    name: 'go_back',
    description: 'Go back to the previous page in the session history.',
    inputSchema: { type: 'object', properties: { screenshot: screenshotSchema } },
    run: (a) => call('/session/back', a).then(pageResult),
  },
  {
    name: 'scroll',
    description: 'Scroll the page: to an element (ref), to a position (y), or by an amount (by, default one screen).',
    inputSchema: { type: 'object', properties: { ref: refSchema, y: { type: 'number' }, by: { type: 'number' }, screenshot: screenshotSchema } },
    run: (a) => call('/session/scroll', a).then(pageResult),
  },
  {
    name: 'export_to_figma',
    description: 'Export the current state of the session page to Figma as editable layers (auto layout optional). scope: "page" = whole page (default), "viewport" = what is visible on screen (e.g. an app screen with its open modal), or give ref (or a CSS selector) to export a single element only (e.g. the content of a dialog "d2", or a chart). With url, the page is opened first. Give each export a clear name, e.g. "Ventes – Modale Nouveau devis". The Figma plugin "Odoo To Figma" must be open in Figma to receive it.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['page', 'viewport'] }, ref: refSchema, url: { type: 'string' },
        selector: { type: 'string', description: 'CSS selector of a single element to export when it has no reference (e.g. a chart ".o_graph_canvas_container", a card, a table).' },
        name: { type: 'string', description: 'Name of the frame in Figma.' },
        autoLayout: { type: 'boolean', description: 'Convert layouts to Figma auto layout (default: the plugin setting).' },
        viewport: viewportSchema,
      },
    },
    run: (a) => call('/session/export', a).then(exportResult),
  },
  {
    name: 'import_url_to_figma',
    description: 'Import public web pages into Figma (fresh browser, no session cookies, whole page), like the plugin\'s Import button. Accepts several URLs and several viewports.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' }, urls: { type: 'array', items: { type: 'string' } },
        viewports: { type: 'array', items: viewportSchema }, theme: { type: 'string', enum: ['light', 'dark'] },
        autoLayout: { type: 'boolean' }, name: { type: 'string' },
      },
    },
    run: async (a) => {
      const urls = (a.urls || []).concat(a.url ? [a.url] : []);
      if (!urls.length) throw new Error('Donnez url ou urls.');
      const all = { plugin: false, jobs: [] };
      for (const u of urls) {
        const r = await call('/figma/import-url', { url: u, viewports: a.viewports, theme: a.theme, autoLayout: a.autoLayout, name: urls.length === 1 ? a.name : undefined });
        all.plugin = r.plugin;
        all.jobs.push(...r.jobs);
      }
      return exportResult(all);
    },
  },
  {
    name: 'import_html_to_figma',
    description: 'Render HTML/CSS code (e.g. a mockup you wrote) and import it into Figma as editable layers.',
    inputSchema: {
      type: 'object',
      properties: { html: { type: 'string' }, css: { type: 'string' }, width: { type: 'number', description: 'Viewport width (default 1440).' }, name: { type: 'string' }, autoLayout: { type: 'boolean' } },
      required: ['html'],
    },
    run: (a) => call('/figma/import-html', a).then(exportResult),
  },
  {
    name: 'figma_status',
    description: 'Tell whether the Figma plugin is open and connected, and list exports still waiting.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const s = await call('/figma/status');
      const lines = [s.pluginConnected ? '✓ Odoo To Figma plugin open and connected.' : '✗ Odoo To Figma plugin not open in Figma (Plugins → Development → Odoo To Figma).'];
      if (s.pending.length) lines.push(`Pending: ${s.pending.map((p) => `"${p.name}"`).join(', ')}`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  },
  {
    name: 'close_browser',
    description: 'Close the browser session.',
    inputSchema: { type: 'object', properties: {} },
    run: () => call('/session/close', {}).then(() => ({ content: [{ type: 'text', text: 'Browser closed.' }] })),
  },
];

function pageResult(r) {
  const content = [{ type: 'text', text: r.text }];
  if (r.screenshot) content.push({ type: 'image', data: r.screenshot, mimeType: 'image/jpeg' });
  return { content };
}

function exportResult(r) {
  const lines = r.jobs.map((j) => {
    if (j.status === 'done') {
      const x = j.result || {};
      return `✓ "${j.name}" imported into Figma — ${x.nodes || '?'} layers${x.autoLayouts ? `, ${x.autoLayouts} in auto layout` : ''}.`;
    }
    if (j.status === 'error') return `✗ "${j.name}": failed in Figma (${(j.result && j.result.error) || 'unknown error'}).`;
    return `⏳ "${j.name}" is ready and waiting for the Figma plugin.`;
  });
  if (!r.plugin && r.jobs.some((j) => j.status !== 'done')) {
    lines.push('The Odoo To Figma plugin is not open: ask the user to open it in Figma (Plugins → Development → Odoo To Figma). Pending exports will be imported automatically.');
  }
  return { content: [{ type: 'text', text: lines.join('\n') }], isError: r.jobs.some((j) => j.status === 'error') };
}

const INSTRUCTIONS = `Odoo To Figma exports web pages and app screens (Odoo or any site) to Figma as editable layers. The Figma plugin "Odoo To Figma" must be open in Figma to receive exports.
- Public pages: import_url_to_figma (several URLs/viewports at once).
- Interactive states (a modal after clicking a button, a tab, a dropdown…): open_page → read the element references → click / type_text → export_to_figma. To export only a modal, pass its dialog reference (prefer the "content only" one) as ref; use scope "viewport" to keep the screen behind it.
- Every view of an app: explore the navigation found by get_page (menus, tabs, links, buttons), visit each view and call export_to_figma with a descriptive name. Close dialogs with press_key Escape. Avoid destructive actions (delete, confirm, send) unless the user asked.
- Pages behind a login: open_page with visible=true and ask the user to log in in the Chrome window, then continue (cookies are kept).`;

// ---------------------------------------------------------------------------
// JSON-RPC over stdio (MCP)
// ---------------------------------------------------------------------------

function write(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { write({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { write({ jsonrpc: '2.0', id, error: { code, message } }); }

async function onMessage(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'odoo-to-figma', title: 'Odoo To Figma', version: pkg.version },
      instructions: INSTRUCTIONS,
    });
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') {
    return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === (params && params.name));
    if (!tool) return fail(id, -32602, `Outil inconnu : ${params && params.name}`);
    try {
      return reply(id, await tool.run((params && params.arguments) || {}));
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: `Erreur : ${e.message || e}` }], isError: true });
    }
  }
  if (id !== undefined && method) return fail(id, -32601, `Method not supported: ${method}`);
  // notifications (initialized, cancelled…) need no answer
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return fail(null, -32700, 'Parse error'); }
  onMessage(msg).catch((e) => { if (msg.id !== undefined) fail(msg.id, -32603, e.message || String(e)); });
});
rl.on('close', async () => {
  if (inProcess) await inProcess.close().catch(() => {});
  process.exit(0);
});
