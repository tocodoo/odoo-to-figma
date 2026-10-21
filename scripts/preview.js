'use strict';
// Debug tool: renders a capture (IR) back to HTML with Figma semantics and
// screenshots it next to the original page, to check fidelity.
// Usage: node scripts/preview.js <capture.json> <out-prefix> [--original]

const fs = require('fs');
const { getBrowser } = require('../server/capture');

function renderer() {
  /* runs in the browser */
  const GENERIC = /^(sans-serif|serif|monospace|system-ui|-apple-system|blinkmacsystemfont|cursive|fantasy|ui-sans-serif|ui-serif|ui-monospace)$/i;
  function rgba(c, o) { return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a != null ? c.a * (o == null ? 1 : o) : o == null ? 1 : o})`; }
  function inv(t) {
    const [[a, b, c], [d, e, f]] = t;
    const det = a * e - b * d || 1e-9;
    const ia = e / det, ib = -b / det, id = -d / det, ie = a / det;
    return [[ia, ib, -(ia * c + ib * f)], [id, ie, -(id * c + ie * f)]];
  }
  const ap = (m, x, y) => [m[0][0] * x + m[0][1] * y + m[0][2], m[1][0] * x + m[1][1] * y + m[1][2]];
  function paintCss(p, W, H, images) {
    if (p.type === 'SOLID') { const c = rgba(p.color, p.opacity); return `linear-gradient(${c},${c})`; }
    if (p.type === 'IMAGE') {
      const src = images[p.id]; if (!src) return null;
      const url = `url(${src})`;
      if (p.scaleMode === 'FILL') return `${url} center / cover no-repeat`;
      if (p.scaleMode === 'FIT') return `${url} center / contain no-repeat`;
      if (p.scaleMode === 'TILE') return `${url} 0 0 / ${(p._w || 100) * p.sf}px auto repeat`;
      const t = p.t || [[1, 0, 0], [0, 1, 0]];
      const dw = W / t[0][0], dh = H / t[1][1];
      return `${url} ${-t[0][2] * dw}px ${-t[1][2] * dh}px / ${dw}px ${dh}px no-repeat`;
    }
    const m = inv(p.t);
    const stops = (fn) => p.stops.map((s) => `${rgba(s.color)} ${fn(s.position)}`).join(',');
    if (p.type === 'GRADIENT_LINEAR') {
      const [n0x, n0y] = ap(m, 0, 0.5), [n1x, n1y] = ap(m, 1, 0.5);
      const P0 = [n0x * W, n0y * H], P1 = [n1x * W, n1y * H];
      const dx = P1[0] - P0[0], dy = P1[1] - P0[1];
      const th = Math.atan2(dx, -dy);
      const dir = [Math.sin(th), -Math.cos(th)];
      const Lc = Math.abs(W * Math.sin(th)) + Math.abs(H * Math.cos(th)) || 1;
      const S = [W / 2 - dir[0] * Lc / 2, H / 2 - dir[1] * Lc / 2];
      return `linear-gradient(${th}rad, ${stops((q) => { const P = [P0[0] + q * dx, P0[1] + q * dy]; return (((P[0] - S[0]) * dir[0] + (P[1] - S[1]) * dir[1]) / Lc) * 100 + '%'; })})`;
    }
    if (p.type === 'GRADIENT_RADIAL') {
      const [cx, cy] = ap(m, 0.5, 0.5), [ex, ey] = ap(m, 1, 0.5), [fx, fy] = ap(m, 0.5, 1);
      const rx = Math.hypot((ex - cx) * W, (ey - cy) * H), ry = Math.hypot((fx - cx) * W, (fy - cy) * H);
      return `radial-gradient(${rx}px ${ry}px at ${cx * W}px ${cy * H}px, ${stops((q) => q * 100 + '%')})`;
    }
    return null;
  }
  window.renderIR = function (cap, images) {
    const root = document.getElementById('root');
    const styles = cap.styles;
    function box(el, n, parent) {
      el.style.position = 'absolute';
      el.style.left = (n.x - parent.x) + 'px';
      el.style.top = (n.y - parent.y) + 'px';
      el.style.width = n.w + 'px';
      el.style.height = n.h + 'px';
      if (n.opacity != null) el.style.opacity = n.opacity;
      if (n.rot) { el.style.transform = `translate(${n.rot.cx - n.x - n.w / 2}px, ${n.rot.cy - n.y - n.h / 2}px) rotate(${n.rot.a}rad)`; }
    }
    function frame(n, parent) {
      const el = document.createElement('div');
      box(el, n, parent);
      el.title = n.name;
      const bgs = (n.fills || []).map((p) => paintCss(p, n.w, n.h, images)).filter(Boolean).reverse();
      if (bgs.length) el.style.background = bgs.join(',');
      if (n.radii) el.style.borderRadius = n.radii.map((r) => r + 'px').join(' ');
      if (n.clip) el.style.overflow = 'hidden';
      if (n.strokes) {
        const c = rgba(n.strokes.paints[0].color, n.strokes.paints[0].opacity);
        if (n.strokes.align === 'OUTSIDE') el.style.outline = `${n.strokes.weights[0]}px solid ${c}`;
        else {
          el.style.boxSizing = 'border-box';
          el.style.borderStyle = n.strokes.dash ? 'dashed' : 'solid';
          el.style.borderColor = c;
          el.style.borderWidth = n.strokes.weights.map((w) => w + 'px').join(' ');
        }
      }
      effects(el, n.effects);
      if (n.blend) el.style.mixBlendMode = n.blend.toLowerCase().replace('_', '-');
      for (const c of n.children || []) el.appendChild(node(c, n));
      return el;
    }
    function effects(el, list) {
      if (!list) return;
      const sh = [], flt = [];
      for (const e of list) {
        if (e.type === 'DROP_SHADOW') sh.push(`${e.x}px ${e.y}px ${e.blur}px ${e.spread || 0}px ${rgba(e.c)}`);
        else if (e.type === 'INNER_SHADOW') sh.push(`inset ${e.x}px ${e.y}px ${e.blur}px ${e.spread || 0}px ${rgba(e.c)}`);
        else if (e.type === 'LAYER_BLUR') flt.push(`blur(${e.radius / 2}px)`);
        else if (e.type === 'BACKGROUND_BLUR') el.style.backdropFilter = `blur(${e.radius / 2}px)`;
      }
      if (sh.length) el.style.boxShadow = sh.join(',');
      if (flt.length) el.style.filter = flt.join(' ');
    }
    function text(n, parent) {
      const el = document.createElement('div');
      el.style.position = 'absolute';
      el.style.top = (n.y - parent.y) + 'px';
      el.style.lineHeight = n.lh + 'px';
      el.style.textAlign = n.align.toLowerCase().replace('justified', 'justify');
      if (n.mode === 'wrap') { el.style.left = (n.x - parent.x) + 'px'; el.style.width = n.w + 'px'; el.style.whiteSpace = 'normal'; }
      else {
        el.style.whiteSpace = 'pre';
        el.style.left = ((n.anchor === 'L' ? n.x : n.ax) - parent.x) + 'px';
        if (n.anchor === 'C') el.style.transform = 'translateX(-50%)';
        if (n.anchor === 'R') el.style.transform = 'translateX(-100%)';
      }
      for (const [s, e, si] of n.runs) {
        const st = styles[si];
        const sp = document.createElement('span');
        sp.textContent = n.chars.slice(s, e);
        sp.style.fontFamily = st.fam.map((f) => (GENERIC.test(f) ? f : `"${f}"`)).join(',');
        sp.style.fontWeight = st.w;
        sp.style.fontStyle = st.it ? 'italic' : 'normal';
        sp.style.fontSize = st.sz + 'px';
        if (st.c) sp.style.color = rgba(st.c);
        if (st.ls) sp.style.letterSpacing = st.ls + 'px';
        if (st.dec) sp.style.textDecoration = st.dec === 'UNDERLINE' ? 'underline' : 'line-through';
        el.appendChild(sp);
      }
      if (n.trunc) {
        el.style.transform = ''; el.style.left = (n.x - parent.x) + 'px'; el.style.width = n.trunc.w + 'px';
        el.style.whiteSpace = n.trunc.lines > 1 ? 'normal' : 'pre'; el.style.overflow = 'hidden'; el.style.textOverflow = 'ellipsis';
        if (n.trunc.lines > 1) { el.style.display = '-webkit-box'; el.style.webkitLineClamp = n.trunc.lines; el.style.webkitBoxOrient = 'vertical'; }
      }
      if (n.gradFill) {
        const bg = paintCss(n.gradFill, n.w, n.h, images);
        for (const sp of el.children) { sp.style.color = 'transparent'; }
        el.style.background = bg; el.style.webkitBackgroundClip = 'text'; el.style.backgroundClip = 'text';
      }
      if (n.effects) el.style.textShadow = n.effects.map((e) => `${e.x}px ${e.y}px ${e.blur}px ${rgba(e.c)}`).join(',');
      return el;
    }
    function svg(n, parent) {
      const el = document.createElement('div');
      box(el, n, parent);
      el.innerHTML = n.svg;
      const s = el.querySelector('svg');
      if (s) { s.style.display = 'block'; }
      return el;
    }
    function node(n, parent) { return n.type === 'TEXT' ? text(n, parent) : n.type === 'SVG' ? svg(n, parent) : frame(n, parent); }
    root.style.width = cap.root.w + 'px';
    root.style.height = cap.root.h + 'px';
    root.appendChild(frame(cap.root, { x: cap.root.x, y: cap.root.y }));
  };
}

async function main() {
  const [file, out, flag] = process.argv.slice(2);
  const cap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const images = {};
  for (const [id, b64] of Object.entries(cap.images)) images[id] = `data:${b64.startsWith('/9j') ? 'image/jpeg' : 'image/png'};base64,${b64}`;
  const fams = new Set();
  for (const st of cap.styles) for (const f of st.fam) if (!/^(sans-serif|serif|monospace|system-ui|-apple-system|BlinkMacSystemFont)$/i.test(f)) fams.add(f);
  const links = [...fams].map((f) => `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(f)}:ital,wght@0,100..900;1,100..900&display=block">`).join('');
  const browser = await getBrowser();
  const page = await browser.newPage();
  const W = cap.root.w, H = Math.min(cap.root.h, 16000);
  await page.setViewport({ width: W, height: 900, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><head>${links}<style>body{margin:0}#root{position:relative;overflow:hidden}</style></head><body><div id="root"></div></body></html>`, { waitUntil: 'networkidle0' });
  await page.evaluate(renderer);
  await page.evaluate((c, i) => window.renderIR(c, i), cap, images);
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: `${out}-preview.png`, clip: { x: 0, y: 0, width: W, height: H }, captureBeyondViewport: true });
  console.log('preview →', `${out}-preview.png`);
  if (flag === '--original') {
    const p2 = await browser.newPage();
    const vp = cap.meta.viewport;
    await p2.setUserAgent((await browser.userAgent()).replace('HeadlessChrome', 'Chrome'));
    await p2.setExtraHTTPHeaders({ 'Accept-Language': process.env.LANG_HDR || 'en-US,en;q=0.9' });
    await p2.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1, isMobile: vp.width < 1024 });
    await p2.goto(cap.meta.url, { waitUntil: ['load', 'networkidle2'], timeout: 45000 }).catch(() => {});
    const scripts = require('../server/page-scripts');
    await p2.evaluate(scripts.preparePage);
    await p2.evaluate(scripts.scrollThrough, 60000);
    await p2.evaluate(scripts.waitForAssets, 6000);
    await p2.evaluate(() => window.scrollTo(0, 0));
    await new Promise((r) => setTimeout(r, 500));
    await p2.screenshot({ path: `${out}-original.png`, clip: { x: 0, y: 0, width: W, height: H }, captureBeyondViewport: true });
    console.log('original →', `${out}-original.png`);
  }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
