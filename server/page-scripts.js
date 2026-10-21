'use strict';
// Functions evaluated inside the captured page (serialized by puppeteer).
// They must be self-contained: no closures over Node variables.

/** Freeze animations, force lazy content and reveal-on-scroll elements. */
async function preparePage() {
  const css = `
    *, *::before, *::after {
      transition-duration: 0s !important; transition-delay: 0s !important;
      animation-duration: 0s !important; animation-delay: 0s !important;
      animation-iteration-count: 1 !important; caret-color: transparent !important;
    }
    html { scroll-behavior: auto !important; }
    /* Odoo website on-scroll animations */
    .o_animate { visibility: visible !important; animation-name: none !important; opacity: 1 !important; transform: none !important; }
    .o_animate_preview { visibility: visible !important; }
    /* Common reveal-on-scroll libraries */
    [data-aos] { opacity: 1 !important; transform: none !important; }
    .wow { visibility: visible !important; }
    .animate__animated { animation-name: none !important; }
  `;
  if (!document.querySelector('style[data-o2f="prepare"]')) {
    const style = document.createElement('style');
    style.setAttribute('data-o2f', 'prepare');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  for (const img of document.querySelectorAll('img')) {
    if (img.loading === 'lazy') img.loading = 'eager';
    const ds = img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
    const src = img.getAttribute('src') || '';
    if (ds && (!src || src.startsWith('data:') || /placeholder|blank|spacer/.test(src))) img.setAttribute('src', ds);
    const dss = img.getAttribute('data-srcset');
    if (dss && !img.getAttribute('srcset')) img.setAttribute('srcset', dss);
  }
  for (const el of document.querySelectorAll('[data-bg], [data-background-image]')) {
    const u = el.getAttribute('data-bg') || el.getAttribute('data-background-image');
    if (u && !el.style.backgroundImage) el.style.backgroundImage = `url("${u}")`;
  }
  for (const f of document.querySelectorAll('iframe[loading=lazy]')) f.loading = 'eager';
  return true;
}

/**
 * Scroll through the whole page so lazy images and on-scroll scripts run, then
 * come back to `restoreY` (top of the page when omitted). Reveal-on-scroll
 * libraries (GSAP ScrollTrigger, IntersectionObserver…) only start their
 * animations once an element has entered the viewport.
 */
async function scrollThrough(maxHeight, restoreY) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const docH = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  const step = Math.max(200, Math.floor(window.innerHeight * 0.85));
  let y = 0;
  const start = Date.now();
  while (y < docH() && y < maxHeight && Date.now() - start < 20000) {
    window.scrollTo(0, y);
    await sleep(140);
    y += step;
  }
  window.scrollTo(0, docH());
  await sleep(300);
  window.scrollTo(0, restoreY || 0);
  await sleep(400);
  window.__o2fScrolled = true;
  return docH();
}

/**
 * Jump every finite JS-driven animation to its final state (GSAP tweens and
 * timelines, Web Animations API), so the export shows the content as it looks
 * once revealed instead of mid-fade. CSS animations are already neutralized by
 * preparePage. Looping and scroll-scrubbed animations are left untouched.
 */
async function settleAnimations() {
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const finite = (a) => {
    try { return a.repeat() !== -1 && isFinite(a.totalDuration()); } catch (e) { return false; }
  };
  const finish = (a) => {
    if (!finite(a) || (a.progress() === 1 && !a.reversed())) return 0;
    try { a.reversed(false); a.progress(1); return 1; } catch (e) { return 0; }
  };
  for (let pass = 0; pass < 3; pass++) {
    let done = 0;
    // The page has been scrolled through: every reveal-on-scroll animation
    // (even one reversed when scrolling back up) is shown in its end state.
    const ST = window.ScrollTrigger;
    if (ST && ST.getAll) {
      for (const t of ST.getAll()) {
        if (t.animation && !(t.vars && t.vars.scrub)) done += finish(t.animation);
      }
    }
    const g = window.gsap;
    if (g && g.globalTimeline && g.globalTimeline.getChildren) {
      for (const a of g.globalTimeline.getChildren(false, true, true)) {
        if (a.scrollTrigger || a.paused() || a.reversed()) continue; // handled above / hover in/out…
        done += finish(a);
      }
    }
    if (document.getAnimations) {
      for (const a of document.getAnimations()) {
        try {
          if (a.playState === 'finished' || a.playState === 'paused') continue;
          if (a.timeline && a.timeline !== document.timeline) continue; // scroll/view timelines
          const end = a.effect && a.effect.getComputedTiming().endTime;
          if (end == null || !isFinite(end)) continue;
          a.finish(); done++;
        } catch (e) { /* ignore */ }
      }
    }
    await frame(); await frame();
    // Completing a tween can start chained ones (onComplete → next tween).
    if (!done) break;
  }
  return true;
}

