'use strict';
// Loads a URL in headless Chrome and produces the IR + images for the plugin.

const fs = require('fs');
const puppeteer = require('puppeteer-core');
const scripts = require('./page-scripts');
const { PROPS, Snap, buildIR, collectImageUrls } = require('./snapshot-to-ir');
const { sniff, dimensions, decodeDataUrl } = require('./images');
const iconfonts = require('./iconfonts');

const MAX_IMAGE_DIM = 4096;

const VIEWPORTS = {
  desktop: { width: 1440, height: 900, mobile: false, label: 'Desktop' },
  tablet: { width: 768, height: 1024, mobile: true, label: 'Tablet' },
  mobile: { width: 390, height: 844, mobile: true, label: 'Mobile' },
};

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    require('os').homedir() + '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (e) { /* ignore */ } }
  return null;
}

let browserPromise = null;
async function getBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    if (b && b.connected) return b;
  }
  const executablePath = findChrome();
  if (!executablePath) throw new Error('Google Chrome not found. Install Chrome or set CHROME_PATH.');
  browserPromise = puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--hide-scrollbars', '--font-render-hinting=none', '--disable-features=Translate', '--no-first-run', '--no-default-browser-check'],
  });
  return browserPromise;
}

async function closeBrowser() {
  if (!browserPromise) return;
  const p = browserPromise;
  browserPromise = null;
  try { const b = await p; await b.close(); } catch (e) { /* already gone */ }
}

function resolveViewport(v) {
  if (typeof v === 'string' && VIEWPORTS[v]) return { key: v, ...VIEWPORTS[v] };
  if (v && typeof v === 'object' && v.width) {
    const w = Math.max(200, Math.min(3840, Math.round(v.width)));
    return { key: 'custom', width: w, height: Math.round(v.height || (w < 768 ? 844 : w < 1024 ? 1024 : 900)), mobile: w < 1024, label: v.label || `${w}px` };
  }
  return { key: 'desktop', ...VIEWPORTS.desktop };
}

function normalizeUrl(u) {
  u = String(u || '').trim();
  if (!u) throw new Error('URL manquante.');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  const parsed = new URL(u);
  return parsed.href;
}

function userAgentFor(baseUA, vp) {
  const ua = baseUA.replace('HeadlessChrome', 'Chrome');
  const chromeVer = (/Chrome\/([\d.]+)/.exec(ua) || [])[1] || '140.0.0.0';
  if (!vp.mobile) return ua;
  return vp.width < 600
    ? `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Mobile Safari/537.36`
    : `Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`;
}

async function applyViewport(page, vp, userAgent) {
  await page.setUserAgent(userAgent);
  await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 2, isMobile: vp.mobile, hasTouch: vp.mobile });
}

/** Keep image responses so they don't have to be downloaded twice. */
function trackResponses(page) {
  const responses = new Map();
  page.on('response', (resp) => {
    try {
      const type = resp.request().resourceType();
      if (type !== 'image' && type !== 'media' && type !== 'other' && type !== 'font' && type !== 'stylesheet') return;
      const status = resp.status();
      if (status < 200 || status >= 300) return;
      const p = resp.buffer().then((buf) => ({ buf, mime: (resp.headers()['content-type'] || '').split(';')[0] })).catch(() => null);
      responses.set(resp.url(), p);
      const chain = resp.request().redirectChain();
      if (chain.length) responses.set(chain[0].url(), p);
      if (responses.size > 3000) responses.delete(responses.keys().next().value);
    } catch (e) { /* ignore */ }
  });
  return responses;
}

/** Returns a getter for the time of the last main-frame navigation. */
function trackNavigation(page) {
  let navAt = Date.now();
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navAt = Date.now(); });
  return () => navAt;
}

/** Load a URL and wait until it stops redirecting. */
async function openUrl(page, url, lastNav) {
  try {
    await page.goto(url, { waitUntil: ['load', 'networkidle2'], timeout: 45000 });
  } catch (e) {
    if (!/timeout/i.test(String(e && e.message))) throw new Error(`Could not load the page: ${e.message}`);
  }
  // Some pages keep navigating after "load" (redirects, Odoo demo/login flows).
  await settle(page, lastNav);
}

