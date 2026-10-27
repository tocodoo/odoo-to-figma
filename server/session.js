'use strict';
// Browser session driven by Claude (through MCP): a persistent Chrome whose
// cookies survive between runs (log in once), optionally visible so the user
// can log in or watch. Its current state can be exported to Figma at any time.

const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');
const {
  findChrome, capturePage, openUrl, afterAction: waitAfterAction, trackResponses, trackNavigation, applyViewport, userAgentFor,
  resolveViewport, normalizeUrl,
} = require('./capture');
const scripts = require('./page-scripts');

const PROFILE = process.env.O2F_PROFILE || path.join(os.homedir(), 'Library', 'Application Support', 'Odoo To Figma', 'profile');

let state = null; // { browser, page, visible, vp, userAgent, responses, lastNav }
let chain = Promise.resolve();

/** Run session actions one at a time. */
function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

/** Stop Chrome processes still using the session profile (left over from an earlier run). */
function killProfileChrome() {
  const { execFileSync } = require('child_process');
  let pids = [];
  try { pids = execFileSync('pgrep', ['-f', `--user-data-dir=${PROFILE}`]).toString().split(/\s+/).filter(Boolean); } catch (e) { /* none */ }
  for (const pid of pids) { try { process.kill(Number(pid), 'SIGKILL'); } catch (e) { /* gone */ } }
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) { try { fs.unlinkSync(path.join(PROFILE, f)); } catch (e) { /* absent */ } }
}

async function ensure({ visible, viewport } = {}) {
  const wantVisible = visible == null ? (state ? state.visible : false) : !!visible;
  if (state && (!state.browser.connected || state.visible !== wantVisible)) await close();
  if (!state) {
    const executablePath = findChrome();
    if (!executablePath) throw new Error('Google Chrome not found.');
    fs.mkdirSync(PROFILE, { recursive: true });
    const launch = () => puppeteer.launch({
      executablePath,
      headless: !wantVisible,
      userDataDir: PROFILE,
      defaultViewport: null,
      args: ['--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-features=Translate', '--window-size=1480,1000'],
    });
    let browser;
    try {
      browser = await launch();
    } catch (e) {
      // A Chrome left over from an earlier server run (e.g. a cancelled call) still holds the profile.
      if (!/already running/i.test(e.message)) throw e;
      killProfileChrome();
      browser = await launch();
    }
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());
    state = { browser, page, visible: wantVisible, vp: null, userAgent: null, responses: trackResponses(page), lastNav: trackNavigation(page) };
    browser.on('disconnected', () => { if (state && state.browser === browser) state = null; });
  }
  if (viewport || !state.vp) {
    const vp = resolveViewport(viewport || 'desktop');
    const ua = userAgentFor(await state.browser.userAgent(), vp);
    await applyViewport(state.page, vp, ua);
    state.vp = vp;
    state.userAgent = ua;
  }
  return state;
}

function current() {
  if (!state || !state.browser.connected) throw new Error('Aucune page ouverte : utilisez d\'abord open_page.');
  return state;
}

function afterAction(st) { return waitAfterAction(st.page, st.lastNav); }

async function describe(st, { screenshot = true, all = false } = {}) {
  const d = await st.page.evaluate(scripts.describePage, { all, max: all ? 400 : 150 });
  const lines = [];
  lines.push(`Page: ${d.title || '(untitled)'}`);
  lines.push(`URL: ${d.url}`);
  lines.push(`Viewport: ${d.viewport[0]}×${d.viewport[1]} · scroll y=${d.scroll[1]} of ${d.height}px height`);
  if (d.dialogs.length) {
    lines.push('', 'Open dialogs / menus:');
    for (const g of d.dialogs) lines.push(`${g.ref} ${g.kind}${g.title ? ` "${g.title}"` : ''}${g.content ? ` (content only: ${g.content})` : ''}`);
  }
  lines.push('', `${all ? 'Elements' : 'Visible elements'} (${d.elements.length}${d.truncated ? '+' : ''}):`);
  for (const e of d.elements) {
    let l = `${e.ref} ${e.role}${e.type && e.type !== e.role ? `[${e.type}]` : ''} "${e.name}"`;
    if (e.href && !/^javascript:/.test(e.href) && e.href !== '#') l += ` → ${e.href}`;
    if (e.value) l += ` = "${e.value}"`;
    if (e.active) l += ' [active]';
    if (e.expanded === true) l += ' [expanded]';
    if (e.disabled) l += ' [disabled]';
    if (e.in) l += ` (in ${e.in})`;
    lines.push(l);
  }
  if (d.truncated) lines.push('… list truncated: scroll or ask for all=true.');
  const out = { text: lines.join('\n'), url: d.url, title: d.title };
  if (screenshot) {
    const vp = st.vp;
    out.screenshot = await st.page.screenshot({
      type: 'jpeg', quality: 60, encoding: 'base64',
      clip: { x: d.scroll[0], y: d.scroll[1], width: vp.width, height: vp.height, scale: 0.5 },
    }).catch(() => null);
  }
  return out;
}