/** Wait for images and fonts. */
async function waitForAssets(timeout) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const imgs = Array.from(document.images).filter((i) => !i.complete);
  await Promise.race([
    Promise.all(imgs.map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))),
    sleep(timeout),
  ]);
  await Promise.race([document.fonts ? document.fonts.ready : Promise.resolve(), sleep(timeout)]);
  await Promise.all(Array.from(document.images).map((i) => (i.decode ? i.decode().catch(() => {}) : null)));
  return true;
}

/**
 * Tag elements that need extra data and serialize inline SVGs with computed styles.
 * Returns { svgs: {key: markup} }.
 */
async function annotatePage() {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const STYLE_PROPS = [
    'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
    'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity',
    'clip-rule', 'stop-color', 'stop-opacity', 'font-family', 'font-size', 'font-weight', 'font-style',
    'text-anchor', 'dominant-baseline', 'letter-spacing', 'visibility', 'mix-blend-mode',
  ];
  const NON_RENDERED = new Set(['defs', 'symbol', 'clippath', 'mask', 'lineargradient', 'radialgradient', 'stop', 'pattern', 'filter', 'marker', 'title', 'desc', 'metadata', 'style']);
  const spriteCache = new Map();

  async function loadSprite(url) {
    if (spriteCache.has(url)) return spriteCache.get(url);
    const p = fetch(url, { credentials: 'include' })
      .then((r) => (r.ok ? r.text() : ''))
      .then((t) => (t ? new DOMParser().parseFromString(t, 'image/svg+xml') : null))
      .catch(() => null);
    spriteCache.set(url, p);
    return p;
  }

  function copyStyles(orig, clone) {
    const origEls = [orig, ...orig.querySelectorAll('*')];
    const cloneEls = [clone, ...clone.querySelectorAll('*')];
    const remove = [];
    for (let i = 0; i < origEls.length && i < cloneEls.length; i++) {
      const o = origEls[i], c = cloneEls[i];
      const tag = o.tagName.toLowerCase();
      if (tag === 'style' || tag === 'script' || tag === 'foreignobject') { remove.push(c); continue; }
      let cs;
      try { cs = getComputedStyle(o); } catch (e) { continue; }
      if (cs.display === 'none' && !NON_RENDERED.has(tag) && i > 0) { remove.push(c); continue; }
      const decl = [];
      for (const p of STYLE_PROPS) {
        const v = cs.getPropertyValue(p);
        if (v && v !== 'normal' && !(p === 'visibility' && v === 'visible')) decl.push(`${p}:${v}`);
      }
      if (i === 0) decl.push('overflow:visible');
      c.setAttribute('style', decl.join(';'));
      c.removeAttribute('class');
    }
    remove.forEach((n) => n.remove());
  }

  async function resolveUses(orig, clone) {
    const uses = Array.from(clone.querySelectorAll('use'));
    const origUses = Array.from(orig.querySelectorAll('use'));
    for (let i = 0; i < uses.length; i++) {
      const u = uses[i];
      const href = u.getAttribute('href') || u.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
      const hashAt = href.indexOf('#');
      if (hashAt < 0) continue;
      const id = href.slice(hashAt + 1);
      let ref = null;
      if (hashAt === 0) ref = document.getElementById(id);
      else {
        const url = new URL(href.slice(0, hashAt), document.baseURI).href;
        const d = await loadSprite(url);
        ref = d ? d.getElementById(id) : null;
      }
      if (!ref) continue;
      const g = document.createElementNS(SVG_NS, 'g');
      const ou = origUses[i];
      if (ou) {
        const cs = getComputedStyle(ou);
        g.setAttribute('style', ['fill', 'stroke', 'stroke-width', 'color', 'opacity'].map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';'));
      }
      const x = parseFloat(u.getAttribute('x') || '0'), y = parseFloat(u.getAttribute('y') || '0');
      let tr = `translate(${x} ${y})`;
      const vb = ref.getAttribute && ref.getAttribute('viewBox');
      if (vb && ref.tagName.toLowerCase() === 'symbol') {
        const [vx, vy, vw, vh] = vb.split(/[\s,]+/).map(parseFloat);
        const ovb = orig.viewBox && orig.viewBox.baseVal && orig.viewBox.baseVal.width ? orig.viewBox.baseVal : null;
        const w = parseFloat(u.getAttribute('width')) || (ovb ? ovb.width : orig.getBoundingClientRect().width) || vw;
        const h = parseFloat(u.getAttribute('height')) || (ovb ? ovb.height : orig.getBoundingClientRect().height) || vh;
        const s = Math.min(w / vw, h / vh);
        tr += ` translate(${(w - vw * s) / 2 - vx * s} ${(h - vh * s) / 2 - vy * s}) scale(${s})`;
      }
      g.setAttribute('transform', tr);
      const src = ref.tagName.toLowerCase() === 'symbol' ? Array.from(ref.childNodes) : [ref];
      for (const n of src) {
        const cn = n.cloneNode(true);
        if (cn.nodeType === 1 && n.ownerDocument === document) copyStyles(n, cn);
        if (cn.nodeType === 1 && cn.removeAttribute) cn.removeAttribute('id');
        g.appendChild(document.importNode(cn, true));
      }
      u.replaceWith(g);
    }
  }

  const svgs = {};
  let k = 0;
  const roots = Array.from(document.querySelectorAll('svg')).filter((s) => !(s.parentElement && s.parentElement.closest('svg')));
  for (const svg of roots) {
    const r = svg.getBoundingClientRect();
    if (r.width < 0.5 || r.height < 0.5) continue;
    const key = 's' + k++;
    svg.setAttribute('data-o2f-svg', key);
    try {
      const clone = svg.cloneNode(true);
      copyStyles(svg, clone);
      await resolveUses(svg, clone);
      clone.removeAttribute('data-o2f-svg');
      clone.setAttribute('xmlns', SVG_NS);
      if (!clone.getAttribute('viewBox')) {
        const w0 = svg.width && svg.width.baseVal ? svg.width.baseVal.value : r.width;
        const h0 = svg.height && svg.height.baseVal ? svg.height.baseVal.value : r.height;
        if (w0 && h0) clone.setAttribute('viewBox', `0 0 ${w0} ${h0}`);
      }
      clone.setAttribute('width', String(Math.round(r.width * 100) / 100));
      clone.setAttribute('height', String(Math.round(r.height * 100) / 100));
      for (const img of clone.querySelectorAll('image')) {
        const h = img.getAttribute('href') || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
        if (h && !h.startsWith('data:')) img.setAttribute('href', new URL(h, document.baseURI).href);
      }
      svgs[key] = new XMLSerializer().serializeToString(clone);
    } catch (e) {
      // leave unserialized; the server will fall back to a screenshot
    }
  }

  // Placeholder colors for form fields
  for (const el of document.querySelectorAll('input[placeholder], textarea[placeholder]')) {
    try { el.setAttribute('data-o2f-phc', getComputedStyle(el, '::placeholder').color); } catch (e) { /* ignore */ }
  }

  // Rotated elements (ribbons, badges…) are captured upright so their content
  // keeps exact, editable geometry; the rotation is re-applied to the Figma frame.
  // data-o2f-xf = "angle(rad),dx,dy" where (dx, dy) moves the upright center to
  // the rotated one. Undone by restorePage.
  for (const el of document.querySelectorAll('body *')) {
    if (el.hasAttribute('data-o2f-xf') || el.closest('svg')) continue;
    let cs;
    try { cs = getComputedStyle(el); } catch (e) { continue; }
    const t = cs.transform;
    if (!t || t === 'none' || cs.display === 'none') continue;
    const m = /^matrix\(([^)]+)\)$/.exec(t);
    if (!m) continue;
    const [a, b, c, d, e, f] = m[1].split(',').map(parseFloat);
    if (Math.abs(b) < 0.001 && Math.abs(c) < 0.001) continue; // no rotation
    const sx = Math.hypot(a, b), sy = Math.hypot(c, d);
    if (Math.abs(sx - 1) > 0.02 || Math.abs(sy - 1) > 0.02) continue; // scaled/skewed: keep the old path
    const w = el.offsetWidth, h = el.offsetHeight;
    if (!w || !h) continue;
    const [ox, oy] = cs.transformOrigin.split(' ').map(parseFloat);
    const cx = w / 2 - ox, cy = h / 2 - oy;
    const dx = ox + a * cx + c * cy + e - w / 2;
    const dy = oy + b * cx + d * cy + f - h / 2;
    el.setAttribute('data-o2f-xf', `${Math.atan2(b, a)},${dx},${dy}`);
    el.setAttribute('data-o2f-xf-prev', `${el.style.getPropertyValue('transform')}|${el.style.getPropertyPriority('transform')}`);
    el.style.setProperty('transform', 'none', 'important');
  }

  // Chart.js canvases → vector SVG (bars, lines, arcs, axes, grid, legend).
  // Falls back to the canvas pixels when anything is not understood.
  let ck = 0;
  for (const canvas of document.querySelectorAll('canvas')) {
    try {
      const Chart = window.Chart;
      const chart = Chart && Chart.getChart ? Chart.getChart(canvas) : null;
      if (!chart) continue;
      const svg = chartToSvg(chart, canvas);
      if (!svg) continue;
      const key = 'c' + ck++;
      canvas.setAttribute('data-o2f-svg', key);
      svgs[key] = svg;
    } catch (e) { /* keep the pixels */ }
  }

  function chartToSvg(chart, canvas) {
    const r = canvas.getBoundingClientRect();
    const W = r.width, H = r.height;
    if (W < 2 || H < 2) return null;
    const k = W / (chart.width || W);
    const out = [];
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const col = (v) => (typeof v === 'string' ? v : null);
    const n = (v) => Math.round(v * k * 100) / 100;
    const helpers = Chart.helpers || {};
    const toFont = (f) => { try { return helpers.toFont ? helpers.toFont(f) : f || {}; } catch (e) { return f || {}; } };
    const text = (str, x, y, font, color, anchor, baseline, rot) => {
      const fo = toFont(font);
      const tr = rot ? ` transform="rotate(${(rot * 180) / Math.PI} ${n(x)} ${n(y)})"` : '';
      out.push(`<text x="${n(x)}" y="${n(y)}" font-family="${esc(fo.family || 'sans-serif')}" font-size="${n(fo.size || 12)}" font-weight="${fo.weight || 400}" fill="${esc(col(color) || '#666')}" text-anchor="${anchor}" dominant-baseline="${baseline}"${tr}>${esc(str)}</text>`);
    };
    // grid + ticks
    for (const id of Object.keys(chart.scales || {})) {
      const sc = chart.scales[id];
      if (!sc || !sc.options || sc.options.display === false) continue;
      try {
        for (const g of sc._computeGridLineItems ? sc._computeGridLineItems(chart.chartArea) : []) {
          if (!g.width || !col(g.color)) continue;
          out.push(`<line x1="${n(g.x1)}" y1="${n(g.y1)}" x2="${n(g.x2)}" y2="${n(g.y2)}" stroke="${esc(g.color)}" stroke-width="${n(g.width)}"/>`);
        }
      } catch (e) { /* no grid */ }
      try {
        for (const it of sc.getLabelItems ? sc.getLabelItems(chart.chartArea) : []) {
          const o = it.options || {};
          const [x, y] = o.translation || [0, 0];
          const lines = Array.isArray(it.label) ? it.label : [it.label];
          const fo = toFont(it.font);
          const lh = fo.lineHeight || (fo.size || 12) * 1.2;
          const anchor = o.textAlign === 'right' || o.textAlign === 'end' ? 'end' : o.textAlign === 'center' ? 'middle' : 'start';
          const base = o.textBaseline === 'middle' ? 'middle' : o.textBaseline === 'bottom' ? 'text-after-edge' : 'text-before-edge';
          lines.forEach((ln, i) => {
            const off = (it.textOffset || 0) + i * lh;
            const cos = Math.cos(o.rotation || 0), sin = Math.sin(o.rotation || 0);
            text(ln, x - sin * off, y + cos * off, it.font, o.color || it.color, anchor, base, o.rotation || 0);
          });
        }
      } catch (e) { /* no labels */ }
    }
    // datasets
    const area = chart.chartArea || { left: 0, top: 0, right: W, bottom: H };
    (chart.data.datasets || []).forEach((ds, i) => {
      const meta = chart.getDatasetMeta(i);
      if (!meta || meta.hidden || !chart.isDatasetVisible(i)) return;
      const els = meta.data || [];
      if (meta.type === 'bar') {
        for (const el of els) {
          const p = el.getProps(['x', 'y', 'base', 'width', 'height', 'horizontal'], true);
          const o = el.options || {};
          let x0, y0, w, h;
          if (p.horizontal) { x0 = Math.min(p.x, p.base); w = Math.abs(p.x - p.base); y0 = p.y - p.height / 2; h = p.height; }
          else { y0 = Math.min(p.y, p.base); h = Math.abs(p.y - p.base); x0 = p.x - p.width / 2; w = p.width; }
          const rr = typeof o.borderRadius === 'number' ? o.borderRadius : 0;
          out.push(`<rect x="${n(x0)}" y="${n(y0)}" width="${n(w)}" height="${n(h)}"${rr ? ` rx="${n(rr)}"` : ''} fill="${esc(col(o.backgroundColor) || '#999')}"${o.borderWidth && col(o.borderColor) ? ` stroke="${esc(o.borderColor)}" stroke-width="${n(typeof o.borderWidth === 'number' ? o.borderWidth : 1)}"` : ''}/>`);
        }
      } else if (meta.type === 'line') {
        const pts = els.map((el) => el.getProps(['x', 'y', 'cp1x', 'cp1y', 'cp2x', 'cp2y'], true)).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
        if (!pts.length) return;
        const o = (meta.dataset && meta.dataset.options) || {};
        const curve = (o.tension || 0) > 0;
        let d = `M ${n(pts[0].x)} ${n(pts[0].y)}`;
        for (let j = 1; j < pts.length; j++) {
          const a0 = pts[j - 1], a1 = pts[j];
          d += curve && Number.isFinite(a0.cp2x) ? ` C ${n(a0.cp2x)} ${n(a0.cp2y)} ${n(a1.cp1x)} ${n(a1.cp1y)} ${n(a1.x)} ${n(a1.y)}` : ` L ${n(a1.x)} ${n(a1.y)}`;
        }
        if (o.fill && col(o.backgroundColor)) {
          const yb = meta.vScale ? Math.min(area.bottom, meta.vScale.getBasePixel()) : area.bottom;
          out.push(`<path d="${d} L ${n(pts[pts.length - 1].x)} ${n(yb)} L ${n(pts[0].x)} ${n(yb)} Z" fill="${esc(o.backgroundColor)}"/>`);
        }
        if (col(o.borderColor)) out.push(`<path d="${d}" fill="none" stroke="${esc(o.borderColor)}" stroke-width="${n(o.borderWidth || 1)}" stroke-linejoin="round" stroke-linecap="round"/>`);
        for (const el of els) {
          const po = el.options || {};
          if (!(po.radius > 0)) continue;
          out.push(`<circle cx="${n(el.x)}" cy="${n(el.y)}" r="${n(po.radius)}" fill="${esc(col(po.backgroundColor) || col(o.borderColor) || '#999')}"${po.borderWidth && col(po.borderColor) ? ` stroke="${esc(po.borderColor)}" stroke-width="${n(po.borderWidth)}"` : ''}/>`);
        }
      } else if (meta.type === 'pie' || meta.type === 'doughnut' || meta.type === 'polarArea') {
        for (const el of els) {
          const p = el.getProps(['x', 'y', 'startAngle', 'endAngle', 'innerRadius', 'outerRadius'], true);
          const o = el.options || {};
          const sweep = p.endAngle - p.startAngle;
          if (!(sweep > 0)) continue;
          const pt = (rad, ang) => [p.x + rad * Math.cos(ang), p.y + rad * Math.sin(ang)];
          const large = sweep > Math.PI ? 1 : 0;
          let d;
          if (sweep >= Math.PI * 2 - 1e-6) {
            const R = p.outerRadius;
            d = `M ${n(p.x - R)} ${n(p.y)} A ${n(R)} ${n(R)} 0 1 1 ${n(p.x + R)} ${n(p.y)} A ${n(R)} ${n(R)} 0 1 1 ${n(p.x - R)} ${n(p.y)} Z`;
          } else {
            const [ax, ay] = pt(p.outerRadius, p.startAngle), [bx, by] = pt(p.outerRadius, p.endAngle);
            d = `M ${n(ax)} ${n(ay)} A ${n(p.outerRadius)} ${n(p.outerRadius)} 0 ${large} 1 ${n(bx)} ${n(by)}`;
            if (p.innerRadius > 0) {
              const [cx2, cy2] = pt(p.innerRadius, p.endAngle), [dx2, dy2] = pt(p.innerRadius, p.startAngle);
              d += ` L ${n(cx2)} ${n(cy2)} A ${n(p.innerRadius)} ${n(p.innerRadius)} 0 ${large} 0 ${n(dx2)} ${n(dy2)} Z`;
            } else d += ` L ${n(p.x)} ${n(p.y)} Z`;
          }
          out.push(`<path d="${d}" fill="${esc(col(o.backgroundColor) || '#999')}"${o.borderWidth && col(o.borderColor) ? ` stroke="${esc(o.borderColor)}" stroke-width="${n(o.borderWidth)}"` : ''}/>`);
        }
      } else throw new Error('unsupported chart type');
    });
    // legend
    const lg = chart.legend;
    if (lg && lg.options && lg.options.display !== false && lg.legendHitBoxes && lg.legendItems) {
      const lo = lg.options.labels || {};
      const fo = toFont(lo.font);
      const bw = lo.boxWidth || 40, bh = Math.min(lo.boxHeight || fo.size || 12, fo.size || 12);
      lg.legendItems.forEach((it, i) => {
        const hb = lg.legendHitBoxes[i];
        if (!hb) return;
        const by = hb.top + (hb.height - bh) / 2;
        out.push(`<rect x="${n(hb.left)}" y="${n(by)}" width="${n(bw)}" height="${n(bh)}" fill="${esc(col(it.fillStyle) || '#999')}"${it.lineWidth && col(it.strokeStyle) ? ` stroke="${esc(it.strokeStyle)}" stroke-width="${n(it.lineWidth)}"` : ''}/>`);
        text(it.text, hb.left + bw + (fo.size || 12) / 2, hb.top + hb.height / 2, lo.font, lo.color || it.fontColor || (Chart.defaults && Chart.defaults.color), 'start', 'middle', 0);
      });
    }
    if (!out.length) return null;
    return `<svg xmlns="${SVG_NS}" width="${Math.round(W * 100) / 100}" height="${Math.round(H * 100) / 100}" viewBox="0 0 ${Math.round(W * 100) / 100} ${Math.round(H * 100) / 100}">${out.join('')}</svg>`;
  }
  return { svgs };
}