/**
 * Capture a page that is already open, in its current state.
 * opts: { vp, theme, responses, userAgent, lastNav, scroll (scroll through for lazy content),
 *         scope: 'page' | 'viewport' | 'element', target (CSS selector for scope 'element'), name }
 */
async function capturePage(page, opts, progress = () => {}) {
  const t0 = Date.now();
  const { vp, responses, userAgent, lastNav } = opts;
  const scope = opts.scope || 'page';
  progress('Preparing (animations, lazy images)…', 20);
  let svgs, scrollPos;
  for (let attempt = 0; ; attempt++) {
    try {
      await page.evaluate(scripts.preparePage);
      // Partial exports (viewport / element) also need one pass through the page:
      // reveal-on-scroll content below the fold stays hidden otherwise. Done once
      // per document, and the user's scroll position is kept.
      const keepY = opts.scroll ? 0 : await page.evaluate(() => (window.__o2fScrolled ? null : window.scrollY));
      if (opts.scroll || keepY != null) {
        await page.evaluate(scripts.scrollThrough, 60000, keepY);
        await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});
      }
      await page.evaluate(scripts.waitForAssets, 6000);
      if (opts.scroll) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await new Promise((r) => setTimeout(r, 400));
      }
      await page.evaluate(scripts.settleAnimations).catch(() => {});
      progress('Analyzing layout…', 40);
      ({ svgs } = await page.evaluate(scripts.annotatePage));
      scrollPos = await page.evaluate((sel) => {
        document.querySelectorAll('[data-o2f-target]').forEach((e) => e.removeAttribute('data-o2f-target'));
        if (sel) {
          const el = document.querySelector(sel);
          if (!el) return null;
          el.setAttribute('data-o2f-target', '1');
        }
        return [window.scrollX, window.scrollY];
      }, scope === 'element' ? opts.target : null);
      if (!scrollPos) throw new Error('Element to export not found: re-read the page to get up-to-date references.');
      break;
    } catch (e) {
      if (attempt >= 3 || !NAV_ERR.test(String(e && e.message))) throw e;
      progress('The page URL changed, retrying…', 20);
      await settle(page, lastNav || (() => 0));
    }
  }
  const title = await page.title();
  const finalUrl = page.url();
  const cdp = await page.createCDPSession();
  try {
    const raw = await cdp.send('DOMSnapshot.captureSnapshot', {
      computedStyles: PROPS, includePaintOrder: true, includeDOMRects: true,
    });
    const snap = new Snap(raw);
    const baseURL = snap.doc.baseURL >= 0 ? snap.str(snap.doc.baseURL) : finalUrl;

    // ----- images -----------------------------------------------------------
    const urls = collectImageUrls(snap, baseURL);
    progress(`Fetching images (${urls.size})…`, 50);
    const images = new Map();
    const payload = {};
    let idn = 0;
    const list = Array.from(urls.entries());
    let done = 0;
    await runPool(list, 6, async ([u, disp]) => {
      try {
        const res = await loadImage(u, responses, finalUrl, userAgent);
        if (!res) return;
        const conv = await normalizeImage(res.buf, res.mime, disp, page);
        if (!conv) return;
        const id = 'img' + idn++;
        payload[id] = conv.b64;
        images.set(u, { id, w: conv.w, h: conv.h, natW: conv.natW, natH: conv.natH, svg: conv.svg || null });
      } catch (e) { /* skip broken image */ }
      done++;
      if (done % 10 === 0) progress(`Fetching images (${done}/${list.length})…`, 50 + Math.round((done / list.length) * 20));
    });

    progress('Building layers…', 72);
    const ir = buildIR(snap, { images, svgs, viewport: vp, baseURL, scope, scrollY: scrollPos[1] });
    // Only keep the pixels the exported layers actually use (element / viewport scopes).
    const used = usedImageIds(ir.root);
    for (const id of Object.keys(payload)) if (!used.has(id)) delete payload[id];
    ir.shots = ir.shots.filter((x) => used.has(x.id));
    ir.icons = ir.icons.filter((x) => used.has(x.id));
    ir.patterns = (ir.patterns || []).filter((x) => used.has(x.id));

    // ----- screenshots (iframes, videos, canvas, native controls) -----------
    // Each element is captured alone on a transparent page, so content drawn
    // over it (text, badges…) is not baked into the pixels.
    if (ir.shots.length) {
      progress(`Capturing embedded elements (${ir.shots.length})…`, 80);
      const shots = ir.shots.slice(0, 80);
      try {
        await cdp.send('DOM.getDocument', { depth: 0 });
        for (const sh of shots) {
          try {
            const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: sh.backendId });
            await cdp.send('Runtime.callFunctionOn', {
              objectId: object.objectId,
              functionDeclaration: 'function (k) { this.setAttribute("data-o2f-shot", (this.getAttribute("data-o2f-shot") || "") + " " + k); }',
              arguments: [{ value: sh.id }],
            });
            sh.marked = true;
          } catch (e) { /* plain screenshot */ }
        }
      } catch (e) { /* plain screenshots */ }
      for (const sh of shots) {
        try {
          const w = Math.min(sh.w, vp.width * 2), h = Math.min(sh.h, 4000);
          if (w < 1 || h < 1) continue;
          // <canvas> (charts…): read its pixels directly — a screenshot can trigger
          // a resize that makes libraries like Chart.js redraw from scratch.
          if (sh.marked && !sh.pseudo) {
            const direct = await page.evaluate((id) => {
              const el = document.querySelector(`[data-o2f-shot~="${id}"]`);
              if (!el || el.tagName !== 'CANVAS' || !el.width || !el.height) return null;
              try { return el.toDataURL('image/png').split(',')[1]; } catch (e) { return null; }
            }, sh.id).catch(() => null);
            if (direct) { payload[sh.id] = direct; continue; }
          }
          await page.evaluate(scripts.isolateShot, sh.marked ? sh.id : null, sh.pseudo);
          // Inside the viewport: no resize (captureBeyondViewport) that would re-layout the page.
          const vis = await page.evaluate(() => [window.scrollX, window.scrollY, window.innerWidth, window.innerHeight]);
          const inView = sh.x >= vis[0] && sh.y >= vis[1] && sh.x + w <= vis[0] + vis[2] + 1 && sh.y + h <= vis[1] + vis[3] + 1;
          payload[sh.id] = await page.screenshot({
            clip: { x: Math.max(0, sh.x), y: Math.max(0, sh.y), width: w, height: h, scale: 2 },
            captureBeyondViewport: !inView, omitBackground: !!sh.marked, encoding: 'base64', type: 'png',
          });
        } catch (e) { /* skip */ }
      }
      await page.evaluate(scripts.isolateShot, null, null).catch(() => {});
    }

    // ----- icon fonts → vectors read from the font files the page uses ------
    if (ir.icons.length) {
      progress(`Vector icons (${ir.icons.length})…`, 84);
      const vec = await iconfonts.vectorize(page, ir.icons.map((ic) => ({ ...ic, color: ic.rgba })), { responses, userAgent, referer: finalUrl }).catch(() => new Map());
      for (const ic of ir.icons) {
        const v = vec.get(ic.id);
        if (!v) continue;
        Object.assign(ic.node, { type: 'SVG', name: v.name, svg: v.svg });
        delete ic.node.fills;
        delete ic.node.children;
        delete ic.node.img;
        ic.vector = true;
      }
      ir.stats.iconVectors = vec.size;
      ir.icons = ir.icons.filter((ic) => !ic.vector);
    }

    // ----- repeated CSS gradient patterns (dots, grids…): one tile each, rendered
    // by Chrome on a transparent page (hides the page content, restored right after)
    if (ir.patterns.length) {
      progress(`CSS patterns (${ir.patterns.length})…`, 85);
      const pats = ir.patterns.slice(0, 200);
      try {
        const pos = await page.evaluate(scripts.layoutPatterns, pats.map(({ id, css, w, h, ox, oy }) => ({ id, css, w, h, ox, oy })));
        for (const pt of pats) {
          const p = pos[pt.id];
          if (!p) continue;
          try {
            payload[pt.id] = await page.screenshot({
              clip: { x: p.x, y: p.y, width: p.w, height: p.h, scale: pt.scale },
              omitBackground: true, captureBeyondViewport: true, encoding: 'base64', type: 'png',
            });
          } catch (e) { /* skip */ }
        }
      } catch (e) { /* skip */ }
      await page.evaluate(scripts.removePatterns).catch(() => {});
      // Tile scale = CSS tile width / PNG width (clip scale × device pixel ratio).
      const sf = {};
      for (const pt of pats) {
        const b64 = payload[pt.id];
        const pngW = b64 ? Buffer.from(b64.slice(0, 64), 'base64').readUInt32BE(16) : 0;
        if (pngW) sf[pt.id] = Math.round((pt.w / pngW) * 10000) / 10000;
      }
      (function walk(n) {
        for (const f of n.fills || []) if (f.scaleMode === 'TILE' && sf[f.id]) f.sf = sf[f.id];
        (n.children || []).forEach(walk);
      })(ir.root);
    }

    // ----- remaining icon fonts: rendered by Chrome itself on a transparent page
    // (runs last: it hides the page content, restored right after)
    if (ir.icons.length) {
      progress(`Rendering icons (${ir.icons.length})…`, 86);
      const icons = ir.icons.slice(0, 400).map(({ id, text, css, w, h, font, color }) => ({ id, text, css, w, h, font, color }));
      let rendered = 0;
      try {
        const pos = await page.evaluate(scripts.layoutIcons, icons);
        for (const ic of icons) {
          const p = pos[ic.id];
          if (!p || p.w < 0.5 || p.h < 0.5) continue;
          try {
            payload[ic.id] = await page.screenshot({
              clip: { x: p.x, y: p.y, width: p.w, height: p.h, scale: 4 },
              omitBackground: true, captureBeyondViewport: true, encoding: 'base64', type: 'png',
            });
            rendered++;
          } catch (e) { /* fall back below */ }
        }
      } catch (e) { /* fall back below */ }
      if (rendered < icons.length) {
        const missing = icons.filter((ic) => !payload[ic.id]);
        Object.assign(payload, await page.evaluate(scripts.renderIcons, missing, 4).catch(() => ({})));
      }
    }
    await page.evaluate(scripts.restorePage, scrollPos).catch(() => {});

    progress('Sending to Figma…', 92);
    return {
      meta: {
        url: finalUrl, title, name: opts.name || null, scope,
        viewport: { key: vp.key, width: vp.width, height: vp.height, label: vp.label }, theme: opts.theme || 'light',
        width: ir.root.w, height: ir.root.h, ms: Date.now() - t0, stats: ir.stats,
      },
      root: ir.root,
      styles: ir.styles,
      images: payload,
    };
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** Open a new incognito page configured for a viewport/theme/language. */
async function newIncognitoPage(req) {
  const vp = resolveViewport(req.viewport);
  const theme = req.theme === 'dark' ? 'dark' : 'light';
  const browser = await getBrowser();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const userAgent = userAgentFor(await browser.userAgent(), vp);
  await applyViewport(page, vp, userAgent);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
  await page.setExtraHTTPHeaders({ 'Accept-Language': req.language || 'en-US,en;q=0.9' });
  return { context, page, vp, theme, userAgent, responses: trackResponses(page), lastNav: trackNavigation(page) };
}