async function handle(st, ref) {
  const el = await st.page.$(`[data-o2f-ref="${String(ref).replace(/"/g, '')}"]`);
  if (!el) throw new Error(`Element ${ref} not found: the page changed, re-read it with get_page.`);
  return el;
}

const actions = {
  open: (a) => serial(async () => {
    const st = await ensure({ visible: a.visible, viewport: a.viewport });
    await openUrl(st.page, normalizeUrl(a.url), st.lastNav);
    await st.page.evaluate(scripts.preparePage).catch(() => {});
    if (a.visible) await st.page.bringToFront().catch(() => {});
    return describe(st, a);
  }),
  describe: (a) => serial(async () => describe(current(), a)),
  click: (a) => serial(async () => {
    const st = current();
    const el = await handle(st, a.ref);
    await el.evaluate((e) => e.scrollIntoView({ block: 'center', inline: 'center' }));
    try { await el.click({ delay: 30 }); } catch (e) { await el.evaluate((n) => n.click()); }
    await afterAction(st);
    return describe(st, a);
  }),
  /** Move the mouse over an element (ref or CSS selector) and keep it there, e.g. to show a tooltip. */
  hover: (a) => serial(async () => {
    const st = current();
    if (a.x != null && a.y != null && !a.ref && !a.selector) {
      await st.page.mouse.move(a.x, a.y, { steps: 5 });
    } else {
      const el = a.ref ? await handle(st, a.ref) : await st.page.$(a.selector || '');
      if (!el) throw new Error(`Element ${a.ref || a.selector} not found: re-read the page with get_page.`);
      await el.evaluate((e) => e.scrollIntoView({ block: 'center', inline: 'center' }));
      await el.hover();
    }
    await new Promise((r) => setTimeout(r, a.wait != null ? a.wait : 900));
    return describe(st, a);
  }),
  type: (a) => serial(async () => {
    const st = current();
    const el = await handle(st, a.ref);
    await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await el.click({ clickCount: 3 }).catch(() => {});
    await el.evaluate((e) => { if ('value' in e) e.value = ''; });
    await el.type(String(a.text || ''), { delay: 15 });
    if (a.submit) await st.page.keyboard.press('Enter');
    await afterAction(st);
    return describe(st, a);
  }),
  key: (a) => serial(async () => {
    const st = current();
    await st.page.keyboard.press(a.key || 'Escape');
    await afterAction(st);
    return describe(st, a);
  }),
  back: (a) => serial(async () => {
    const st = current();
    await st.page.goBack({ waitUntil: ['load', 'networkidle2'], timeout: 20000 }).catch(() => {});
    await afterAction(st);
    return describe(st, a);
  }),
  scroll: (a) => serial(async () => {
    const st = current();
    if (a.ref) {
      const el = await handle(st, a.ref);
      await el.evaluate((e) => e.scrollIntoView({ block: 'start' }));
    } else {
      await st.page.evaluate((y, by) => {
        if (y != null) window.scrollTo(0, y);
        else window.scrollBy(0, by != null ? by : window.innerHeight * 0.8);
      }, a.y, a.by);
    }
    await afterAction(st);
    return describe(st, a);
  }),
  /** Capture the current state. scope: page | viewport | element (ref). */
  capture: (a, progress) => serial(async () => {
    const st = a.url ? await ensure({ viewport: a.viewport }) : current();
    if (a.viewport && !a.url) await ensure({ viewport: a.viewport });
    if (a.url) {
      await openUrl(st.page, normalizeUrl(a.url), st.lastNav);
    }
    const target = a.ref ? `[data-o2f-ref="${String(a.ref).replace(/"/g, '')}"]` : a.selector || null;
    const scope = target ? 'element' : a.scope || 'page';
    return capturePage(st.page, {
      vp: st.vp, userAgent: st.userAgent, responses: st.responses, lastNav: st.lastNav,
      scope, target,
      scroll: scope === 'page', name: a.name,
    }, progress);
  }),
  close: () => serial(async () => { await close(); return { text: 'Browser closed.' }; }),
};

async function close() {
  if (!state) return;
  const b = state.browser;
  state = null;
  await b.close().catch(() => {});
}

module.exports = { actions, close };