/** Render icon-font glyphs to transparent PNGs. reqs: [{id, text, font, color, w, h}] */
async function renderIcons(reqs, scale) {
  const out = {};
  for (const r of reqs) {
    try {
      if (document.fonts && document.fonts.load) await document.fonts.load(r.font, r.text).catch(() => {});
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.ceil(r.w * scale));
      c.height = Math.max(1, Math.ceil(r.h * scale));
      const ctx = c.getContext('2d');
      ctx.scale(scale, scale);
      ctx.font = r.font;
      ctx.fillStyle = r.color;
      ctx.textBaseline = 'alphabetic';
      if (r.letterSpacing && 'letterSpacing' in ctx) ctx.letterSpacing = r.letterSpacing;
      const m = ctx.measureText(r.text);
      const asc = m.fontBoundingBoxAscent != null ? m.fontBoundingBoxAscent : r.h * 0.8;
      const desc = m.fontBoundingBoxDescent != null ? m.fontBoundingBoxDescent : r.h * 0.2;
      const top = (r.h - (asc + desc)) / 2;
      ctx.fillText(r.text, 0, top + asc);
      out[r.id] = c.toDataURL('image/png').split(',')[1];
    } catch (e) { /* skip */ }
  }
  return out;
}

/** Show only the element tagged data-o2f-shot~=id (or restore the page when id is null). */
function isolateShot(id, pseudo) {
  let st = document.getElementById('o2f-shot-style');
  if (!st) {
    st = document.createElement('style');
    st.id = 'o2f-shot-style';
    document.documentElement.appendChild(st);
  }
  if (!id) { st.textContent = ''; return true; }
  const sel = `[data-o2f-shot~="${id}"]`;
  const show = pseudo
    ? `${sel}::${pseudo}`
    : `${sel}, ${sel} *, ${sel}::before, ${sel}::after, ${sel} *::before, ${sel} *::after`;
  st.textContent = `
    *, *::before, *::after { visibility: hidden !important; }
    html, body { background: transparent !important; }
    ${show} { visibility: visible !important; }`;
  return true;
}