/**
 * Import a URL (fresh incognito browser).
 * @param {object} req {url, viewport, theme, language,
 *   login: {url?, user, password}   log in first (default page: <site>/web/login),
 *   clicks: ['New', '.o_selector']  clicked in order once the page is open (text or CSS selector),
 *   target: 'page' | 'viewport' | 'modal' | {selector}}
 * @param {(msg:string, pct?:number)=>void} progress
 */
async function capture(req, progress = () => {}) {
  const url = normalizeUrl(req.url);
  const t = await newIncognitoPage(req);
  try {
    if (req.login) await login(t, url, req.login, progress);
    progress('Opening page…', 5);
    await openUrl(t.page, url, t.lastNav);
    if (req.login && await hasVisiblePassword(t.page)) throw new Error('The page still asks to log in: check the login and password, or the login page URL.');
    const clicks = (req.clicks || []).map((s) => String(s).trim()).filter(Boolean);
    for (let i = 0; i < clicks.length; i++) {
      progress(`Clicking “${clicks[i]}” (${i + 1}/${clicks.length})…`, 8 + Math.round((i / clicks.length) * 10));
      await clickStep(t, clicks[i]);
    }
    const target = req.target || 'page';
    let scope = target === 'viewport' ? 'viewport' : 'page', selector = null;
    if (target === 'modal') {
      if (!(await waitFor(t.page, scripts.findModal))) throw new Error('No open modal found: add the click that opens it (e.g. the button text).');
      scope = 'element'; selector = '[data-o2f-pick]';
    } else if (target && target.selector) {
      const ok = await waitFor(t.page, (sel) => {
        document.querySelectorAll('[data-o2f-pick]').forEach((e) => e.removeAttribute('data-o2f-pick'));
        let el = null;
        try { el = document.querySelector(sel); } catch (e) { return false; }
        if (el) el.setAttribute('data-o2f-pick', '1');
        return !!el;
      }, target.selector);
      if (!ok) throw new Error(`No element matches “${target.selector}”.`);
      scope = 'element'; selector = '[data-o2f-pick]';
    }
    return await capturePage(t.page, { ...t, scroll: scope === 'page', scope, target: selector, name: req.name }, progress);
  } finally {
    await t.context.close().catch(() => {});
  }
}

