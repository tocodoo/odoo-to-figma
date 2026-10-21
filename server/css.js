'use strict';
// Parsers for computed CSS values (colors, gradients, shadows, lengths)
// and conversion to Figma paint/effect descriptions.

// ---------------------------------------------------------------------------
// Generic tokenizers
// ---------------------------------------------------------------------------

/** Split `str` on `sep` characters that are not nested inside (), [] or quotes. */
function splitTop(str, sep) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') { cur += str[++i] || ''; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    const isSep = sep === ' ' ? /\s/.test(ch) : ch === sep;
    if (isSep && depth === 0) {
      if (sep !== ' ' || cur.length) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim().length || sep !== ' ') out.push(cur.trim());
  return out.filter((s, i) => s.length || sep !== ' ');
}

const splitCommas = (s) => splitTop(s, ',').filter((x) => x.length);
const splitSpaces = (s) => splitTop(s, ' ').filter((x) => x.length);

/** Parse a length. `pct` is the reference for percentages. Supports simple calc(). */
function parseLength(v, pct = 0, fontSize = 16) {
  if (v == null) return 0;
  v = String(v).trim();
  if (!v || v === 'auto' || v === 'none' || v === 'normal') return 0;
  if (v.startsWith('calc(')) return evalCalc(v.slice(5, -1), pct, fontSize);
  const m = /^(-?[\d.]+(?:e-?\d+)?)(px|%|em|rem|vw|vh)?$/i.exec(v);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  switch ((m[2] || 'px').toLowerCase()) {
    case '%': return (n / 100) * pct;
    case 'em': return n * fontSize;
    case 'rem': return n * 16;
    default: return n;
  }
}