/**
 * Lay repeated-gradient tiles out on top of a transparent page so each can be
 * screenshotted. reqs: [{id, css, w, h, ox, oy}] → {id: {x, y, w, h}} in
 * document coordinates. Removed with removePatterns.
 */
function layoutPatterns(reqs) {
  window.scrollTo(0, 0);
  const style = document.createElement('style');
  style.id = 'o2f-patterns-style';
  style.textContent = `
    html { background: transparent !important; background-image: none !important; }
    html::before, html::after { display: none !important; }
    body { opacity: 0 !important; background: transparent !important; background-image: none !important; }
    #o2f-patterns { position: absolute; left: 0; top: 0; width: 100%; z-index: 2147483647; opacity: 1 !important; pointer-events: none; }
    #o2f-patterns > div { position: absolute; margin: 0; padding: 0; border: 0; background-repeat: repeat; }`;
  const box = document.createElement('div');
  box.id = 'o2f-patterns';
  document.documentElement.appendChild(style);
  document.documentElement.appendChild(box);
  const W = document.documentElement.clientWidth;
  const pos = {};
  let x = 0, y = 0, rowH = 0;
  for (const r of reqs) {
    const w = Math.ceil(r.w), h = Math.ceil(r.h);
    if (x + w > W) { x = 0; y += rowH + 4; rowH = 0; }
    const d = document.createElement('div');
    d.style.left = x + 'px'; d.style.top = y + 'px';
    d.style.width = r.w + 'px'; d.style.height = r.h + 'px';
    d.style.backgroundImage = r.css;
    d.style.backgroundSize = `${r.w}px ${r.h}px`;
    d.style.backgroundPosition = `${r.ox}px ${r.oy}px`;
    box.appendChild(d);
    pos[r.id] = { x, y, w: r.w, h: r.h };
    x += w + 4; rowH = Math.max(rowH, h);
  }
  return pos;
}