async function hasVisiblePassword(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('input[type=password]')).some((e) => e.offsetParent)).catch(() => false);
}

/** Fill and submit a login form (Odoo /web/login by default). */
async function login(t, url, auth, progress) {
  const loginUrl = auth.url ? normalizeUrl(auth.url) : new URL('/web/login', url).href;
  progress('Logging in…', 2);
  await openUrl(t.page, loginUrl, t.lastNav);
  const pwd = await t.page.$('input[type=password]');
  if (!pwd) return; // no form: nothing to do (public page or already logged in)
  const user = await t.page.$('input[name=login], input[type=email], input[autocomplete=username], form input[type=text]');
  if (!user) throw new Error(`No login field found on ${loginUrl}.`);
  for (const [el, value] of [[user, auth.user == null ? 'admin' : auth.user], [pwd, auth.password == null ? 'admin' : auth.password]]) {
    await el.evaluate((e) => { e.focus(); e.value = ''; });
    await el.type(String(value), { delay: 10 });
  }
  await Promise.all([
    t.page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }).catch(() => {}),
    pwd.press('Enter'),
  ]);
  await settle(t.page, t.lastNav);
  if (await hasVisiblePassword(t.page)) {
    const msg = await t.page.evaluate(() => { const a = document.querySelector('.alert-danger, .o_error, [role=alert]'); return a ? a.innerText.trim() : ''; }).catch(() => '');
    throw new Error(`Login failed${msg ? ` (${msg})` : ''}: check the login and password.`);
  }
}