function evalCalc(expr, pct, fontSize) {
  // Handles linear combinations like "100% - 10px", "50% + -3px", "2 * 10px".
  const tokens = expr.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').match(/-?[\d.]+(?:px|%|em|rem)?|[+\-*/()]/g);
  if (!tokens) return 0;
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  function factor() {
    const t = next();
    if (t === '(') { const v = sum(); next(); return v; }
    if (t === '-') return -factor();
    return parseLength(t, pct, fontSize) || (/^-?[\d.]+$/.test(t) ? parseFloat(t) : 0);
  }
  function term() {
    let v = factor();
    while (peek() === '*' || peek() === '/') {
      const op = next();
      const r = factor();
      v = op === '*' ? v * r : r ? v / r : v;
    }
    return v;
  }
  function sum() {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  try { return sum(); } catch (e) { return 0; }
}

function px(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const NAMED = {
  transparent: [0, 0, 0, 0], black: [0, 0, 0, 1], white: [1, 1, 1, 1], red: [1, 0, 0, 1],
  green: [0, 128 / 255, 0, 1], blue: [0, 0, 1, 1], gray: [128 / 255, 128 / 255, 128 / 255, 1],
  grey: [128 / 255, 128 / 255, 128 / 255, 1], silver: [192 / 255, 192 / 255, 192 / 255, 1],
  yellow: [1, 1, 0, 1], orange: [1, 165 / 255, 0, 1], purple: [128 / 255, 0, 128 / 255, 1],
  canvas: [1, 1, 1, 1], canvastext: [0, 0, 0, 1], buttonface: [239 / 255, 239 / 255, 239 / 255, 1],
  buttontext: [0, 0, 0, 1], field: [1, 1, 1, 1], fieldtext: [0, 0, 0, 1], graytext: [109 / 255, 109 / 255, 109 / 255, 1],
  highlight: [0, 120 / 255, 215 / 255, 1], linktext: [0, 0, 238 / 255, 1],
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const srgbEncode = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const srgbDecode = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const mul3 = (m, v) => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];
const XYZ65_TO_LSRGB = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
];
const D50_TO_D65 = [
  [0.9554734527042182, -0.023098536874261423, 0.0632593086610217],
  [-0.028369706963208136, 1.0099954580058226, 0.021041398966943008],
  [0.012314001688319899, -0.020507696433477912, 1.3303659366080753],
];
const LP3_TO_XYZ65 = [
  [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
  [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
  [0, 0.04511338185890264, 1.043944368900976],
];

function linearToColor(lin, a) {
  return { r: clamp01(srgbEncode(lin[0])), g: clamp01(srgbEncode(lin[1])), b: clamp01(srgbEncode(lin[2])), a: clamp01(a) };
}

function oklabToColor(L, A, B, alpha) {
  const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = L - 0.0894841775 * A - 1.291485548 * B;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return linearToColor([
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ], alpha);
}

function labToColor(L, A, B, alpha) {
  const k = 24389 / 27, e = 216 / 24389;
  const fy = (L + 16) / 116, fx = A / 500 + fy, fz = fy - B / 200;
  const x = fx ** 3 > e ? fx ** 3 : (116 * fx - 16) / k;
  const y = L > k * e ? ((L + 16) / 116) ** 3 : L / k;
  const z = fz ** 3 > e ? fz ** 3 : (116 * fz - 16) / k;
  const xyz50 = [x * 0.3457 / 0.3585, y, z * (1 - 0.3457 - 0.3585) / 0.3585];
  return linearToColor(mul3(XYZ65_TO_LSRGB, mul3(D50_TO_D65, xyz50)), alpha);
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function num(tok, scale = 1) {
  if (tok == null || tok === 'none') return 0;
  if (tok.endsWith('%')) return (parseFloat(tok) / 100) * scale;
  return parseFloat(tok);
}

function hueDeg(tok) {
  if (tok == null || tok === 'none') return 0;
  const n = parseFloat(tok);
  if (tok.endsWith('turn')) return n * 360;
  if (tok.endsWith('rad')) return (n * 180) / Math.PI;
  if (tok.endsWith('grad')) return n * 0.9;
  return n;
}

const colorCache = new Map();

/** Parse any CSS color into {r,g,b,a} (0..1). Returns null when not a color. */
function parseColor(str) {
  if (str == null) return null;
  str = String(str).trim();
  if (!str) return null;
  if (colorCache.has(str)) return colorCache.get(str);
  const c = parseColorUncached(str);
  colorCache.set(str, c);
  return c;
}

function parseColorUncached(str) {
  const low = str.toLowerCase();
  if (NAMED[low]) { const n = NAMED[low]; return { r: n[0], g: n[1], b: n[2], a: n[3] }; }
  if (low[0] === '#') {
    let h = low.slice(1);
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const v = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { r: v(0), g: v(2), b: v(4), a: h.length === 8 ? v(6) : 1 };
  }
  const m = /^([a-z-]+)\((.*)\)$/s.exec(low);
  if (!m) return null;
  const fn = m[1];
  let body = m[2].trim();
  let alpha = 1;
  // Split "a b c / alpha" or "a, b, c, alpha"
  let parts;
  if (body.includes('/')) {
    const [main, al] = body.split('/');
    alpha = num(al.trim(), 1);
    parts = splitSpaces(main.replace(/,/g, ' '));
  } else {
    parts = splitSpaces(body.replace(/,/g, ' '));
  }
  switch (fn) {
    case 'rgb':
    case 'rgba': {
      if (parts.length === 4) alpha = num(parts[3], 1);
      const ch = (t) => (t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t) / 255);
      return { r: clamp01(ch(parts[0])), g: clamp01(ch(parts[1])), b: clamp01(ch(parts[2])), a: clamp01(alpha) };
    }
    case 'hsl':
    case 'hsla': {
      if (parts.length === 4) alpha = num(parts[3], 1);
      const rgb = hslToRgb(hueDeg(parts[0]), num(parts[1], 1) / (parts[1].endsWith('%') ? 1 : 100), num(parts[2], 1) / (parts[2].endsWith('%') ? 1 : 100));
      return { r: clamp01(rgb[0]), g: clamp01(rgb[1]), b: clamp01(rgb[2]), a: clamp01(alpha) };
    }
    case 'hwb': {
      const h = hueDeg(parts[0]);
      let w = num(parts[1], 1), b = num(parts[2], 1);
      if (!parts[1].endsWith('%')) w /= 100;
      if (!parts[2].endsWith('%')) b /= 100;
      if (w + b >= 1) { const g = w / (w + b); return { r: g, g, b: g, a: alpha }; }
      const rgb = hslToRgb(h, 1, 0.5).map((c) => c * (1 - w - b) + w);
      return { r: rgb[0], g: rgb[1], b: rgb[2], a: alpha };
    }
    case 'oklab':
      return oklabToColor(num(parts[0], 1), num(parts[1], 0.4), num(parts[2], 0.4), alpha);
    case 'oklch': {
      const L = num(parts[0], 1), C = num(parts[1], 0.4), H = (hueDeg(parts[2]) * Math.PI) / 180;
      return oklabToColor(L, C * Math.cos(H), C * Math.sin(H), alpha);
    }
    case 'lab':
      return labToColor(num(parts[0], 100), num(parts[1], 125), num(parts[2], 125), alpha);
    case 'lch': {
      const L = num(parts[0], 100), C = num(parts[1], 150), H = (hueDeg(parts[2]) * Math.PI) / 180;
      return labToColor(L, C * Math.cos(H), C * Math.sin(H), alpha);
    }
    case 'color': {
      const space = parts[0];
      const v = parts.slice(1, 4).map((t) => num(t, 1));
      if (space === 'srgb' || space === 'a98-rgb' || space === 'rec2020' || space === 'prophoto-rgb') {
        return { r: clamp01(v[0]), g: clamp01(v[1]), b: clamp01(v[2]), a: clamp01(alpha) };
      }
      if (space === 'srgb-linear') return linearToColor(v, alpha);
      if (space === 'display-p3') return linearToColor(mul3(XYZ65_TO_LSRGB, mul3(LP3_TO_XYZ65, v.map(srgbDecode))), alpha);
      if (space === 'xyz' || space === 'xyz-d65') return linearToColor(mul3(XYZ65_TO_LSRGB, v), alpha);
      if (space === 'xyz-d50') return linearToColor(mul3(XYZ65_TO_LSRGB, mul3(D50_TO_D65, v)), alpha);
      return { r: clamp01(v[0]), g: clamp01(v[1]), b: clamp01(v[2]), a: clamp01(alpha) };
    }
    case 'color-mix': {
      // color-mix(in srgb, A p%, B) – rough sRGB mix
      const args = splitCommas(m[2]);
      const a = splitSpaces(args[1] || ''), b = splitSpaces(args[2] || '');
      const ca = parseColor(a[0]), cb = parseColor(b[0]);
      if (!ca || !cb) return ca || cb;
      let pa = a[1] ? parseFloat(a[1]) / 100 : b[1] ? 1 - parseFloat(b[1]) / 100 : 0.5;
      const mix = (x, y) => x * pa + y * (1 - pa);
      return { r: mix(ca.r, cb.r), g: mix(ca.g, cb.g), b: mix(ca.b, cb.b), a: mix(ca.a, cb.a) };
    }
    case 'light-dark': {
      const args = splitCommas(m[2]);
      return parseColor(args[0]);
    }
    default:
      return null;
  }
}

function isColorToken(tok) {
  return parseColor(tok) !== null;
}

// ---------------------------------------------------------------------------
// Shadows
// ---------------------------------------------------------------------------

/** Parse box-shadow / text-shadow into [{inset, color, x, y, blur, spread}]. */
function parseShadows(str) {
  if (!str || str === 'none') return [];
  const out = [];
  for (const layer of splitCommas(str)) {
    const toks = splitSpaces(layer);
    let inset = false, color = null;
    const lens = [];
    for (const t of toks) {
      if (t === 'inset') inset = true;
      else if (/^-?[\d.]/.test(t)) lens.push(px(t));
      else { const c = parseColor(t); if (c) color = c; }
    }
    if (!color) color = { r: 0, g: 0, b: 0, a: 1 };
    out.push({ inset, color, x: lens[0] || 0, y: lens[1] || 0, blur: lens[2] || 0, spread: lens[3] || 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Background images & gradients
// ---------------------------------------------------------------------------

function unquoteUrl(s) {
  const m = /^url\((.*)\)$/s.exec(s.trim());
  if (!m) return null;
  let u = m[1].trim();
  if ((u[0] === '"' || u[0] === "'") && u[u.length - 1] === u[0]) u = u.slice(1, -1);
  return u.replace(/\\(["'\\])/g, '$1');
}

/** Parse the computed background-image into layers (first = top-most). */
function parseBackgroundImage(str) {
  if (!str || str === 'none') return [];
  return splitCommas(str).map((layer) => {
    if (layer === 'none') return { kind: 'none' };
    if (layer.startsWith('url(')) return { kind: 'url', url: unquoteUrl(layer) };
    const m = /^(-webkit-)?(repeating-)?(linear|radial|conic)-gradient\((.*)\)$/s.exec(layer);
    if (m) return { kind: m[3], repeating: !!m[2], args: splitCommas(m[4]), raw: layer };
    const set = /^(-webkit-)?image-set\((.*)\)$/s.exec(layer);
    if (set) {
      const first = splitCommas(set[2])[0] || '';
      const u = /url\([^)]*\)/.exec(first);
      if (u) return { kind: 'url', url: unquoteUrl(u[0]) };
      const q = /["']([^"']+)["']/.exec(first);
      if (q) return { kind: 'url', url: q[1] };
    }
    return { kind: 'none' };
  });
}

function parseStops(args, lineLen) {
  const stops = [];
  for (const a of args) {
    const toks = splitSpaces(a);
    let color = null;
    const pos = [];
    for (const t of toks) {
      const c = parseColor(t);
      if (c && !/^-?[\d.]/.test(t)) color = c;
      else pos.push(t.endsWith('%') ? parseFloat(t) / 100 : lineLen ? parseLength(t, lineLen) / lineLen : 0);
    }
    if (!color) continue; // color hint – ignored
    if (pos.length === 0) stops.push({ color, pos: null });
    else for (const p of pos) stops.push({ color, pos: p });
  }
  if (!stops.length) return [];
  if (stops[0].pos == null) stops[0].pos = 0;
  if (stops[stops.length - 1].pos == null) stops[stops.length - 1].pos = 1;
  // Monotonic + fill in missing
  let last = stops[0].pos;
  for (const s of stops) { if (s.pos != null) { if (s.pos < last) s.pos = last; last = s.pos; } }
  for (let i = 0; i < stops.length; i++) {
    if (stops[i].pos != null) continue;
    let j = i;
    while (stops[j].pos == null) j++;
    const a = stops[i - 1].pos, b = stops[j].pos, n = j - i + 1;
    for (let k = i; k < j; k++) stops[k].pos = a + ((b - a) * (k - i + 1)) / n;
    i = j;
  }
  return stops;
}

function angleFromArg(arg, W, H) {
  arg = arg.trim();
  if (arg.startsWith('to ')) {
    const w = arg.slice(3).split(/\s+/);
    let sx = 0, sy = 0;
    for (const k of w) {
      if (k === 'left') sx = -1; else if (k === 'right') sx = 1;
      else if (k === 'top') sy = -1; else if (k === 'bottom') sy = 1;
    }
    if (sx && sy) {
      // Perpendicular to the diagonal joining the two other corners.
      const dx = sx * H, dy = sy * W;
      return Math.atan2(dx, -dy);
    }
    if (sx) return (sx > 0 ? 90 : 270) * (Math.PI / 180);
    return (sy > 0 ? 180 : 0) * (Math.PI / 180);
  }
  const m = /^(-?[\d.]+)(deg|rad|turn|grad)$/.exec(arg);
  if (!m) return null;
  return (hueDeg(arg) * Math.PI) / 180;
}

function positionPair(str, W, H) {
  // "at 20% 30%", "at center", "at left top"...
  const toks = splitSpaces(str || 'center');
  let x = null, y = null;
  const kw = { left: 0, center: 0.5, right: 1, top: 0, bottom: 1 };
  const vals = [];
  for (const t of toks) vals.push(t);
  if (vals.length === 1) vals.push('center');
  for (let i = 0; i < vals.length; i++) {
    const t = vals[i];
    if (t === 'left' || t === 'right') x = kw[t] * W;
    else if (t === 'top' || t === 'bottom') y = kw[t] * H;
    else if (t === 'center') { if (x == null && i === 0) x = W / 2; else if (y == null) y = H / 2; else x = W / 2; }
    else if (x == null && i === 0) x = parseLength(t, W);
    else y = parseLength(t, H);
  }
  return [x == null ? W / 2 : x, y == null ? H / 2 : y];
}

/**
 * Build an absolute gradient description for a box {x,y,w,h} (document coords).
 * Returns {kind:'linear'|'radial'|'conic', stops, p0, p1} or null.
 */
function gradientGeometry(layer, box) {
  const W = Math.max(box.w, 0.01), H = Math.max(box.h, 0.01);
  let args = layer.args.slice();
  if (layer.kind === 'linear') {
    let ang = Math.PI; // to bottom
    const a = angleFromArg(args[0], W, H);
    if (a != null) { ang = a; args = args.slice(1); }
    const sin = Math.sin(ang), cos = Math.cos(ang);
    const L = Math.abs(W * sin) + Math.abs(H * cos);
    const cx = box.x + W / 2, cy = box.y + H / 2;
    const dx = (sin * L) / 2, dy = (-cos * L) / 2;
    const stops = parseStops(args, L);
    if (!stops.length) return null;
    return { kind: 'linear', stops, p0: [cx - dx, cy - dy], p1: [cx + dx, cy + dy] };
  }
  if (layer.kind === 'radial') {
    let shape = 'ellipse', size = 'farthest-corner', pos = 'center';
    const first = args[0] || '';
    const firstIsStop = splitSpaces(first).some((t) => isColorToken(t) && !/^-?[\d.]/.test(t));
    let explicit = null;
    if (!firstIsStop) {
      args = args.slice(1);
      const [shapeSize, at] = first.split(/\bat\b/);
      if (at) pos = at.trim();
      const toks = splitSpaces(shapeSize || '');
      const lens = [];
      for (const t of toks) {
        if (t === 'circle' || t === 'ellipse') shape = t;
        else if (/^(closest|farthest)-(side|corner)$/.test(t)) size = t;
        else if (/^-?[\d.]/.test(t) || t.startsWith('calc(')) lens.push(t);
      }
      if (lens.length === 1) { shape = 'circle'; explicit = [parseLength(lens[0], W), parseLength(lens[0], W)]; }
      else if (lens.length >= 2) explicit = [parseLength(lens[0], W), parseLength(lens[1], H)];
    }
    const [px0, py0] = positionPair(pos, W, H);
    let rx, ry;
    if (explicit) { [rx, ry] = explicit; }
    else {
      const dxs = [px0, W - px0], dys = [py0, H - py0];
      const closestX = Math.min(...dxs.map(Math.abs)), farX = Math.max(...dxs.map(Math.abs));
      const closestY = Math.min(...dys.map(Math.abs)), farY = Math.max(...dys.map(Math.abs));
      if (shape === 'circle') {
        const corners = [[0, 0], [W, 0], [0, H], [W, H]].map(([x, y]) => Math.hypot(x - px0, y - py0));
        const r = size === 'closest-side' ? Math.min(closestX, closestY)
          : size === 'farthest-side' ? Math.max(farX, farY)
          : size === 'closest-corner' ? Math.min(...corners) : Math.max(...corners);
        rx = ry = r;
      } else if (size === 'closest-side') { rx = closestX; ry = closestY; }
      else if (size === 'farthest-side') { rx = farX; ry = farY; }
      else if (size === 'closest-corner') { rx = closestX * Math.SQRT2; ry = closestY * Math.SQRT2; }
      else { rx = farX * Math.SQRT2; ry = farY * Math.SQRT2; }
    }
    rx = Math.max(rx, 0.01); ry = Math.max(ry, 0.01);
    const stops = parseStops(args, rx);
    if (!stops.length) return null;
    return { kind: 'radial', stops, c: [box.x + px0, box.y + py0], rx, ry };
  }
  if (layer.kind === 'conic') {
    let from = 0, pos = 'center';
    const first = args[0] || '';
    if (/^(from|at)\b/.test(first)) {
      args = args.slice(1);
      const fm = /from\s+(\S+)/.exec(first);
      if (fm) from = hueDeg(fm[1]);
      const am = /at\s+(.*)$/.exec(first);
      if (am) pos = am[1];
    }
    const [px0, py0] = positionPair(pos, W, H);
    const stops = parseStops(args.map((a) => a.replace(/(-?[\d.]+)deg/g, (_, d) => `${(parseFloat(d) / 360) * 100}%`)), 0);
    if (!stops.length) return null;
    return { kind: 'conic', stops, c: [box.x + px0, box.y + py0], from, r: Math.max(W, H) / 2 };
  }
  return null;
}

/** Convert an absolute gradient geometry into a Figma paint relative to `box`. */
function gradientPaint(g, box, opacity = 1) {
  const W = Math.max(box.w, 0.01), H = Math.max(box.h, 0.01);
  const stops = g.stops.map((s) => ({ position: clamp01(s.pos), color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a * opacity } }));
  if (g.kind === 'linear') {
    const sx = g.p0[0] - box.x, sy = g.p0[1] - box.y;
    const dx = g.p1[0] - g.p0[0], dy = g.p1[1] - g.p0[1];
    const pxv = -dy, pyv = dx;
    // Gradient space -> normalized node space
    const A = [[dx / W, pxv / W], [dy / H, pyv / H]];
    const b = [(sx - 0.5 * pxv) / W, (sy - 0.5 * pyv) / H];
    return { type: 'GRADIENT_LINEAR', stops, t: invertAffine(A, b) };
  }
  if (g.kind === 'radial') {
    const cx = g.c[0] - box.x, cy = g.c[1] - box.y;
    return {
      type: 'GRADIENT_RADIAL', stops,
      t: [[W / (2 * g.rx), 0, 0.5 - cx / (2 * g.rx)], [0, H / (2 * g.ry), 0.5 - cy / (2 * g.ry)]],
    };
  }
  if (g.kind === 'conic') {
    const cx = g.c[0] - box.x, cy = g.c[1] - box.y, r = g.r;
    // Angular: rotate so that the start angle matches CSS (0deg = top, clockwise).
    const a = ((g.from - 90) * Math.PI) / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    const A = [[(2 * r * cos) / W, (-2 * r * sin) / W], [(2 * r * sin) / H, (2 * r * cos) / H]];
    const b0 = [cx / W - (A[0][0] * 0.5 + A[0][1] * 0.5), cy / H - (A[1][0] * 0.5 + A[1][1] * 0.5)];
    return { type: 'GRADIENT_ANGULAR', stops, t: invertAffine(A, b0) };
  }
  return null;
}

function invertAffine(A, b) {
  const det = A[0][0] * A[1][1] - A[0][1] * A[1][0] || 1e-9;
  const i00 = A[1][1] / det, i01 = -A[0][1] / det, i10 = -A[1][0] / det, i11 = A[0][0] / det;
  return [
    [i00, i01, -(i00 * b[0] + i01 * b[1])],
    [i10, i11, -(i10 * b[0] + i11 * b[1])],
  ];
}

/** Resolve background-size + position for one layer. Returns {x,y,w,h} relative to the area. */
function backgroundRect(sizeStr, posX, posY, area, natural) {
  const W = area.w, H = area.h;
  let iw = natural && natural.w ? natural.w : W, ih = natural && natural.h ? natural.h : H;
  const ratio = iw / ih || 1;
  let w, h;
  const s = (sizeStr || 'auto').trim();
  if (s === 'cover' || s === 'contain') {
    const k = s === 'cover' ? Math.max(W / iw, H / ih) : Math.min(W / iw, H / ih);
    w = iw * k; h = ih * k;
  } else {
    const parts = splitSpaces(s);
    const a = parts[0] || 'auto', b = parts[1] || 'auto';
    const wv = a === 'auto' ? null : parseLength(a, W);
    const hv = b === 'auto' ? null : parseLength(b, H);
    if (wv != null && hv != null) { w = wv; h = hv; }
    else if (wv != null) { w = wv; h = natural ? wv / ratio : H; }
    else if (hv != null) { h = hv; w = natural ? hv * ratio : W; }
    else { w = natural ? iw : W; h = natural ? ih : H; }
  }
  const x = parseLength(posX || '0%', W - w);
  const y = parseLength(posY || '0%', H - h);
  return { x, y, w, h };
}

module.exports = {
  splitTop, splitCommas, splitSpaces, parseLength, px, parseColor, parseShadows,
  parseBackgroundImage, gradientGeometry, gradientPaint, backgroundRect, unquoteUrl,
};