function removePatterns() {
  document.querySelectorAll('#o2f-patterns, #o2f-patterns-style').forEach((n) => n.remove());
  return true;
}

/**
 * Lay icon glyphs out in an overlay on top of a transparent page so they can be
 * screenshotted with the real text engine (OpenType features, ligatures, color fonts).
 * reqs: [{id, text, css, w, h}] → {id: {x, y, w, h}} in document coordinates.
 */
async function layoutIcons(reqs) {
  window.scrollTo(0, 0);
  const style = document.createElement('style');
  style.setAttribute('data-o2f', 'icons');
  style.textContent = `
    html { background: transparent !important; background-image: none !important; }
    html::before, html::after { display: none !important; }
    body { opacity: 0 !important; background: transparent !important; background-image: none !important; }
    #o2f-icons { position: absolute; left: 0; top: 0; width: 100%; z-index: 2147483647; opacity: 1 !important; pointer-events: none; }
    #o2f-icons > span { position: absolute; display: block; white-space: pre; margin: 0; padding: 0; border: 0; background: transparent; text-shadow: none; overflow: visible; }`;
  const box = document.createElement('div');
  box.id = 'o2f-icons';
  document.documentElement.appendChild(style);
  document.documentElement.appendChild(box);
  const W = document.documentElement.clientWidth;
  const pos = {};
  let x = 0, y = 0, rowH = 0;
  for (const r of reqs) {
    const w = Math.ceil(r.w) + 4, h = Math.ceil(r.h) + 4;
    if (x + w > W) { x = 0; y += rowH; rowH = 0; }
    const s = document.createElement('span');
    s.textContent = r.text;
    Object.assign(s.style, r.css, { left: x + 2 + 'px', top: y + 2 + 'px', width: r.w + 'px', height: r.h + 'px', lineHeight: r.h + 'px' });
    box.appendChild(s);
    pos[r.id] = { x: x + 2, y: y + 2, w: r.w, h: r.h };
    x += w;
    rowH = Math.max(rowH, h);
  }
  if (document.fonts) await document.fonts.ready;
  await new Promise((res) => setTimeout(res, 120));
  return pos;
}