/** Retry a page check (fn returns true when found) for a few seconds: Odoo renders asynchronously. */
async function waitFor(page, fn, arg, timeout = 10000) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    if (Date.now() - t0 > timeout) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function clickStep(t, step) {
  if (!(await waitFor(t.page, scripts.findClickable, step))) throw new Error(`Nothing to click matching “${step}”: use the exact button text or a CSS selector.`);
  const el = await t.page.$('[data-o2f-click]');
  await el.evaluate((e) => { e.removeAttribute('data-o2f-click'); e.scrollIntoView({ block: 'center', inline: 'center' }); });
  try { await el.click({ delay: 30 }); } catch (e) { await el.evaluate((n) => n.click()); }
  await afterAction(t.page, t.lastNav);
}

/** Wait for the consequences of a click / key press (navigation, XHR, re-render). */
async function afterAction(page, lastNav) {
  const before = lastNav();
  await new Promise((r) => setTimeout(r, 350));
  await page.waitForNetworkIdle({ idleTime: 400, timeout: 8000 }).catch(() => {});
  if (lastNav() !== before) await settle(page, lastNav);
  await page.evaluate(scripts.preparePage).catch(() => {});
  await new Promise((r) => setTimeout(r, 250));
}

/** Import HTML code (e.g. generated by Claude). */
async function captureHtml(req, progress = () => {}) {
  const t = await newIncognitoPage({ ...req, viewport: req.viewport || { width: req.width || 1440, height: req.height || 900 } });
  try {
    progress('Rendering HTML…', 5);
    const html = /<html[\s>]/i.test(req.html) ? req.html : `<!doctype html><html><head><meta charset="utf-8"><style>${req.css || ''}</style></head><body>${req.html}</body></html>`;
    await t.page.setContent(html, { waitUntil: ['load', 'networkidle2'], timeout: 30000 }).catch(() => {});
    return await capturePage(t.page, { ...t, scroll: true, scope: 'page', name: req.name || 'HTML' }, progress);
  } finally {
    await t.context.close().catch(() => {});
  }
}

