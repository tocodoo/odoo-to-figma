'use strict';
// Vector icons for any icon font (Material Symbols, odoo_ui_icons, Font Awesome
// 5/6, Bootstrap Icons, custom fonts…). Finds the font file the page really uses
// (@font-face), parses it with fontkit (WOFF2/WOFF/TTF/OTF, ligatures, OpenType
// features, variable axes) and turns each rendered glyph into an SVG path.
// Icons that cannot be resolved keep the high-resolution picture fallback.

const fontkit = require('fontkit');
const { splitCommas } = require('./css');

const fontCache = new Map(); // font URL → Promise<fontkit font | null>
const cssCache = new Map(); // stylesheet URL → Promise<text>
const r2 = (v) => Math.round(v * 100) / 100;

/** Runs in the page: @font-face rules of readable stylesheets + URLs of the others. */
function collectFontFaces() {
  const faces = [];
  const remote = [];
  const visit = (rules, base, href) => {
    for (const r of rules) {
      if (r.type === 5 /* FONT_FACE_RULE */) {
        faces.push({
          family: r.style.getPropertyValue('font-family'), src: r.style.getPropertyValue('src'),
          weight: r.style.getPropertyValue('font-weight'), style: r.style.getPropertyValue('font-style'),
          range: r.style.getPropertyValue('unicode-range'), base,
        });
      } else if (r.type === 3 /* IMPORT_RULE */) {
        try { visit(r.styleSheet.cssRules, r.styleSheet.href || base); } catch (e) { if (r.href) remote.push(new URL(r.href, base).href); }
      } else if (r.cssRules) {
        visit(r.cssRules, base, href);
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try { visit(sheet.cssRules, sheet.href || document.baseURI); } catch (e) { if (sheet.href) remote.push(sheet.href); }
  }
  return { faces, remote };
}

function parseFontFaces(text, base) {
  const out = [];
  const re = /@font-face\s*\{([^}]*)\}/gi;
  let m;
  while ((m = re.exec(text))) {
    const body = m[1];
    const get = (p) => { const r = new RegExp(`(?:^|;|\\s)${p}\\s*:\\s*([^;]+)`, 'i').exec(body); return r ? r[1].trim() : ''; };
    out.push({ family: get('font-family'), src: get('src'), weight: get('font-weight'), style: get('font-style'), range: get('unicode-range'), base });
  }
  return out;
}

const unquote = (s) => String(s || '').trim().replace(/^["']|["']$/g, '');
const famKey = (s) => unquote(s).toLowerCase();

function srcUrls(src, base) {
  const out = [];
  for (const part of splitCommas(src || '')) {
    const u = /url\(\s*(['"]?)(.*?)\1\s*\)/i.exec(part);
    if (!u) continue;
    const fmt = (/format\(\s*['"]?([\w-]+)/i.exec(part) || [])[1] || '';
    const url = u[2];
    if (/embedded-opentype|svg/i.test(fmt) || /\.(eot|svg)(\?|#|$)/i.test(url)) continue;
    try { out.push(new URL(url, base).href); } catch (e) { /* ignore */ }
  }
  return out;
}

function rangeCovers(range, cp) {
  if (!range) return true;
  return splitCommas(range).some((r) => {
    const m = /^u\+([0-9a-f?]+)(?:-([0-9a-f]+))?$/i.exec(r.trim());
    if (!m) return false;
    if (m[1].includes('?')) {
      const lo = parseInt(m[1].replace(/\?/g, '0'), 16), hi = parseInt(m[1].replace(/\?/g, 'f'), 16);
      return cp >= lo && cp <= hi;
    }
    const lo = parseInt(m[1], 16), hi = m[2] ? parseInt(m[2], 16) : lo;
    return cp >= lo && cp <= hi;
  });
}

function weightDistance(faceWeight, want) {
  const ws = String(faceWeight || '400').replace('normal', '400').replace('bold', '700').split(/\s+/).map(Number).filter(Number.isFinite);
  if (!ws.length) return 0;
  const lo = Math.min(...ws), hi = Math.max(...ws);
  return want < lo ? lo - want : want > hi ? want - hi : 0;
}

async function download(url, ctx, cache, kind) {
  if (cache.has(url)) return cache.get(url);
  const p = (async () => {
    const hit = ctx.responses && ctx.responses.get(url);
    if (hit) { const r = await hit; if (r && r.buf) return r.buf; }
    const resp = await fetch(url, {
      headers: { 'User-Agent': ctx.userAgent || 'Mozilla/5.0', Referer: ctx.referer || url, Accept: kind === 'css' ? 'text/css,*/*;q=0.1' : '*/*' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  })().catch(() => null);
  cache.set(url, p);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return p;
}

async function loadFont(url, ctx) {
  const key = url;
  if (fontCache.has(key)) return fontCache.get(key);
  const p = (async () => {
    const buf = await download(url, ctx, new Map(), 'font');
    if (!buf) return null;
    let f = fontkit.create(buf);
    if (f && f.fonts) f = f.fonts[0];
    return f || null;
  })().catch(() => null);
  fontCache.set(key, p);
  if (fontCache.size > 60) fontCache.delete(fontCache.keys().next().value);
  return p;
}

function parseFeatures(v) {
  const out = {};
  if (!v || v === 'normal') return out;
  for (const part of splitCommas(v)) {
    const m = /["']([\w]{4})["']\s*(\w+)?/.exec(part);
    if (m) out[m[1]] = !(m[2] === '0' || m[2] === 'off');
  }
  return out;
}

function parseVariations(v) {
  const out = {};
  if (!v || v === 'normal') return out;
  for (const part of splitCommas(v)) {
    const m = /["']([\w]{4})["']\s+(-?[\d.]+)/.exec(part);
    if (m) out[m[1]] = parseFloat(m[2]);
  }
  return out;
}

/** SVG for one icon request {text, css, w, h}, or null. */
function glyphSvg(font, req, color) {
  let f = font;
  const axes = font.variationAxes || {};
  if (Object.keys(axes).length) {
    const s = parseVariations(req.css.fontVariationSettings);
    if (axes.wght && s.wght == null) s.wght = parseInt(req.css.fontWeight, 10) || 400;
    for (const [tag, ax] of Object.entries(axes)) if (s[tag] != null) s[tag] = Math.max(ax.min, Math.min(ax.max, s[tag]));
    try { f = font.getVariation(s); } catch (e) { f = font; }
  }
  const run = f.layout(req.text, parseFeatures(req.css.fontFeatureSettings));
  if (!run.glyphs.length || run.glyphs.some((g) => g.id === 0)) return null;
  const size = parseFloat(req.css.fontSize) || 16;
  const k = size / f.unitsPerEm;
  // vertical metrics that match the browser's text box
  const os2 = f['OS/2'];
  const cands = [[f.ascent, -f.descent]];
  if (os2) { cands.push([os2.typoAscender, -os2.typoDescender], [os2.winAscent, os2.winDescent]); }
  let [asc, desc] = cands[0];
  let best = Infinity;
  for (const [a, d] of cands) {
    const diff = Math.abs((a + d) * k - req.h);
    if (a > 0 && diff < best) { best = diff; asc = a; desc = d; }
  }
  const ls = parseFloat(req.css.letterSpacing) || 0;
  let x = 0;
  const paths = [];
  run.glyphs.forEach((g, i) => {
    const pos = run.positions[i];
    const d = g.path && g.path.toSVG();
    if (d) paths.push(`<path transform="translate(${r2(x + pos.xOffset)} ${r2(asc - pos.yOffset)}) scale(1 -1)" d="${d}"/>`);
    x += pos.xAdvance + ls / k;
  });
  if (!paths.length || x <= 0) return null;
  // Keep the exact box the browser measured (layout and auto layout rely on it);
  // the glyph is drawn at its natural size inside it.
  const w = req.w > 0 ? req.w : x * k, h = req.h > 0 ? req.h : (asc + desc) * k;
  const fill = `rgb(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)})`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${r2(w)}" height="${r2(h)}" viewBox="0 0 ${r2(w / k)} ${r2(h / k)}">`
    + `<g fill="${fill}"${color.a < 1 ? ` fill-opacity="${r2(color.a)}"` : ''}>${paths.join('')}</g></svg>`;
  const single = run.glyphs.length === 1 ? run.glyphs[0].name : null;
  const ligature = /^[a-z][\w-]*$/i.test(req.text) && req.text.length > 1 ? req.text : null;
  const name = ligature || (single && !/^(uni|u)[0-9a-f]{4,}$|^glyph\d+$|^\.notdef$/i.test(single) ? single : null) || 'icon';
  return { svg, w, h, name };
}

/**
 * Turn icon requests into vectors. icons: [{id, text, css, w, h, color}] (color = parsed {r,g,b,a}).
 * Returns Map id → {svg, w, h, name}.
 */
async function vectorize(page, icons, ctx) {
  const out = new Map();
  if (!icons.length) return out;
  let collected;
  try { collected = await page.evaluate(collectFontFaces); } catch (e) { return out; }
  const faces = collected.faces.slice();
  const wanted = new Set(icons.map((ic) => famKey(splitCommas(ic.css.fontFamily || '')[0])));
  // Cross-origin stylesheets (Google Fonts, CDNs): fetch and parse them ourselves.
  const missing = [...wanted].filter((w) => !faces.some((f) => famKey(f.family) === w));
  if (missing.length && collected.remote.length) {
    await Promise.all(collected.remote.slice(0, 30).map(async (url) => {
      const buf = await download(url, ctx, cssCache, 'css');
      if (!buf) return;
      const text = buf.toString('utf8');
      faces.push(...parseFontFaces(text, url));
      for (const imp of text.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s]+)/gi)) {
        const b2 = await download(new URL(imp[1], url).href, ctx, cssCache, 'css');
        if (b2) faces.push(...parseFontFaces(b2.toString('utf8'), new URL(imp[1], url).href));
      }
    }));
  }
  for (const ic of icons) {
    try {
      const family = famKey(splitCommas(ic.css.fontFamily || '')[0]);
      const cp = ic.text.codePointAt(0);
      const want = parseInt(ic.css.fontWeight, 10) || 400;
      const italic = /italic|oblique/.test(ic.css.fontStyle || '');
      const cands = faces
        .filter((f) => famKey(f.family) === family && rangeCovers(f.range, cp))
        .sort((a, b) => (/italic|oblique/.test(a.style) !== italic) - (/italic|oblique/.test(b.style) !== italic) || weightDistance(a.weight, want) - weightDistance(b.weight, want));
      for (const face of cands) {
        let done = false;
        for (const url of srcUrls(face.src, face.base)) {
          const font = await loadFont(url, ctx);
          if (!font) continue;
          const v = glyphSvg(font, ic, ic.color);
          if (v) { out.set(ic.id, v); done = true; }
          break;
        }
        if (done) break;
      }
    } catch (e) { /* keep the picture fallback */ }
  }
  return out;
}

module.exports = { vectorize, parseFontFaces, srcUrls };