/** Undo everything a capture changed on the page (used by Claude sessions). */
function restorePage(scroll) {
  const ov = document.getElementById('o2f-icons');
  if (ov) ov.remove();
  document.querySelectorAll('style[data-o2f="icons"], #o2f-shot-style, #o2f-patterns, #o2f-patterns-style').forEach((n) => n.remove());
  document.querySelectorAll('[data-o2f-target]').forEach((e) => e.removeAttribute('data-o2f-target'));
  // Rotations neutralized by annotatePage
  document.querySelectorAll('[data-o2f-xf]').forEach((e) => {
    const [v, prio] = (e.getAttribute('data-o2f-xf-prev') || '|').split('|');
    if (v) e.style.setProperty('transform', v, prio || ''); else e.style.removeProperty('transform');
    e.removeAttribute('data-o2f-xf');
    e.removeAttribute('data-o2f-xf-prev');
  });
  if (scroll) window.scrollTo(scroll[0], scroll[1]);
  return true;
}

/**
 * Describe the page for Claude: open dialogs/menus and interactive elements,
 * each tagged with a reference (data-o2f-ref) usable by click / type / export.
 */
function describePage(opts) {
  const max = opts.max || 150;
  const all = !!opts.all;
  document.querySelectorAll('[data-o2f-ref]').forEach((e) => e.removeAttribute('data-o2f-ref'));
  const vw = window.innerWidth, vh = window.innerHeight;
  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) return null;
    if (!all && (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw)) return null;
    return r;
  };
  const box = (r) => [r.x, r.y + window.scrollY, r.width, r.height].map(Math.round);
  const DIALOG = 'dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true], .modal.show, .o_dialog, .popover.show, .o_popover, .dropdown-menu.show, .o-dropdown--menu, .offcanvas.show, .o_notification';
  let k = 0;
  const dialogs = [];
  for (const d of document.querySelectorAll(DIALOG)) {
    const r = shown(d);
    if (!r || d.closest('[data-o2f-ref]')) continue;
    const ref = 'd' + ++k;
    d.setAttribute('data-o2f-ref', ref);
    const inner = d.querySelector('.modal-content, .o_dialog_container .modal-content, .popover-body');
    let content = null;
    if (inner && inner !== d && shown(inner)) { content = 'd' + ++k; inner.setAttribute('data-o2f-ref', content); }
    const t = d.querySelector('.modal-title, [role=heading], h1, h2, h3, header');
    dialogs.push({ ref, content, kind: d.getAttribute('role') || d.tagName.toLowerCase() + (d.classList[0] ? '.' + d.classList[0] : ''), title: clean(t && t.innerText).slice(0, 80), box: box(inner && content ? inner.getBoundingClientRect() : r) });
  }
  const SEL = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary', 'label[for]',
    '[role=button]', '[role=link]', '[role=tab]', '[role=menuitem]', '[role=menuitemradio]', '[role=menuitemcheckbox]',
    '[role=option]', '[role=checkbox]', '[role=switch]', '[role=radio]', '[role=treeitem]', '[onclick]', '[contenteditable=true]',
    '.dropdown-toggle', '.nav-link', '.dropdown-item', '.o_menu_item', '.o_switch_view', '.o_data_row', '.o_kanban_record',
  ].join(',');
  const elements = [];
  const listed = new Set();
  let truncated = false;
  for (const el of document.querySelectorAll(SEL)) {
    const r = shown(el);
    if (!r) continue;
    const parent = el.parentElement && el.parentElement.closest(SEL);
    if (parent && listed.has(parent) && clean(parent.innerText) === clean(el.innerText)) continue;
    if (elements.length >= max) { truncated = true; break; }
    const ref = 'e' + ++k;
    el.setAttribute('data-o2f-ref', ref);
    listed.add(el);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || { a: 'link', button: 'button', input: 'input', select: 'select', textarea: 'textarea', summary: 'summary', label: 'label' }[tag] || 'clickable';
    const img = el.querySelector('img[alt]');
    let name = el.getAttribute('aria-label') || el.getAttribute('title') || clean(el.innerText) || el.getAttribute('placeholder') || el.getAttribute('alt') || (img && img.alt) || el.getAttribute('name') || '';
    name = clean(name).slice(0, 80);
    const it = { ref, role, name };
    if (tag === 'a') it.href = el.getAttribute('href');
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      it.type = el.type || tag;
      it.value = el.type === 'password' ? (el.value ? '••••' : '') : clean(String(el.value || '')).slice(0, 60);
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') it.disabled = true;
    if (el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current') || el.classList.contains('active') || el.checked) it.active = true;
    if (el.hasAttribute('aria-expanded')) it.expanded = el.getAttribute('aria-expanded') === 'true';
    const dlg = el.closest(DIALOG);
    if (dlg && dlg.getAttribute('data-o2f-ref')) it.in = dlg.getAttribute('data-o2f-ref');
    it.box = box(r);
    elements.push(it);
  }
  return {
    url: location.href, title: document.title, viewport: [vw, vh], scroll: [Math.round(window.scrollX), Math.round(window.scrollY)],
    height: Math.round(document.documentElement.scrollHeight), dialogs, elements, truncated,
  };
}

/** Decode any browser-supported image and re-encode it as PNG/JPEG within maxDim. */
async function convertImage(b64, mime, maxDim, minW, minH) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let w = img.naturalWidth || minW || 300, h = img.naturalHeight || minH || 150;
    const isSvg = /svg/.test(mime || '');
    if (isSvg) {
      // Vector images are rasterized sharply (4× their displayed size)
      const target = Math.max(minW || 0, minH || 0, 64) * 4;
      const k = Math.max(1, target / Math.max(w, h));
      w *= k; h *= k;
    }
    const k = Math.min(1, maxDim / Math.max(w, h));
    w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    // PNG: lossless, the decoded pixels are kept exactly as they are.
    const out = c.toDataURL('image/png');
    return { b64: out.split(',')[1], w, h, natW: img.naturalWidth || w, natH: img.naturalHeight || h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

module.exports = {
  preparePage, scrollThrough, settleAnimations, waitForAssets, annotatePage, renderIcons, layoutIcons, isolateShot, restorePage, layoutPatterns, removePatterns, describePage, convertImage,
};