function usedImageIds(root) {
  const ids = new Set();
  (function walk(n) {
    for (const f of n.fills || []) if (f.id) ids.add(f.id);
    if (n.fallback) ids.add(n.fallback);
    (n.children || []).forEach(walk);
  })(root);
  return ids;
}

const NAV_ERR = /Execution context was destroyed|Cannot find context|detached|Target closed/i;

/** Resolve once the main frame has not navigated for a moment (max 20 s). */
async function settle(page, lastNav) {
  const t0 = Date.now();
  while (Date.now() - lastNav() < 1500 && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 200));
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});
}

async function runPool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      await fn(items[k]);
    }
  });
  await Promise.all(workers);
}

async function loadImage(u, responses, referer, userAgent) {
  if (u.startsWith('data:')) return decodeDataUrl(u);
  const cached = responses.get(u);
  if (cached) {
    const r = await cached;
    if (r && r.buf && r.buf.length) return r;
  }
  if (!/^https?:/i.test(u)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(u, { headers: { 'User-Agent': userAgent, Referer: referer, Accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5' }, signal: ctrl.signal });
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    return { buf, mime: (resp.headers.get('content-type') || '').split(';')[0] };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function normalizeImage(buf, mime, disp, helper) {
  const type = sniff(buf) || mime;
  if (!type) return null;
  if (type === 'image/png' || type === 'image/jpeg' || type === 'image/gif') {
    const d = dimensions(buf, type);
    if (d && d.w > 0 && d.h > 0 && d.w <= MAX_IMAGE_DIM && d.h <= MAX_IMAGE_DIM) {
      return { b64: buf.toString('base64'), w: d.w, h: d.h, natW: d.w, natH: d.h };
    }
  }
  const isSvg = /svg/.test(type);
  const conv = await helper.evaluate(scripts.convertImage, buf.toString('base64'), isSvg ? 'image/svg+xml' : type, MAX_IMAGE_DIM, Math.ceil(disp.w || 0), Math.ceil(disp.h || 0));
  if (!conv) return null;
  if (isSvg) conv.svg = buf.toString('utf8');
  // Natural size used for CSS layout: bitmap pixels (or SVG intrinsic size).
  return conv;
}

module.exports = {
  capture, captureHtml, capturePage, openUrl, settle, afterAction, trackResponses, trackNavigation, applyViewport, userAgentFor,
  resolveViewport, normalizeUrl, getBrowser, closeBrowser, VIEWPORTS, findChrome,
};
