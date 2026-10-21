'use strict';
// Converts a Chrome DOMSnapshot into the "Odoo To Figma" intermediate
// representation (IR): a tree of FRAME / TEXT / SVG nodes positioned in
// absolute document coordinates, ready to be instantiated by the plugin.

const css = require('./css');
const fa4 = require('./fa4');

const PROPS = [
  'display', 'position', 'visibility', 'opacity', 'z-index', 'overflow-x', 'overflow-y', 'float',
  'flex-direction', 'flex-wrap', 'justify-content', 'align-items',
  'background-color', 'background-image', 'background-size', 'background-position-x', 'background-position-y',
  'background-repeat', 'background-clip', 'background-origin',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
  'box-shadow', 'transform', 'filter', 'backdrop-filter', 'mix-blend-mode',
  'color', '-webkit-text-fill-color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
  'font-feature-settings', 'font-variation-settings',
  'letter-spacing', 'text-align', 'text-decoration-line', 'text-transform', 'text-shadow', 'white-space',
  'direction', 'text-overflow', '-webkit-line-clamp',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'object-fit', 'object-position', 'clip-path', 'mask-image', '-webkit-mask-image', 'appearance',
  'outline-style', 'outline-width', 'outline-color',
  'vertical-align', 'transform-origin', 'border-collapse',
];

// display value → role used to rebuild tables as clean auto layout
const TABLE_ROLES = {
  table: 'table', 'inline-table': 'table',
  'table-row-group': 'group', 'table-header-group': 'group', 'table-footer-group': 'group',
  'table-row': 'row', 'table-cell': 'cell',
};

const SKIP_TAGS = new Set([
  'head', 'script', 'style', 'noscript', 'template', 'meta', 'link', 'title', 'br', 'wbr', 'source',
  'track', 'param', 'map', 'area', 'datalist', 'option', 'optgroup', 'base',
]);
const SHOT_TAGS = new Set(['iframe', 'video', 'canvas', 'embed', 'object', 'progress', 'meter']);
const TEXT_INPUTS = new Set(['', 'text', 'email', 'password', 'search', 'tel', 'url', 'number']);
const NATIVE_INPUTS = new Set(['checkbox', 'radio', 'range', 'color', 'file', 'date', 'datetime-local', 'time', 'month', 'week']);
const BLEND = {
  multiply: 'MULTIPLY', screen: 'SCREEN', overlay: 'OVERLAY', darken: 'DARKEN', lighten: 'LIGHTEN',
  'color-dodge': 'COLOR_DODGE', 'color-burn': 'COLOR_BURN', 'hard-light': 'HARD_LIGHT', 'soft-light': 'SOFT_LIGHT',
  difference: 'DIFFERENCE', exclusion: 'EXCLUSION', hue: 'HUE', saturation: 'SATURATION', color: 'COLOR', luminosity: 'LUMINOSITY',
};
const SEMANTIC = {
  header: 'Header', nav: 'Nav', footer: 'Footer', main: 'Main', section: 'Section', article: 'Article',
  aside: 'Aside', form: 'Form', button: 'Button', a: 'Link', ul: 'List', ol: 'List', li: 'Item', table: 'Table',
  h1: 'H1', h2: 'H2', h3: 'H3', h4: 'H4', h5: 'H5', h6: 'H6', p: 'P', img: 'Image', label: 'Label',
  input: 'Input', textarea: 'Textarea', select: 'Select', figure: 'Figure',
};
const ICON_FONT_RE = /(font ?awesome|fontawesome|\bfa[-\s]?\d|icomoon|glyphicons|material ?(icons|symbols)|feather|ionicons|\blnr\b|linearicons|themify|bootstrap-icons|remixicon|odoo_ui_icons|\boi\b|dashicons|simple-line|flaticon|line ?awesome|et-line|elegant ?icons|typicons|entypo|foundation-icons|octicons|codicon|\bicons?\b|iconfont|\bicon-)/i;

const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const r2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// Snapshot accessor
// ---------------------------------------------------------------------------

class Snap {
  constructor(raw) {
    this.S = raw.strings;
    const d = raw.documents[0];
    this.doc = d;
    this.n = d.nodes;
    this.L = d.layout;
    this.N = this.n.parentIndex.length;
    this.children = Array.from({ length: this.N }, () => []);
    for (let i = 0; i < this.N; i++) {
      const p = this.n.parentIndex[i];
      if (p >= 0) this.children[p].push(i);
    }
    this.layouts = new Map();
    this.L.nodeIndex.forEach((ni, li) => {
      let a = this.layouts.get(ni);
      if (!a) this.layouts.set(ni, (a = []));
      a.push(li);
    });
    const rareStr = (f) => {
      const m = new Map();
      if (f) f.index.forEach((ix, k) => m.set(ix, this.str(f.value[k])));
      return m;
    };
    const rareBool = (f) => new Set(f ? f.index : []);
    this.pseudo = rareStr(this.n.pseudoType);
    this.inputValue = rareStr(this.n.inputValue);
    this.textValue = rareStr(this.n.textValue);
    this.srcURL = rareStr(this.n.currentSourceURL);
    this.checked = rareBool(this.n.inputChecked);
    this.selected = rareBool(this.n.optionSelected);
    this.boxes = new Map();
    const tb = d.textBoxes;
    for (let k = 0; k < tb.layoutIndex.length; k++) {
      const li = tb.layoutIndex[k];
      const b = tb.bounds[k];
      let a = this.boxes.get(li);
      if (!a) this.boxes.set(li, (a = []));
      a.push({ x: b[0], y: b[1], w: b[2], h: b[3], start: tb.start[k], len: tb.length[k] });
    }
    this.styleCache = new Map();
    this.attrCache = new Map();
  }
  str(i) { return i >= 0 ? this.S[i] : ''; }
  name(i) { return this.str(this.n.nodeName[i]); }
  value(i) { return this.str(this.n.nodeValue[i]); }
  type(i) { return this.n.nodeType[i]; }
  style(li) {
    let s = this.styleCache.get(li);
    if (!s) {
      s = {};
      const arr = this.L.styles[li];
      for (let k = 0; k < PROPS.length; k++) s[PROPS[k]] = arr && arr[k] != null ? this.str(arr[k]) : '';
      this.styleCache.set(li, s);
    }
    return s;
  }
  attrs(i) {
    let a = this.attrCache.get(i);
    if (!a) {
      a = {};
      const arr = this.n.attributes[i] || [];
      for (let k = 0; k + 1 < arr.length; k += 2) a[this.str(arr[k])] = this.str(arr[k + 1]);
      this.attrCache.set(i, a);
    }
    return a;
  }
  bounds(li) {
    const b = this.L.bounds[li];
    return { x: b[0], y: b[1], w: b[2], h: b[3] };
  }
  hasText(li) { return this.L.text[li] >= 0; }
  text(li) { return this.str(this.L.text[li]); }
  po(li) { return this.L.paintOrders ? this.L.paintOrders[li] || 0 : 0; }
  boxLayout(node) {
    const a = this.layouts.get(node);
    if (!a) return -1;
    for (const li of a) if (!this.hasText(li)) return li;
    return -1;
  }
  textLayouts(node) {
    const a = this.layouts.get(node);
    return a ? a.filter((li) => this.hasText(li)) : [];
  }
  offsetSize(li) {
    const o = this.L.offsetRects && this.L.offsetRects[li];
    return o && o.length === 4 ? { w: o[2], h: o[3] } : null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function absUrl(u, base) {
  if (!u) return null;
  try { return new URL(u, base).href; } catch (e) { return null; }
}

function parseFamilies(str) {
  return css.splitCommas(str || '').map((f) => f.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

function solid(c, opacity = 1) {
  return { type: 'SOLID', color: { r: r4(c.r), g: r4(c.g), b: r4(c.b) }, opacity: r4(c.a * opacity) };
}
const r4 = (v) => Math.round(v * 10000) / 10000;

function isTransparent(c) { return !c || c.a <= 0.002; }

/**
 * SVG markup for the shape painted by a single colored border whose two
 * neighbouring borders are transparent (the classic CSS triangle), or null.
 * sides: [top, right, bottom, left] as { w, c }.
 */
function borderWedge(sides, box) {
  const k = sides.findIndex((x) => x.w > 0 && x.c && x.c.a > 0);
  const prev = sides[(k + 3) % 4], next = sides[(k + 1) % 4];
  if (!(prev.w > 0 && isTransparent(prev.c) && next.w > 0 && isTransparent(next.c))) return null;
  const [t, r, b, l] = sides.map((x) => x.w);
  const { w, h } = box;
  const pts = [
    [[0, 0], [w, 0], [w - r, t], [l, t]],
    [[w, 0], [w, h], [w - r, h - b], [w - r, t]],
    [[0, h], [w, h], [w - r, h - b], [l, h - b]],
    [[0, 0], [0, h], [l, h - b], [l, t]],
  ][k];
  const c = sides[k].c;
  const rgb = [c.r, c.g, c.b].map((v) => Math.round(v * 255)).join(',');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${r2(w)}" height="${r2(h)}" viewBox="0 0 ${r2(w)} ${r2(h)}">`
    + `<polygon points="${pts.map((p) => p.map(r2).join(',')).join(' ')}" fill="rgb(${rgb})"${c.a < 1 ? ` fill-opacity="${r4(c.a)}"` : ''}/></svg>`;
}

function sameColor(a, b) {
  return Math.abs(a.r - b.r) < 0.004 && Math.abs(a.g - b.g) < 0.004 && Math.abs(a.b - b.b) < 0.004 && Math.abs(a.a - b.a) < 0.004;
}

function clipsOverflow(st) {
  const v = (x) => x === 'hidden' || x === 'clip' || x === 'auto' || x === 'scroll' || x === 'overlay';
  return v(st['overflow-x']) || v(st['overflow-y']);
}

function resolveRadii(st, box) {
  const W = box.w, H = box.h;
  const one = (v) => {
    const p = css.splitSpaces(v || '0px');
    const h = css.parseLength(p[0], W);
    const vv = css.parseLength(p[1] != null ? p[1] : p[0], H);
    return Math.max(0, Math.min(h, vv));
  };
  let tl = one(st['border-top-left-radius']), tr = one(st['border-top-right-radius']);
  let br = one(st['border-bottom-right-radius']), bl = one(st['border-bottom-left-radius']);
  if (!(tl || tr || br || bl)) return null;
  const k = (side, sum) => (sum > 0 ? side / sum : Infinity);
  const f = Math.min(1, k(W, tl + tr), k(W, bl + br), k(H, tl + bl), k(H, tr + br));
  if (f < 1) { tl *= f; tr *= f; br *= f; bl *= f; }
  return [r2(tl), r2(tr), r2(br), r2(bl)];
}

function edges(st) {
  const sides = ['top', 'right', 'bottom', 'left'];
  return {
    b: sides.map((sd) => {
      const s = st[`border-${sd}-style`];
      return s === 'none' || s === 'hidden' ? 0 : css.px(st[`border-${sd}-width`]);
    }),
    p: sides.map((sd) => css.px(st[`padding-${sd}`])),
  };
}

function insetBox(box, t, r, b, l) {
  return { x: box.x + l, y: box.y + t, w: Math.max(0, box.w - l - r), h: Math.max(0, box.h - t - b) };
}

function parseFilter(str) {
  const out = { blur: 0, shadows: [], grayscale: 0, complex: false, brightness: 1, contrast: 1, saturate: 1 };
  if (!str || str === 'none') return out;
  const re = /([a-z-]+)\(((?:[^()]|\([^()]*\))*)\)/g;
  let m;
  while ((m = re.exec(str))) {
    const fn = m[1], arg = m[2].trim();
    const n = arg.endsWith('%') ? parseFloat(arg) / 100 : parseFloat(arg);
    if (fn === 'blur') out.blur = css.px(arg);
    else if (fn === 'drop-shadow') out.shadows.push(...css.parseShadows(arg));
    else if (fn === 'grayscale') out.grayscale = Number.isFinite(n) ? n : 1;
    else if (fn === 'brightness') out.brightness = Number.isFinite(n) ? n : 1;
    else if (fn === 'contrast') out.contrast = Number.isFinite(n) ? n : 1;
    else if (fn === 'saturate') out.saturate = Number.isFinite(n) ? n : 1;
    else if (fn === 'opacity') { /* folded into opacity */ }
    else out.complex = true;
  }
  return out;
}

function imageFilters(f) {
  const o = {};
  if (f.grayscale) o.saturation = -Math.min(1, f.grayscale);
  else if (f.saturate !== 1) o.saturation = Math.max(-1, Math.min(1, f.saturate - 1));
  if (f.brightness !== 1) o.exposure = Math.max(-1, Math.min(1, (f.brightness - 1) * 0.8));
  if (f.contrast !== 1) o.contrast = Math.max(-1, Math.min(1, f.contrast - 1));
  return Object.keys(o).length ? o : null;
}

function rotationOf(st) {
  const t = st.transform;
  if (!t || t === 'none') return null;
  const m = /^matrix\(([^)]+)\)$/.exec(t);
  if (!m) return null;
  const [a, b] = m[1].split(',').map(parseFloat);
  const ang = Math.atan2(b, a);
  if (Math.abs(ang) < 0.005) return null;
  return ang;
}

function textCaseOf(st) {
  switch (st['text-transform']) {
    case 'uppercase': return 'UPPER';
    case 'lowercase': return 'LOWER';
    case 'capitalize': return 'TITLE';
    default: return null;
  }
}

function decoOf(line) {
  if (!line || line === 'none') return '';
  if (line.includes('underline')) return 'UNDERLINE';
  if (line.includes('line-through')) return 'STRIKETHROUGH';
  return '';
}

function alignOf(st) {
  const rtl = st.direction === 'rtl';
  switch (st['text-align']) {
    case 'center': case '-webkit-center': return 'C';
    case 'right': case '-webkit-right': return 'R';
    case 'left': case '-webkit-left': return 'L';
    case 'justify': return 'J';
    case 'end': return rtl ? 'L' : 'R';
    default: return rtl ? 'R' : 'L';
  }
}

function isIconText(st, txt) {
  const fam = st['font-family'] || '';
  if (ICON_FONT_RE.test(fam) && !/\b(sans|serif|mono|text|display)\b/i.test(fam.split(',')[0])) return true;
  const t = txt.replace(/\s/g, '');
  if (!t) return false;
  for (const ch of t) {
    const cp = ch.codePointAt(0);
    const pua = (cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000;
    if (!pua) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Image URL collection (runs before IR building so images can be fetched)
// ---------------------------------------------------------------------------

function collectImageUrls(s, baseURL) {
  const urls = new Map();
  const add = (u, w, h) => {
    if (!u || u.startsWith('blob:') && false) return;
    const cur = urls.get(u);
    if (!cur) urls.set(u, { w, h });
    else { cur.w = Math.max(cur.w, w); cur.h = Math.max(cur.h, h); }
  };
  for (let li = 0; li < s.L.nodeIndex.length; li++) {
    if (s.hasText(li)) continue;
    const node = s.L.nodeIndex[li];
    const st = s.style(li);
    const b = s.bounds(li);
    if (st.display === 'none') continue;
    for (const layer of css.parseBackgroundImage(st['background-image'])) {
      if (layer.kind === 'url' && layer.url) add(absUrl(layer.url, baseURL), b.w, b.h);
    }
    const tag = s.name(node).toLowerCase();
    if (tag === 'img') add(s.srcURL.get(node) || absUrl(s.attrs(node).src, baseURL), b.w, b.h);
    else if (tag === 'input' && (s.attrs(node).type || '').toLowerCase() === 'image') add(absUrl(s.attrs(node).src, baseURL), b.w, b.h);
    else if (tag === 'video' && s.attrs(node).poster) add(absUrl(s.attrs(node).poster, baseURL), b.w, b.h);
  }
  urls.delete(null);
  return urls;
}

// ---------------------------------------------------------------------------
// IR builder
// ---------------------------------------------------------------------------

function buildIR(s, opts) {
  const { images, svgs, viewport, baseURL } = opts;
  const scope = opts.scope || 'page';
  const vw = viewport.width;
  // 'viewport' scope: only what is on screen at the current scroll position
  const top = scope === 'viewport' ? Math.max(0, opts.scrollY || 0) : 0;
  const docH = scope === 'viewport' ? top + viewport.height : Math.ceil(Math.max(viewport.height, s.doc.contentHeight || 0));
  let targetFrame = null;
  let rootRef = null;
  const shots = [];
  const icons = [];
  const patterns = [];
  const patternIndex = new Map();
  const styles = [];
  const styleIndex = new Map();
  let dom = 0;
  let idc = 0;
  let textCount = 0;
  let faCount = 0;

  // ----- run styles (deduplicated) ---------------------------------------
  function runStyle(st, inl, color, grad) {
    const sh = css.parseShadows(st['text-shadow']).filter((x) => !x.inset);
    const o = {
      fam: parseFamilies(st['font-family']),
      w: parseInt(st['font-weight'], 10) || 400,
      it: /italic|oblique/.test(st['font-style'] || ''),
      sz: r2(css.px(st['font-size']) || 16),
      c: color ? { r: r4(color.r), g: r4(color.g), b: r4(color.b), a: r4(color.a * inl.opacity) } : null,
      ls: st['letter-spacing'] && st['letter-spacing'] !== 'normal' ? r2(css.px(st['letter-spacing'])) : 0,
      tt: textCaseOf(st),
      dec: inl.deco || decoOf(st['text-decoration-line']),
      href: inl.href || null,
      lh: st['line-height'] && st['line-height'] !== 'normal' ? r2(css.px(st['line-height'])) : null,
    };
    if (grad) o.grad = grad;
    if (sh.length) o.sh = sh.map((x) => ({ c: x.color, x: x.x, y: x.y, blur: x.blur }));
    const key = JSON.stringify(o);
    let idx = styleIndex.get(key);
    if (idx == null) { idx = styles.length; styles.push(o); styleIndex.set(key, idx); }
    return idx;
  }

  // ----- visuals ----------------------------------------------------------
  function applyVisuals(f, st, box, o = {}) {
    const radii = resolveRadii(st, box);
    if (radii) f.radii = radii;
    const { b: bw } = edges(st);
    const bgChildren = [];
    const clipText = /text/.test(st['background-clip'] || '');

    // background color
    const bg = css.parseColor(st['background-color']);
    if (!o.noBackground && !clipText && !isTransparent(bg)) f.fills.push(solid(bg));

    // background images (CSS: first = top-most, Figma fills: last = top-most)
    const layers = o.noBackground || clipText ? [] : css.parseBackgroundImage(st['background-image']);
    if (layers.length) {
      const pick = (str, i, def) => { const a = css.splitCommas(str || ''); return a.length ? a[i % a.length] : def; };
      for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i];
        if (layer.kind === 'none') continue;
        const origin = pick(st['background-origin'], i, 'padding-box');
        const area = origin === 'border-box' ? box
          : origin === 'content-box' ? insetBox(box, bw[0] + css.px(st['padding-top']), bw[1] + css.px(st['padding-right']), bw[2] + css.px(st['padding-bottom']), bw[3] + css.px(st['padding-left']))
          : insetBox(box, bw[0], bw[1], bw[2], bw[3]);
        const size = pick(st['background-size'], i, 'auto');
        const posX = pick(st['background-position-x'], i, '0%');
        const posY = pick(st['background-position-y'], i, '0%');
        const repTok = css.splitSpaces(pick(st['background-repeat'], i, 'repeat'));
        let repX, repY;
        if (repTok.length === 1) {
          repX = repTok[0] === 'repeat-x' || !/no-repeat|repeat-y/.test(repTok[0]);
          repY = repTok[0] === 'repeat-y' || !/no-repeat|repeat-x/.test(repTok[0]);
        } else { repX = repTok[0] !== 'no-repeat'; repY = repTok[1] !== 'no-repeat'; }

        if (layer.kind === 'url') {
          const img = images.get(absUrl(layer.url, baseURL));
          if (!img) continue;
          const r = css.backgroundRect(size, posX, posY, area, { w: img.natW, h: img.natH });
          if (r.w < 0.1 || r.h < 0.1) continue;
          // Repeated images cover the whole area: bring the offset back into (-size, 0].
          if (repX) { r.x = ((r.x % r.w) + r.w) % r.w; if (r.x > 0.01) r.x -= r.w; }
          if (repY) { r.y = ((r.y % r.h) + r.h) % r.h; if (r.y > 0.01) r.y -= r.h; }
          const abs = { x: area.x + r.x, y: area.y + r.y, w: r.w, h: r.h };
          const tiles = (repX && r.x + r.w < area.w - 1) || (repY && r.y + r.h < area.h - 1);
          if (tiles) {
            f.fills.push({ type: 'IMAGE', id: img.id, scaleMode: 'TILE', sf: r4(r.w / img.w) });
          } else if (covers(abs, box)) {
            f.fills.push(imagePaint(img, abs, box));
          } else {
            bgChildren.push({ rect: abs, paint: { type: 'IMAGE', id: img.id, scaleMode: 'CROP', t: [[1, 0, 0], [0, 1, 0]] } });
          }
        } else {
          const r = css.backgroundRect(size, posX, posY, area, null);
          if (r.w < 0.1 || r.h < 0.1) continue;
          const tiles = (repX && r.w < box.w - 1) || (repY && r.h < box.h - 1);
          if (tiles && repX && repY && (r.w < area.w - 1 || r.h < area.h - 1) && r.w <= 1024 && r.h <= 1024) {
            // Repeated gradient pattern (dots, grids, stripes…): Chrome renders one
            // tile, used as a Figma tiled image fill. Tiles start at the frame
            // origin, so the background-position offset is baked into the tile.
            const ox = ((area.x - box.x + r.x) % r.w + r.w) % r.w;
            const oy = ((area.y - box.y + r.y) % r.h + r.h) % r.h;
            const key = `${layer.raw}|${r4(r.w)}|${r4(r.h)}|${r4(ox)}|${r4(oy)}`;
            let pat = patternIndex.get(key);
            if (!pat) {
              const scale = Math.min(4, Math.max(1, Math.floor(512 / Math.max(r.w, r.h))));
              pat = { id: 'pat' + idc++, css: layer.raw, w: r.w, h: r.h, ox, oy, scale };
              patternIndex.set(key, pat);
              patterns.push(pat);
            }
            f.fills.push({ type: 'IMAGE', id: pat.id, scaleMode: 'TILE', sf: r4(1 / pat.scale) }); // refined from the PNG size
            continue;
          }
          if (tiles && r.w * r.h < 0.25 * box.w * box.h) continue; // tiny one-axis repeats
          const abs = { x: area.x + r.x, y: area.y + r.y, w: r.w, h: r.h };
          const g = css.gradientGeometry(layer, abs);
          if (!g) continue;
          if (covers(abs, box) || tiles) f.fills.push(css.gradientPaint(g, box));
          else bgChildren.push({ rect: abs, paint: css.gradientPaint(g, abs) });
        }
      }
    }
    if (bgChildren.length) {
      const holder = {
        type: 'FRAME', name: 'Background', x: box.x, y: box.y, w: box.w, h: box.h, fills: [], clip: true, abs: true,
        children: bgChildren.map((bc) => ({ type: 'FRAME', img: bc.paint.type === 'IMAGE', name: 'Image', x: bc.rect.x, y: bc.rect.y, w: bc.rect.w, h: bc.rect.h, fills: [bc.paint], children: [], po: -1, dom: -1 })),
        po: -1, dom: -1,
      };
      if (radii) holder.radii = radii;
      f.children.push(holder);
    }

    // borders
    const sides = ['top', 'right', 'bottom', 'left'].map((sd, k) => ({ w: bw[k], c: css.parseColor(st[`border-${sd}-color`]), s: st[`border-${sd}-style`] }));
    const vis = sides.filter((x) => x.w > 0 && x.c && x.c.a > 0);
    const wedge = vis.length === 1 && borderWedge(sides, box);
    if (wedge) {
      // CSS triangle (dropdown caret…): one colored border mitered by two transparent ones.
      f.children.push({ type: 'SVG', name: 'Caret', x: box.x, y: box.y, w: box.w, h: box.h, svg: wedge, po: 1e9, dom: 1e9, abs: true });
    } else if (vis.length) {
      const same = vis.every((x) => sameColor(x.c, vis[0].c));
      if (same) {
        const weights = sides.map((x) => (x.w > 0 && x.c && x.c.a > 0 ? r2(x.w) : 0));
        f.strokes = { paints: [solid(vis[0].c)], weights, align: 'INSIDE' };
        const style = vis[0].s;
        if (style === 'dashed') f.strokes.dash = [r2(vis[0].w * 3), r2(vis[0].w * 3)];
        else if (style === 'dotted') f.strokes.dash = [r2(vis[0].w), r2(vis[0].w)];
      } else {
        const [t, r, b, l] = sides.map((x) => (x.w > 0 && x.c && x.c.a > 0 ? x : null));
        const mk = (x, rect) => ({ type: 'FRAME', name: 'Border', ...rect, fills: [solid(x.c)], children: [], po: 1e9, dom: 1e9, abs: true });
        if (t) f.children.push(mk(t, { x: box.x, y: box.y, w: box.w, h: t.w }));
        if (b) f.children.push(mk(b, { x: box.x, y: box.y + box.h - b.w, w: box.w, h: b.w }));
        if (l) f.children.push(mk(l, { x: box.x, y: box.y, w: l.w, h: box.h }));
        if (r) f.children.push(mk(r, { x: box.x + box.w - r.w, y: box.y, w: r.w, h: box.h }));
      }
    } else if (st['outline-style'] && st['outline-style'] !== 'none' && css.px(st['outline-width']) > 0) {
      const oc = css.parseColor(st['outline-color']);
      if (oc && oc.a > 0) f.strokes = { paints: [solid(oc)], weights: [1, 1, 1, 1].map(() => r2(css.px(st['outline-width']))), align: 'OUTSIDE' };
    }

    // effects
    const effects = [];
    for (const sh of css.parseShadows(st['box-shadow'])) {
      if (sh.color.a <= 0) continue;
      // "inset 0 -1px 0 0 color" is a separator line (Odoo list headers…): make it a real stroke.
      if (sh.inset && !sh.blur && !sh.spread && (!sh.x !== !sh.y) && insetLine(f, sh)) continue;
      effects.push({ type: sh.inset ? 'INNER_SHADOW' : 'DROP_SHADOW', c: sh.color, x: sh.x, y: sh.y, blur: sh.blur, spread: sh.spread });
    }
    const flt = parseFilter(st.filter);
    for (const sh of flt.shadows) effects.push({ type: 'DROP_SHADOW', c: sh.color, x: sh.x, y: sh.y, blur: sh.blur, spread: 0 });
    if (flt.blur > 0) effects.push({ type: 'LAYER_BLUR', radius: r2(flt.blur * 2) });
    const bflt = parseFilter(st['backdrop-filter']);
    if (bflt.blur > 0) effects.push({ type: 'BACKGROUND_BLUR', radius: r2(bflt.blur * 2) });
    if (effects.length) f.effects = effects;
    const blend = BLEND[st['mix-blend-mode']];
    if (blend) f.blend = blend;
    return flt;
  }

  /** Turn a one-sided inset shadow into a stroke on that side (false if it cannot merge). */
  function insetLine(f, sh) {
    const side = sh.y < 0 ? 2 : sh.y > 0 ? 0 : sh.x > 0 ? 3 : 1;
    const w = r2(Math.abs(sh.x || sh.y));
    const paint = solid(sh.color);
    if (!f.strokes) {
      const weights = [0, 0, 0, 0];
      weights[side] = w;
      f.strokes = { paints: [paint], weights, align: 'INSIDE' };
      return true;
    }
    const p0 = f.strokes.paints[0];
    const same = f.strokes.paints.length === 1 && !f.strokes.dash && f.strokes.align === 'INSIDE'
      && Math.abs(p0.color.r - paint.color.r) < 0.004 && Math.abs(p0.color.g - paint.color.g) < 0.004
      && Math.abs(p0.color.b - paint.color.b) < 0.004 && Math.abs(p0.opacity - paint.opacity) < 0.004;
    if (!same || f.strokes.weights[side]) return false;
    f.strokes.weights[side] = w;
    return true;
  }

  function covers(abs, box) {
    return abs.x <= box.x + 0.5 && abs.y <= box.y + 0.5 && abs.x + abs.w >= box.x + box.w - 0.5 && abs.y + abs.h >= box.y + box.h - 0.5;
  }

  function imagePaint(img, abs, box) {
    const W = Math.max(box.w, 0.01), H = Math.max(box.h, 0.01);
    const dx = abs.x - box.x, dy = abs.y - box.y;
    // FILL (= object-fit: cover, centered) when equivalent
    const k = Math.max(W / img.natW, H / img.natH);
    const cw = img.natW * k, ch = img.natH * k;
    if (Math.abs(cw - abs.w) < 1 && Math.abs(ch - abs.h) < 1 && Math.abs(dx - (W - cw) / 2) < 1 && Math.abs(dy - (H - ch) / 2) < 1) {
      return { type: 'IMAGE', id: img.id, scaleMode: 'FILL' };
    }
    return { type: 'IMAGE', id: img.id, scaleMode: 'CROP', t: [[r4(W / abs.w), 0, r4(-dx / abs.w)], [0, r4(H / abs.h), r4(-dy / abs.h)]] };
  }

  function layerName(node, tag, pseudo) {
    if (pseudo) return '::' + pseudo;
    const a = s.attrs(node);
    let n = SEMANTIC[tag] || tag;
    if (a.id) n += '#' + a.id;
    else if (a.class) n += '.' + a.class.trim().split(/\s+/).slice(0, 2).join('.');
    return n.slice(0, 64);
  }

  function makeFrame(node, li, st, b, tag, pseudo, o = {}) {
    const f = { type: 'FRAME', name: o.name || layerName(node, tag, pseudo), x: b.x, y: b.y, w: b.w, h: b.h, fills: [], children: [], po: s.po(li), dom: dom++ };
    const op = st.opacity === '' ? 1 : parseFloat(st.opacity);
    if (op < 1) f.opacity = r4(op);
    const hidden = st.visibility === 'hidden' || st.visibility === 'collapse';
    f._flt = hidden ? parseFilter('') : applyVisuals(f, st, b, o);
    if (clipsOverflow(st) || o.clip) f.clip = true;
    const z = parseInt(st['z-index'], 10);
    if (st.position !== 'static' && z < 0) f.zneg = z;
    if (st.position === 'absolute' || st.position === 'fixed' || f.zneg) f.abs = true;
    const { b: bw, p: pd } = edges(st);
    if (s.attrs(node)['data-o2f-target']) targetFrame = f;
    f._css = {
      disp: st.display, dir: st['flex-direction'], wrap: st['flex-wrap'], jc: st['justify-content'], ai: st['align-items'],
      stf: /^inline-/.test(st.display) || st.position === 'absolute' || st.position === 'fixed' || (st.float && st.float !== 'none'),
      pad: [bw[0] + pd[0], bw[1] + pd[1], bw[2] + pd[2], bw[3] + pd[3]],
    };
    const a = s.attrs(node);
    const role = !pseudo && TABLE_ROLES[st.display];
    if (role) {
      f._role = role;
      if (role === 'cell') {
        f._span = (parseInt(a.colspan, 10) || 1) > 1 || (parseInt(a.rowspan, 10) || 1) > 1;
        f._head = tag === 'th';
        f._css.cell = true; // sized by its row/column, never by its content
      } else if (role === 'group') f._head = st.display === 'table-header-group';
    }
    // Rotated element captured upright (see annotatePage): rotate the whole
    // frame, children included, around the browser's transform origin.
    const xf = a['data-o2f-xf'];
    if (xf) {
      const [ang, dx, dy] = xf.split(',').map(parseFloat);
      if ([ang, dx, dy].every(Number.isFinite)) f._xf = { a: ang, dx, dy };
    } else {
      const rot = rotationOf(st);
      if (rot != null) {
        const os = s.offsetSize(li);
        if (os && os.w > 0 && os.h > 0) f._rot = { a: rot, w: os.w, h: os.h, cx: b.x + b.w / 2, cy: b.y + b.h / 2 };
      }
    }
    // clip-path: rounded clip when it is a plain circle / inset, else a vector mask.
    const shape = clipShape(st['clip-path'], b);
    if (shape && shape.radii) { f.radii = shape.radii; f.clip = true; }
    else if (shape && shape.path) f.mask = shape.path;
    return f;
  }

  function shotItem(b, name, li, bare) {
    const id = 'shot' + idc++;
    const node = s.L.nodeIndex[li];
    const pseudo = s.pseudo.get(node) || null;
    const target = pseudo ? s.n.parentIndex[node] : node;
    shots.push({ id, x: b.x, y: b.y, w: b.w, h: b.h, backendId: s.n.backendNodeId[target], pseudo });
    const it = { type: 'FRAME', name, x: b.x, y: b.y, w: b.w, h: b.h, fills: [], children: [], po: s.po(li), dom: dom++ };
    const pos = s.style(li).position;
    if (pos === 'absolute' || pos === 'fixed') it.abs = true;
    // Keep the element's rounded corners and shadows around the pixels.
    if (!bare) applyVisuals(it, s.style(li), b, { noBackground: true });
    delete it.strokes;
    it.children = [];
    it.fills = [{ type: 'IMAGE', id, scaleMode: 'FILL' }];
    if (it.radii) it.clip = true;
    return it;
  }

  const fixedMemo = new Map();
  function hasFixedDescendant(node) {
    if (fixedMemo.has(node)) return fixedMemo.get(node);
    let found = false;
    for (const c of s.children[node]) {
      const li = s.boxLayout(c);
      if ((li >= 0 && s.style(li).position === 'fixed') || hasFixedDescendant(c)) { found = true; break; }
    }
    fixedMemo.set(node, found);
    return found;
  }

  function hasRenderedDescendant(node) {
    for (const c of s.children[node]) {
      if (s.layouts.has(c)) return true;
      if (hasRenderedDescendant(c)) return true;
    }
    return false;
  }

  // ----- owners (paragraph containers) -----------------------------------
  function makeOwner(frame, st) {
    return { frame, st, texts: [], decorated: [] };
  }

  function childInline(inl, st, tag, node, op, box) {
    const a = s.attrs(node);
    const out = { href: inl.href, deco: inl.deco, opacity: inl.opacity * op, textFill: inl.textFill };
    if (/text/.test(st['background-clip'] || '')) {
      const layer = css.parseBackgroundImage(st['background-image']).find((l) => l.kind !== 'none' && l.kind !== 'url');
      if (layer) out.textFill = css.gradientGeometry(layer, box);
    }
    if (tag === 'a' && a.href && !a.href.startsWith('javascript:')) out.href = absUrl(a.href, baseURL);
    const d = decoOf(st['text-decoration-line']);
    if (d && !out.deco) out.deco = d;
    return out;
  }

  function blockInline(inl, st, tag, node, box) {
    const a = s.attrs(node);
    const atomic = /^inline-/.test(st.display) || st.position === 'absolute' || st.position === 'fixed' || (st.float && st.float !== 'none');
    const out = { href: inl.href, deco: atomic ? '' : inl.deco, opacity: 1, textFill: null };
    if (tag === 'a' && a.href && !a.href.startsWith('javascript:')) out.href = absUrl(a.href, baseURL);
    const d = decoOf(st['text-decoration-line']);
    if (d && !out.deco) out.deco = d;
    if (/text/.test(st['background-clip'] || '')) {
      const layer = css.parseBackgroundImage(st['background-image']).find((l) => l.kind !== 'none' && l.kind !== 'url');
      if (layer) out.textFill = css.gradientGeometry(layer, box);
    }
    return out;
  }

  // ----- text -------------------------------------------------------------
  function handleTextLayout(li, ctx) {
    const st = s.style(li);
    if (st.visibility === 'hidden' || st.visibility === 'collapse') return;
    const boxes = s.boxes.get(li);
    if (!boxes || !boxes.length) return;
    const txt = s.text(li);
    if (!txt) return;
    let color = css.parseColor(st['-webkit-text-fill-color']);
    if (!color) color = css.parseColor(st.color) || BLACK;
    const grad = ctx.inl.textFill;
    if (!grad && color.a * ctx.inl.opacity <= 0.002 && (!st['text-shadow'] || st['text-shadow'] === 'none')) return;
    if (isIconText(st, txt)) {
      const fa = fa4.isFontAwesome4(st['font-family']);
      for (const bx of boxes) {
        const t = txt.substring(bx.start, bx.start + bx.len).trim();
        if (!t || bx.w <= 0 || bx.h <= 0) continue;
        // Font Awesome 4: real vector glyph from the font-awesome package
        const vec = fa ? fa4.iconSvg(t, css.px(st['font-size']) || 16, { ...color, a: color.a * ctx.inl.opacity }) : null;
        if (vec) {
          ctx.frame.children.push({ type: 'SVG', name: vec.name, x: bx.x, y: bx.y, w: vec.w, h: vec.h, svg: vec.svg, po: s.po(li), dom: dom++ });
          faCount++;
          continue;
        }
        const id = 'icon' + idc++;
        const it = { type: 'FRAME', img: true, name: 'Icon', x: bx.x, y: bx.y, w: bx.w, h: bx.h, fills: [{ type: 'IMAGE', id, scaleMode: 'FILL' }], children: [], po: s.po(li), dom: dom++ };
        if (ctx.inl.opacity < 1) it.opacity = r4(ctx.inl.opacity);
        icons.push({
          id, text: t, color: st.color || 'black', rgba: { ...color },
          font: `${st['font-style'] || 'normal'} ${st['font-weight'] || 400} ${st['font-size'] || '16px'} ${st['font-family']}`,
          css: {
            fontFamily: st['font-family'], fontSize: st['font-size'], fontWeight: st['font-weight'], fontStyle: st['font-style'],
            fontFeatureSettings: st['font-feature-settings'] || 'normal', fontVariationSettings: st['font-variation-settings'] || 'normal',
            color: st.color || 'black', letterSpacing: st['letter-spacing'] || 'normal',
          },
          w: bx.w, h: bx.h, node: it,
        });
        ctx.frame.children.push(it);
      }
      return;
    }
    const item = { li, txt, boxes, style: runStyle(st, ctx.inl, grad ? null : color, grad || null), po: s.po(li), dom: dom++, ws: st['white-space'] };
    ctx.owner.texts.push(item);
    for (const rec of ctx.deco) rec.texts.push(item);
  }

  function groupLines(frs) {
    frs.sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x);
    const lines = [];
    for (const f of frs) {
      const line = lines[lines.length - 1];
      if (line) {
        const top = Math.max(line.top, f.y), bot = Math.min(line.bottom, f.y + f.h);
        if (bot - top >= 0.5 * Math.min(f.h, line.bottom - line.top)) {
          line.frags.push(f);
          line.top = Math.min(line.top, f.y);
          line.bottom = Math.max(line.bottom, f.y + f.h);
          continue;
        }
      }
      lines.push({ frags: [f], top: f.y, bottom: f.y + f.h });
    }
    return lines;
  }

  function buildTextChunks(owner) {
    const frags = [];
    for (const it of owner.texts) {
      const pre = /^pre/.test(it.ws || '') || it.ws === 'break-spaces';
      for (const bx of it.boxes) {
        let t = it.txt.substring(bx.start, bx.start + bx.len);
        t = t.replace(/[\u200B\u200C\u200D\u2060\uFEFF\u00AD]/g, '');
        // Layout text is the raw DOM text: collapse whitespace like the browser does.
        t = pre ? t.replace(/[\r\n]/g, '') : t.replace(/[ \t\r\n\f]+/g, ' ');
        if (!t.length) continue;
        if (bx.w <= 0.01 && !t.trim()) continue;
        frags.push({ x: bx.x, y: bx.y, w: bx.w, h: bx.h, t, it, pre });
      }
    }
    if (!frags.length) return [];
    const rtl = owner.st.direction === 'rtl';
    const align = alignOf(owner.st);
    const lines = groupLines(frags);

    // Segments: runs of horizontally contiguous fragments on a line
    const segLines = [];
    for (const line of lines) {
      line.frags.sort((a, b) => (rtl ? b.x - a.x : a.x - b.x));
      const segs = [];
      let seg = null;
      for (const f of line.frags) {
        if (seg) {
          const prev = seg[seg.length - 1];
          const gap = rtl ? prev.x - (f.x + f.w) : f.x - (prev.x + prev.w);
          // sup/sub and other baseline shifts get their own layer
          const shift = Math.abs(f.y + f.h * 0.8 - (prev.y + prev.h * 0.8));
          const tol = Math.max(2, 0.15 * Math.min(styles[f.it.style].sz, styles[prev.it.style].sz));
          if (Math.abs(gap) <= 1.25 && shift <= tol) { seg.push(f); continue; }
        }
        seg = [f];
        segs.push(seg);
      }
      segLines.push(segs.map(segInfo).filter(Boolean));
    }

    const chunks = [];
    let cur = null;
    const flush = () => { if (cur) chunks.push(cur); cur = null; };
    for (const segs of segLines) {
      if (!segs.length) continue;
      if (segs.length === 1) {
        const sg = segs[0];
        if (cur && compatible(cur, sg, align)) { cur.lines.push(sg); continue; }
        flush();
        cur = { lines: [sg], single: false };
        continue;
      }
      flush();
      for (const sg of segs) chunks.push({ lines: [sg], single: true });
    }
    flush();
    const irs = chunks.map((ch) => chunkToIR(ch, align));
    // text-overflow: ellipsis / -webkit-line-clamp → native Figma truncation
    const ost = owner.st;
    const ellipsis = ost['text-overflow'] === 'ellipsis' && clipsOverflow(ost);
    const clamp = parseInt(ost['-webkit-line-clamp'], 10);
    if (ellipsis || clamp > 0) {
      const { b: bw, p: pd } = edges(ost);
      const fb = owner.frame;
      const right = fb.x + fb.w - bw[1] - pd[1];
      irs.forEach((ir) => {
        const lines = ir.chars.split('\n').length;
        if (clamp > 0 && irs.length === 1 && lines > clamp) ir.trunc = { w: r2(right - ir.x), lines: clamp };
        else if (ellipsis && ir.x + ir.w > right + 0.5) ir.trunc = { w: r2(right - ir.x), lines };
      });
      // line-clamp: Chrome drops the hidden lines; give Figma the rest so it can add "…" itself.
      const last = irs[irs.length - 1];
      if (clamp > 0 && last && !last.trunc) {
        const norm = (t) => t.replace(/\s+/g, ' ').trim();
        const full = norm(owner.texts.map((it) => it.txt).join(''));
        const shown = norm(irs.map((ir) => ir.chars).join(' '));
        if (full.length > shown.length + 1 && full.startsWith(shown.slice(0, 20))) {
          const rest = full.slice(shown.length).trim();
          const run = last.runs[last.runs.length - 1];
          last.chars += ' ' + rest;
          run[1] = last.chars.length;
          last.trunc = { w: r2(right - last.x), lines: last.chars.split('\n').length };
        }
      }
    }
    return irs;
  }

  function segInfo(frs) {
    const pieces = frs.map((f) => ({ t: f.t, st: f.it.style, pre: f.pre }));
    // trim trailing whitespace (invisible at line end)
    let trimmed = 0;
    while (pieces.length) {
      const last = pieces[pieces.length - 1];
      if (last.pre) break;
      const nt = last.t.replace(/[ \t]+$/, '');
      trimmed += last.t.length - nt.length;
      if (nt.length) { last.t = nt; break; }
      pieces.pop();
    }
    if (!pieces.length || !pieces.some((p) => p.t.trim().length)) return null;
    let ref = frs[0];
    for (const f of frs) if (styles[f.it.style].sz > styles[ref.it.style].sz + 0.01 && f.t.trim()) ref = f;
    const x0 = Math.min(...frs.map((f) => f.x));
    let x1 = Math.max(...frs.map((f) => f.x + f.w));
    if (trimmed) x1 -= trimmed * styles[ref.it.style].sz * 0.28;
    return {
      pieces, x0, x1, top: ref.y, refH: ref.h, sz: styles[ref.it.style].sz, lh: styles[ref.it.style].lh,
      po: Math.min(...frs.map((f) => f.it.po)), dom: Math.min(...frs.map((f) => f.it.dom)),
    };
  }

  function anchorOf(sg, align) {
    if (align === 'C') return (sg.x0 + sg.x1) / 2;
    if (align === 'R') return sg.x1;
    return sg.x0;
  }

  function compatible(cur, sg, align) {
    const first = cur.lines[0], last = cur.lines[cur.lines.length - 1];
    if (Math.abs(anchorOf(sg, align) - anchorOf(first, align)) > 2) return false;
    if (Math.abs(sg.sz - first.sz) > 0.5 || Math.abs(sg.refH - first.refH) > 1) return false;
    const pitch = cur.lines.length >= 2 ? (last.top - first.top) / (cur.lines.length - 1) : sg.top - last.top;
    if (pitch <= 0 || pitch > Math.max(3 * sg.sz, 3 * sg.refH)) return false;
    if (cur.lines.length >= 2 && Math.abs(sg.top - (last.top + pitch)) > 1.5) return false;
    return true;
  }

  function chunkToIR(ch, align) {
    const n = ch.lines.length;
    const first = ch.lines[0];
    let L;
    if (n >= 2) L = (ch.lines[n - 1].top - first.top) / (n - 1);
    else L = first.lh != null ? first.lh : first.refH;
    L = Math.max(L, 1);
    const wrap = align === 'J' && n >= 2 && !ch.single;
    let chars = '';
    const runs = [];
    const add = (t, st) => {
      if (!t) return;
      const s0 = chars.length;
      chars += t;
      const last = runs[runs.length - 1];
      if (last && last[2] === st) last[1] = chars.length;
      else runs.push([s0, chars.length, st]);
    };
    ch.lines.forEach((ln, i) => {
      if (i > 0) add(wrap ? ' ' : '\n', runs[runs.length - 1][2]);
      ln.pieces.forEach((p, k) => add(i > 0 && k === 0 && !p.pre ? p.t.replace(/^[ \t]+/, '') : p.t, p.st));
    });
    const x0 = Math.min(...ch.lines.map((l) => l.x0));
    const x1 = Math.max(...ch.lines.map((l) => l.x1));
    const a = ch.single ? 'L' : align === 'J' ? 'L' : align;
    const ax = a === 'C' ? (first.x0 + first.x1) / 2 : a === 'R' ? x1 : x0;
    const y = first.top - (L - first.refH) / 2;
    textCount++;
    const ir = {
      type: 'TEXT', name: chars.replace(/\s+/g, ' ').trim().slice(0, 48) || 'Text',
      x: r2(x0), y: r2(y), w: r2(x1 - x0), h: r2(L * n), anchor: a, ax: r2(ax),
      align: ch.single ? 'LEFT' : { L: 'LEFT', C: 'CENTER', R: 'RIGHT', J: 'JUSTIFIED' }[align],
      lh: r2(L), chars, runs, mode: wrap ? 'wrap' : 'lines',
      po: Math.min(...ch.lines.map((l) => l.po)), dom: Math.min(...ch.lines.map((l) => l.dom)),
    };
    const gs = runs.map((r) => styles[r[2]].grad).find(Boolean);
    if (gs) ir.gradFill = css.gradientPaint(gs, { x: x0, y, w: Math.max(1, x1 - x0), h: L * n });
    const st0 = styles[runs[0][2]];
    if (st0 && st0.sh) ir.effects = st0.sh.map((x) => ({ type: 'DROP_SHADOW', c: x.c, x: x.x, y: x.y, blur: x.blur, spread: 0 }));
    return ir;
  }

  function decoratedRects(rec) {
    const st = rec.st;
    const { b: bw, p: pd } = edges(st);
    let rects = [];
    const frs = [];
    for (const it of rec.texts) for (const bx of it.boxes) if (bx.w > 0) frs.push({ ...bx });
    const lines = frs.length ? groupLines(frs) : [];
    if (lines.length <= 1) {
      if (rec.bounds.w > 0 && rec.bounds.h > 0) rects = [rec.bounds];
    } else {
      lines.forEach((ln, i) => {
        const x0 = Math.min(...ln.frags.map((f) => f.x)) - (i === 0 ? pd[3] + bw[3] : 0);
        const x1 = Math.max(...ln.frags.map((f) => f.x + f.w)) + (i === lines.length - 1 ? pd[1] + bw[1] : 0);
        rects.push({ x: x0, y: ln.top - pd[0] - bw[0], w: x1 - x0, h: ln.bottom - ln.top + pd[0] + pd[2] + bw[0] + bw[2] });
      });
    }
    return rects.map((r) => {
      const f = { type: 'FRAME', name: layerName(rec.node, s.name(rec.node).toLowerCase(), s.pseudo.get(rec.node)), x: r.x, y: r.y, w: r.w, h: r.h, fills: [], children: [], po: rec.po, dom: rec.dom };
      applyVisuals(f, st, r);
      return f;
    });
  }

  function finalizeOwner(owner) {
    const chunks = owner.texts.length ? buildTextChunks(owner) : [];
    for (const t of chunks) owner.frame.children.push(t);
    // Inline backgrounds (highlights, badges, <code>…) must stay below the text they decorate.
    for (const rec of owner.decorated) {
      let po = rec.po, dm = rec.dom;
      for (const t of chunks) {
        if (t.po <= po && t.dom < dm && rec.texts.length) { po = t.po; dm = t.dom - 0.5; }
      }
      for (const r of decoratedRects(rec)) { r.po = po; r.dom = dm; r.abs = true; owner.frame.children.push(r); }
    }
  }

  // ----- form controls ----------------------------------------------------
  function formText(frame, st, b, text, color, o) {
    const { b: bw, p: pd } = edges(st);
    const cb = insetBox(b, bw[0] + pd[0], bw[1] + pd[1], bw[2] + pd[2], bw[3] + pd[3]);
    const sz = css.px(st['font-size']) || 13.33;
    const lh = st['line-height'] && st['line-height'] !== 'normal' ? css.px(st['line-height']) : sz * 1.2;
    const style = runStyle(st, { href: null, deco: '', opacity: 1, textFill: null }, color, null);
    const align = o.align || alignOf(st);
    const y = o.vcenter ? cb.y + (cb.h - lh) / 2 : cb.y;
    const ax = align === 'C' ? cb.x + cb.w / 2 : align === 'R' ? cb.x + cb.w : cb.x;
    frame.children.push({
      type: 'TEXT', name: text.slice(0, 48), x: r2(cb.x), y: r2(y), w: r2(cb.w), h: r2(lh), anchor: o.wrap ? 'L' : align, ax: r2(ax),
      align: { L: 'LEFT', C: 'CENTER', R: 'RIGHT', J: 'JUSTIFIED' }[align], lh: r2(lh), chars: text, runs: [[0, text.length, style]],
      mode: o.wrap ? 'wrap' : 'lines', po: frame.po, dom: dom++,
    });
    textCount++;
    frame.clip = true;
  }

  function handleForm(node, li, st, b, tag, ctx) {
    const a = s.attrs(node);
    const appearanceNone = st.appearance === 'none';
    if (tag === 'input') {
      const type = (a.type || 'text').toLowerCase();
      if (type === 'hidden') return;
      if (type === 'range') {
        // The thumb lives in the UA shadow tree and overflows the track: capture with a margin.
        const cy = b.y + b.h / 2, hh = Math.max(b.h, 28);
        ctx.frame.children.push(shotItem({ x: b.x - 10, y: cy - hh / 2, w: b.w + 20, h: hh }, 'Slider', li, true));
        return;
      }
      if (NATIVE_INPUTS.has(type) && (!appearanceNone || type === 'color' || type === 'file')) { ctx.frame.children.push(shotItem(b, 'Input ' + type, li)); return; }
      const f = makeFrame(node, li, st, b, tag, null);
      ctx.frame.children.push(f);
      if (type === 'submit' || type === 'button' || type === 'reset') {
        const v = s.inputValue.get(node) || a.value || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
        if (v) formText(f, st, b, v, css.parseColor(st.color) || BLACK, { align: 'C', vcenter: true });
        return;
      }
      if (type === 'image') {
        const img = images.get(absUrl(a.src, baseURL));
        if (img) f.fills.push({ type: 'IMAGE', id: img.id, scaleMode: 'FILL' });
        return;
      }
      if (TEXT_INPUTS.has(type) || !NATIVE_INPUTS.has(type)) {
        let v = s.inputValue.get(node) || '';
        let color = css.parseColor(st['-webkit-text-fill-color']) || css.parseColor(st.color) || BLACK;
        if (v && type === 'password') v = '\u2022'.repeat(v.length);
        if (!v && a.placeholder) { v = a.placeholder; color = css.parseColor(a['data-o2f-phc']) || { r: 0.46, g: 0.46, b: 0.46, a: 1 }; }
        if (v) formText(f, st, b, v, color, { vcenter: true });
      }
      return;
    }
    if (tag === 'textarea') {
      const f = makeFrame(node, li, st, b, tag, null);
      ctx.frame.children.push(f);
      let v = s.textValue.get(node) || '';
      let color = css.parseColor(st.color) || BLACK;
      if (!v && a.placeholder) { v = a.placeholder; color = css.parseColor(a['data-o2f-phc']) || { r: 0.46, g: 0.46, b: 0.46, a: 1 }; }
      if (v) formText(f, st, b, v, color, { wrap: true });
      return;
    }
    if (tag === 'select') {
      if (!appearanceNone) { ctx.frame.children.push(shotItem(b, 'Select', li)); return; }
      const f = makeFrame(node, li, st, b, tag, null);
      ctx.frame.children.push(f);
      const opts2 = [];
      const collect = (n) => { for (const c of s.children[n]) { if (s.name(c).toLowerCase() === 'option') opts2.push(c); else collect(c); } };
      collect(node);
      const sel = opts2.find((o) => s.selected.has(o)) || opts2[0];
      if (sel != null) {
        const t = s.children[sel].map((c) => s.value(c)).join('').replace(/\s+/g, ' ').trim();
        if (t) formText(f, st, b, t, css.parseColor(st.color) || BLACK, { vcenter: true, align: 'L' });
      }
    }
  }

  // ----- tree walk --------------------------------------------------------
  function walkChildren(node, ctx) {
    for (const c of s.children[node]) walk(c, ctx);
  }

  function walk(node, ctx) {
    const type = s.type(node);
    if (type === 3) {
      for (const li of s.textLayouts(node)) handleTextLayout(li, ctx);
      return;
    }
    if (type === 9 || type === 11) { walkChildren(node, ctx); return; }
    if (type !== 1) return;
    const rawName = s.name(node);
    const tag = rawName.toLowerCase();
    const pseudo = s.pseudo.get(node) || null;
    if (!pseudo && SKIP_TAGS.has(tag)) return;
    if (pseudo && pseudo !== 'before' && pseudo !== 'after' && pseudo !== 'marker' && pseudo !== 'first-letter') return;
    const li = s.boxLayout(node);
    if (li < 0) {
      walkChildren(node, ctx);
      for (const tl of s.textLayouts(node)) handleTextLayout(tl, ctx);
      return;
    }
    const st = s.style(li);
    if (st.display === 'none') return;
    // Fixed elements (modals, bars, chat bubbles) paint in the root stacking
    // context: hoist them to the top level so they stack like in the browser.
    if (st.position === 'fixed' && rootRef && ctx.frame !== rootRef) ctx = { ...ctx, frame: rootRef };
    const b = s.bounds(li);
    const op = st.opacity === '' ? 1 : parseFloat(st.opacity);
    if (op <= 0.002) return;
    // Off-page subtrees are skipped, except zero-size anchors (e.g. Odoo's
    // o-overlay-item at the bottom edge) and containers of fixed elements
    // (modals, bars), which are laid out elsewhere.
    const offPage = b.x >= vw + 1 || b.x + b.w <= -1 || b.y >= docH || b.y + b.h <= top - 1;
    if (offPage && b.w > 0 && b.h > 0 && (st.position === 'fixed' || st.position === 'absolute' || clipsOverflow(st)) && !hasFixedDescendant(node)) return;
    const a = s.attrs(node);

    // Inline SVG
    if (tag === 'svg' && !pseudo) {
      if (b.w < 0.5 || b.h < 0.5) return;
      const key = a['data-o2f-svg'];
      const markup = key && svgs[key];
      if (markup) {
        const it = { type: 'SVG', name: a['aria-label'] || (a.class ? 'svg.' + a.class.split(/\s+/)[0] : 'SVG'), x: b.x, y: b.y, w: b.w, h: b.h, svg: markup, po: s.po(li), dom: dom++ };
        if (st.position === 'absolute' || st.position === 'fixed') it.abs = true;
        if (op < 1) it.opacity = r4(op);
        ctx.frame.children.push(it);
      } else ctx.frame.children.push(shotItem(b, 'SVG', li));
      return;
    }
    if (s.type(s.n.parentIndex[node]) === 1 && /^[a-z]/.test(rawName) && tag !== 'svg' && s.name(s.n.parentIndex[node]) === s.name(s.n.parentIndex[node]).toLowerCase() && !pseudo && rawName !== rawName.toUpperCase()) {
      // SVG/MathML children are handled by their root
      return;
    }

    // Images
    if (tag === 'img') {
      if (b.w < 0.5 || b.h < 0.5) return;
      ctx.frame.children.push(...imageItems(node, li, st, b, tag, op));
      return;
    }
    if (tag === 'canvas' && a['data-o2f-svg'] && svgs[a['data-o2f-svg']] && b.w >= 1 && b.h >= 1) {
      // Chart.js chart rebuilt as vectors by annotatePage
      const it = { type: 'SVG', name: 'Chart', x: b.x, y: b.y, w: b.w, h: b.h, svg: svgs[a['data-o2f-svg']], po: s.po(li), dom: dom++ };
      if (st.position === 'absolute' || st.position === 'fixed') it.abs = true;
      // pixels kept as a fallback if Figma cannot read the SVG
      it.fallback = shotItem(b, 'Chart', li, true).fills[0].id;
      ctx.frame.children.push(it);
      return;
    }
    if (SHOT_TAGS.has(tag)) {
      if (b.w < 1 || b.h < 1) return;
      ctx.frame.children.push(shotItem(b, SEMANTIC[tag] || tag, li));
      return;
    }
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (b.w < 0.5 || b.h < 0.5) return;
      handleForm(node, li, st, b, tag, ctx);
      return;
    }

    // Masked / clipped leaves are rasterized for fidelity
    // (basic clip-path shapes become vector masks instead, see clipShape)
    const masked = (st['mask-image'] && st['mask-image'] !== 'none') || (st['-webkit-mask-image'] && st['-webkit-mask-image'] !== 'none')
      || (st['clip-path'] && st['clip-path'] !== 'none' && !clipShape(st['clip-path'], b));
    if (masked && b.w >= 1 && b.h >= 1 && !hasRenderedDescendant(node) && st.visibility !== 'hidden') {
      ctx.frame.children.push(shotItem(b, layerName(node, tag, pseudo), li));
      return;
    }

    const isInline = st.display === 'inline' || st.display === 'contents' || st.display === 'ruby' || st.display === 'ruby-text';
    if (isInline) {
      const inl = childInline(ctx.inl, st, tag, node, op, b);
      let deco = ctx.deco;
      const hidden = st.visibility === 'hidden';
      if (!hidden && hasBoxDecoration(st)) {
        const rec = { node, li, st, texts: [], po: s.po(li), dom: dom++, bounds: b };
        ctx.owner.decorated.push(rec);
        deco = deco.concat([rec]);
      }
      const ctx2 = { frame: ctx.frame, owner: ctx.owner, inl, deco };
      walkChildren(node, ctx2);
      for (const tl of s.textLayouts(node)) handleTextLayout(tl, ctx2);
      return;
    }

    const frame = makeFrame(node, li, st, b, tag, pseudo);
    ctx.frame.children.push(frame);
    const owner = makeOwner(frame, st);
    const ctx2 = { frame, owner, inl: blockInline(ctx.inl, st, tag, node, b), deco: [] };
    walkChildren(node, ctx2);
    for (const tl of s.textLayouts(node)) handleTextLayout(tl, ctx2);
    finalizeOwner(owner);
  }

  function hasBoxDecoration(st) {
    const bg = css.parseColor(st['background-color']);
    if (!isTransparent(bg) && !/text/.test(st['background-clip'] || '')) return true;
    if (st['background-image'] && st['background-image'] !== 'none' && !/text/.test(st['background-clip'] || '')) return true;
    if (st['box-shadow'] && st['box-shadow'] !== 'none') return true;
    const { b: bw } = edges(st);
    return bw.some((w, k) => w > 0 && !isTransparent(css.parseColor(st[`border-${['top', 'right', 'bottom', 'left'][k]}-color`])));
  }

  // Images are never rebuilt: the original file is placed as an image layer,
  // with the same crop (object-fit / object-position) and rounded clipping.
  function imageItems(node, li, st, b, tag, op) {
    const a = s.attrs(node);
    const src = s.srcURL.get(node) || absUrl(a.src, baseURL);
    const img = src ? images.get(src) : null;
    const { b: bw, p: pd } = edges(st);
    const cb = insetBox(b, bw[0] + pd[0], bw[1] + pd[1], bw[2] + pd[2], bw[3] + pd[3]);
    const name = a.alt ? 'Image: ' + a.alt.slice(0, 40) : 'Image';
    const f = makeFrame(node, li, st, b, tag, null, { name });
    f.img = true;
    const cr = clipPathRadii(st['clip-path'], b);
    if (cr) { f.radii = cr; f.clip = true; }
    if (!img) return [f];
    const flt = f._flt || parseFilter('');
    const fit = st['object-fit'] || 'fill';

    // object-fit / object-position
    const iw = img.natW, ih = img.natH;
    let dw = cb.w, dh = cb.h;
    if (fit === 'cover' || fit === 'contain' || fit === 'scale-down') {
      let k = fit === 'cover' ? Math.max(cb.w / iw, cb.h / ih) : Math.min(cb.w / iw, cb.h / ih);
      if (fit === 'scale-down') k = Math.min(1, k);
      dw = iw * k; dh = ih * k;
    } else if (fit === 'none') { dw = iw; dh = ih; }
    const pos = css.splitSpaces(st['object-position'] || '50% 50%');
    const dx = css.parseLength(pos[0] || '50%', cb.w - dw);
    const dy = css.parseLength(pos[1] || '50%', cb.h - dh);
    const abs = { x: cb.x + dx, y: cb.y + dy, w: dw, h: dh };
    const filters = imageFilters(flt);
    const sameBox = Math.abs(cb.x - b.x) < 0.5 && Math.abs(cb.y - b.y) < 0.5 && Math.abs(cb.w - b.w) < 0.5 && Math.abs(cb.h - b.h) < 0.5;
    const imageLayer = (box, paint) => ({ type: 'FRAME', img: true, name, x: box.x, y: box.y, w: box.w, h: box.h, fills: [paint], children: [], po: f.po, dom: dom++ });
    if (covers(abs, cb)) {
      const paint = fit === 'fill' && Math.abs(iw / ih - cb.w / cb.h) > 0.01
        ? { type: 'IMAGE', id: img.id, scaleMode: 'CROP', t: [[1, 0, 0], [0, 1, 0]] }
        : imagePaint(img, abs, cb);
      if (filters) paint.filters = filters;
      // An image layer cannot hold a vector mask: masked pictures get a frame.
      if (sameBox && !f.mask) { f.fills.push(paint); return [f]; }
      // padding / border around the picture: frame + image layer inside
      f.img = false;
      f.name = 'Image frame';
      f.children.push(imageLayer(cb, paint));
      return [f];
    }
    // contain / none: the picture is smaller than its box
    const paint = { type: 'IMAGE', id: img.id, scaleMode: 'CROP', t: [[1, 0, 0], [0, 1, 0]] };
    if (filters) paint.filters = filters;
    f.img = false;
    f.name = 'Image frame';
    f.clip = true;
    f.children.push(imageLayer(abs, paint));
    return [f];
  }

  /**
   * clip-path → { radii } for a plain circle / rounded inset that matches the box,
   * or { path } (SVG path data in the element's local coordinates) for any other
   * basic shape (polygon, inset, circle, ellipse, path). null when unsupported.
   */
  function clipShape(v, b) {
    if (!v || v === 'none') return null;
    const m = /^(polygon|inset|circle|ellipse|path)\((.*)\)\s*(border-box|padding-box|content-box|margin-box)?$/.exec(v.trim());
    if (!m) return null;
    const W = b.w, H = b.h, n = (x) => r2(x);
    const kind = m[1], args = m[2].trim();
    const ellipsePath = (cx, cy, rx, ry) => {
      const k = 0.5523;
      return `M ${n(cx - rx)} ${n(cy)} C ${n(cx - rx)} ${n(cy - ry * k)} ${n(cx - rx * k)} ${n(cy - ry)} ${n(cx)} ${n(cy - ry)} `
        + `C ${n(cx + rx * k)} ${n(cy - ry)} ${n(cx + rx)} ${n(cy - ry * k)} ${n(cx + rx)} ${n(cy)} `
        + `C ${n(cx + rx)} ${n(cy + ry * k)} ${n(cx + rx * k)} ${n(cy + ry)} ${n(cx)} ${n(cy + ry)} `
        + `C ${n(cx - rx * k)} ${n(cy + ry)} ${n(cx - rx)} ${n(cy + ry * k)} ${n(cx - rx)} ${n(cy)} Z`;
    };
    const at = (str) => {
      const p = css.splitSpaces(str || '50% 50%');
      const kw = { left: '0%', center: '50%', right: '100%', top: '0%', bottom: '100%' };
      return [css.parseLength(kw[p[0]] || p[0] || '50%', W), css.parseLength(kw[p[1]] || p[1] || '50%', H)];
    };
    if (kind === 'polygon') {
      const pts = css.splitCommas(args.replace(/^(nonzero|evenodd)\s*,/, '')).map((pt) => {
        const xy = css.splitSpaces(pt);
        return [css.parseLength(xy[0], W), css.parseLength(xy[1], H)];
      });
      if (pts.length < 3) return null;
      // A polygon that is just the box itself clips nothing.
      const isBox = pts.length === 4 && pts.every(([x, y]) => (Math.abs(x) < 0.5 || Math.abs(x - W) < 0.5) && (Math.abs(y) < 0.5 || Math.abs(y - H) < 0.5));
      if (isBox) return null;
      return { path: 'M ' + pts.map(([x, y]) => `${n(x)} ${n(y)}`).join(' L ') + ' Z' };
    }
    if (kind === 'inset') {
      const [ins, round] = args.split(/\s+round\s+/);
      const t = css.splitSpaces(ins);
      const T = css.parseLength(t[0], H), R = css.parseLength(t[1] != null ? t[1] : t[0], W);
      const B = css.parseLength(t[2] != null ? t[2] : t[0], H), L = css.parseLength(t[3] != null ? t[3] : (t[1] != null ? t[1] : t[0]), W);
      const r = round ? css.parseLength(css.splitSpaces(round)[0], Math.min(W, H)) : 0;
      if (T < 0.5 && R < 0.5 && B < 0.5 && L < 0.5) return r > 0 ? { radii: [r, r, r, r].map((x) => n(Math.min(x, Math.min(W, H) / 2))) } : null;
      return { path: `M ${n(L)} ${n(T)} L ${n(W - R)} ${n(T)} L ${n(W - R)} ${n(H - B)} L ${n(L)} ${n(H - B)} Z` };
    }
    if (kind === 'circle' || kind === 'ellipse') {
      const [size, pos] = args.split(/\s*\bat\b\s*/);
      const [cx, cy] = at(pos);
      const side = (s0, axisLen, c) => {
        if (!s0 || s0 === 'closest-side') return Math.min(c, axisLen - c);
        if (s0 === 'farthest-side') return Math.max(c, axisLen - c);
        return css.parseLength(s0, axisLen);
      };
      let rx, ry;
      const sz = css.splitSpaces(size || '');
      if (kind === 'circle') {
        const s0 = sz[0];
        const ref = Math.hypot(W, H) / Math.SQRT2;
        rx = ry = !s0 || s0 === 'closest-side' ? Math.min(cx, W - cx, cy, H - cy)
          : s0 === 'farthest-side' ? Math.max(cx, W - cx, cy, H - cy) : css.parseLength(s0, ref);
      } else { rx = side(sz[0], W, cx); ry = side(sz[1], H, cy); }
      if (rx <= 0 || ry <= 0) return null;
      // Centered circle that touches the box → just round the corners.
      if (Math.abs(rx - W / 2) < 0.5 && Math.abs(ry - H / 2) < 0.5 && Math.abs(cx - W / 2) < 0.5 && Math.abs(cy - H / 2) < 0.5) {
        return { radii: [W / 2, W / 2, W / 2, W / 2].map(n) };
      }
      return { path: ellipsePath(cx, cy, rx, ry) };
    }
    const d = /^["'](.*)["']$/.exec(args.replace(/^(nonzero|evenodd)\s*,\s*/, ''));
    return d ? { path: d[1] } : null;
  }

  /** clip-path: circle()/ellipse()/inset(… round r) → corner radii (other shapes are ignored). */
  function clipPathRadii(v, b) {
    if (!v || v === 'none') return null;
    const m = /^(circle|ellipse|inset)\((.*)\)$/.exec(v.trim());
    if (!m) return null;
    const half = Math.min(b.w, b.h) / 2;
    if (m[1] === 'inset') {
      const round = /round\s+(.+)$/.exec(m[2]);
      if (!round) return null;
      const r = css.parseLength(css.splitSpaces(round[1])[0], Math.min(b.w, b.h));
      return r > 0 ? [r, r, r, r].map((x) => r2(Math.min(x, half))) : null;
    }
    return [half, half, half, half].map(r2);
  }

  // ----- root -------------------------------------------------------------
  let html = -1;
  for (const c of s.children[0] || []) if (s.type(c) === 1 && s.name(c).toLowerCase() === 'html') html = c;
  if (html < 0) throw new Error('Empty document: no <html> element.');
  let body = -1;
  for (const c of s.children[html]) if (s.type(c) === 1 && s.name(c).toLowerCase() === 'body') body = c;
  const htmlLi = s.boxLayout(html);
  const bodyLi = body >= 0 ? s.boxLayout(body) : -1;
  const htmlSt = htmlLi >= 0 ? s.style(htmlLi) : {};
  const bodySt = bodyLi >= 0 ? s.style(bodyLi) : htmlSt;
  const htmlBg = css.parseColor(htmlSt['background-color']);
  const useHtml = !isTransparent(htmlBg) || (htmlSt['background-image'] && htmlSt['background-image'] !== 'none');
  const canvasSt = useHtml ? htmlSt : bodySt;

  const rootBox = { x: 0, y: top, w: vw, h: docH - top };
  const root = { type: 'FRAME', name: 'Page', x: 0, y: top, w: vw, h: docH - top, fills: [], children: [], clip: true, po: 0, dom: dom++ };
  rootRef = root;
  const canvasColor = css.parseColor(canvasSt['background-color']);
  if (!canvasColor || canvasColor.a < 1) root.fills.push(solid({ r: 1, g: 1, b: 1, a: 1 }));
  applyVisuals(root, { ...canvasSt, 'box-shadow': 'none', filter: 'none', 'backdrop-filter': 'none', 'border-top-style': 'none', 'border-right-style': 'none', 'border-bottom-style': 'none', 'border-left-style': 'none', 'border-top-left-radius': '0px', 'border-top-right-radius': '0px', 'border-bottom-right-radius': '0px', 'border-bottom-left-radius': '0px', 'outline-style': 'none', 'mix-blend-mode': 'normal' }, rootBox);
  delete root.radii;

  const rootOwner = makeOwner(root, bodySt);
  const ctx0 = { frame: root, owner: rootOwner, inl: { href: null, deco: '', opacity: 1, textFill: null }, deco: [] };
  for (const c of s.children[html]) {
    if (c === body) {
      const bodyOp = bodySt.opacity === '' ? 1 : parseFloat(bodySt.opacity || '1');
      if (bodyOp <= 0.002) continue;
      walkChildren(body, ctx0);
    } else walk(c, ctx0);
  }
  finalizeOwner(rootOwner);

  // ----- tables → columns of cells (clean, resizable auto layout) ---------
  // In the browser a row's border/background sits under its cells; in Figma a
  // frame's stroke is hidden by opaque children. Row (and table) paint is moved
  // onto the cells, then rows sharing the same columns are rebuilt column by
  // column: Table → Columns (horizontal) → Column (vertical) → cells. Rows whose
  // cells span several columns stay full-width rows between the column blocks.
  const sameSolid = (a, b) => a && b && a.type === 'SOLID' && b.type === 'SOLID'
    && Math.abs(a.color.r - b.color.r) < 0.004 && Math.abs(a.color.g - b.color.g) < 0.004
    && Math.abs(a.color.b - b.color.b) < 0.004 && Math.abs((a.opacity ?? 1) - (b.opacity ?? 1)) < 0.004;

  /** Add a border on one side of a cell (keeps the cell's own borders). */
  function pushStroke(cell, side, w, paint) {
    if (!w) return;
    if (!cell.strokes) {
      const weights = [0, 0, 0, 0];
      weights[side] = w;
      cell.strokes = { paints: [paint], weights, align: 'INSIDE' };
    } else if (cell.strokes.paints.length === 1 && sameSolid(cell.strokes.paints[0], paint) && !cell.strokes.weights[side]) {
      cell.strokes.weights[side] = w;
    }
  }

  /** Move a container's background and borders onto the cells of its rows. */
  function paintDown(holder, rows) {
    if (!rows.length) return;
    if (holder.fills.length) {
      for (const r of rows) for (const c of r.cells) if (!c.fills.length) c.fills = holder.fills.map((p) => ({ ...p }));
      holder.fills = [];
    }
    const s = holder.strokes;
    if (s && s.paints.length === 1 && s.paints[0].type === 'SOLID' && !s.dash) {
      const [t, rt, b, l] = s.weights, p = s.paints[0];
      for (const c of rows[0].cells) pushStroke(c, 0, t, p);
      for (const c of rows[rows.length - 1].cells) pushStroke(c, 2, b, p);
      for (const r of rows) { pushStroke(r.cells[0], 3, l, p); pushStroke(r.cells[r.cells.length - 1], 1, rt, p); }
      delete holder.strokes;
    }
  }

  const textOf = (n) => {
    if (n.type === 'TEXT') return n.chars.replace(/\s+/g, ' ').trim();
    for (const c of n.children || []) { const t = textOf(c); if (t) return t; }
    return '';
  };

  function rebuildTable(t) {
    const rows = [];
    const others = [];
    for (const c of t.children) {
      if (c.abs || c.type !== 'FRAME') { others.push(c); continue; }
      if (c._role === 'group') {
        const own = c.children.filter((r) => r._role === 'row' && !r.abs);
        if (own.length !== c.children.length) return; // unexpected content: leave the table as it is
        const before = rows.length;
        for (const r of own) rows.push({ r, head: c._head });
        paintDown(c, rows.slice(before).map((x) => rowInfo(x.r)));
      } else if (c._role === 'row') rows.push({ r: c, head: false });
      else others.push(c);
    }
    if (!rows.length) return;
    // Empty filler rows (no content, almost no height) are dropped.
    const infos = rows.map((x) => ({ ...rowInfo(x.r), head: x.head }))
      .filter((ri) => ri.r.h >= 1.5 || ri.r.children.some((c) => textOf(c)))
      .sort((a, b) => a.r.y - b.r.y); // sticky headers paint last but sit on top
    for (const ri of infos) paintDown(ri.r, [ri]);
    paintDown(t, infos.filter((ri) => ri.cells.length));

    // The column grid is given by the most frequent row structure (the body).
    const count = new Map();
    for (const ri of infos) if (ri.regular && ri.cells.length >= 2) count.set(ri.sig, (count.get(ri.sig) || 0) + 1);
    let gridSig = null, best = 0;
    for (const [sig, nb] of count) if (nb > best) { best = nb; gridSig = sig; }
    const grid = gridSig ? infos.find((ri) => ri.sig === gridSig).cells.map((c) => ({ x: c.x, w: c.w })) : null;

    // Consecutive rows that fit the grid become one block of columns.
    const blocks = [];
    for (const ri of infos) {
      const fit = grid ? fitToGrid(ri, grid) : null;
      const prev = blocks[blocks.length - 1];
      if (fit && prev && prev.grid) prev.rows.push(fit);
      else blocks.push({ grid: !!fit, rows: [fit || ri] });
    }
    const flow = [];
    for (const bl of blocks) {
      if (!bl.grid) { for (const ri of bl.rows) flow.push(ri.r); continue; }
      flow.push(columnsBlock(bl.rows, grid));
    }
    flow.sort((a, b) => a.y - b.y);
    t.children = [...flow, ...others];
  }

  function rowInfo(r) {
    const kids = r.children.filter((c) => !c.abs);
    const cells = kids.filter((c) => c._role === 'cell').sort((a, b) => a.x - b.x);
    const regular = cells.length === kids.length && cells.length > 0 && r.children.length === kids.length
      && !cells.some((c) => c._span) && !r.effects;
    const sig = cells.map((c) => `${Math.round(c.x)}:${Math.round(c.w)}`).join('|');
    return { r, cells, regular, sig };
  }

  /**
   * Match a row's cells to the grid columns: { ...row, slots: [cell|null per column], extras }.
   * Missing columns get an empty cell later; a few cells that match no column
   * (offset sticky headers…) stay absolutely positioned. null if the row does not fit.
   */
  function fitToGrid(ri, grid) {
    if (!ri.regular) return null;
    const slots = grid.map(() => null);
    const extras = [];
    for (const c of ri.cells) {
      const j = grid.findIndex((g) => Math.abs(g.x - c.x) <= 1.5 && Math.abs(g.w - c.w) <= 1.5);
      if (j >= 0 && !slots[j]) slots[j] = c; else extras.push(c);
    }
    // A cell pushed aside by position: sticky (the optional-columns toggler over
    // the actions column…) goes back to the empty column of its width, in DOM order.
    for (const e of extras.slice()) {
      const j = slots.findIndex((x, k) => !x && Math.abs(grid[k].w - e.w) <= 1.5
        && slots.slice(0, k).every((o) => !o || o.dom < e.dom) && slots.slice(k + 1).every((o) => !o || o.dom > e.dom));
      if (j < 0) continue;
      shiftNode(e, grid[j].x - e.x, 0);
      slots[j] = e;
      extras.splice(extras.indexOf(e), 1);
    }
    const missing = slots.filter((x) => !x).length;
    if (missing === grid.length || (missing > 2 && missing > grid.length / 4) || extras.length > 2) return null;
    return { ...ri, slots, extras };
  }

  function shiftNode(n, dx, dy) {
    n.x = r2(n.x + dx); n.y = r2(n.y + dy);
    if (n.ax != null) n.ax = r2(n.ax + dx);
    if (n.rot) { n.rot.cx += dx; n.rot.cy += dy; }
    for (const c of n.children || []) shiftNode(c, dx, dy);
  }

  function blankCell(ri, col, k) {
    const ref = ri.cells[0];
    return {
      type: 'FRAME', name: '', x: col.x, y: ri.r.y, w: col.w, h: ri.r.h, children: [],
      fills: ref ? ref.fills.map((p) => ({ ...p })) : [],
      strokes: ref && ref.strokes ? { ...ref.strokes, weights: [ref.strokes.weights[0], 0, ref.strokes.weights[2], 0] } : undefined,
      po: ref ? ref.po : 0, dom: ref ? ref.dom + k / 1000 : 0, _role: 'cell',
    };
  }

  function columnsBlock(rows, grid) {
    const top = Math.min(...rows.map((ri) => ri.r.y));
    const bottom = Math.max(...rows.map((ri) => ri.r.y + ri.r.h));
    const n = grid.length;
    rows.forEach((ri) => { ri.cells = ri.slots.map((c, k) => c || blankCell(ri, grid[k], k)); });
    const cols = [];
    let bodyIndex = 0;
    const labels = [];
    for (let k = 0; k < n; k++) {
      const head = rows.find((ri) => ri.head || (ri.slots[k] && ri.slots[k]._head));
      labels.push((head && textOf(head.cells[k])) || rows.map((ri) => textOf(ri.cells[k])).find(Boolean) || `Column ${k + 1}`);
    }
    rows.forEach((ri) => {
      const isHead = ri.head || ri.cells.every((c) => c._head);
      if (!isHead) bodyIndex++;
      ri.cells.forEach((c, k) => { c.name = `${isHead ? 'Header' : 'Row ' + bodyIndex} — ${labels[k]}`.slice(0, 64); });
    });
    for (let k = 0; k < n; k++) {
      const cells = rows.map((ri) => ri.cells[k]);
      const col = {
        type: 'FRAME', name: `Column — ${labels[k]}`.slice(0, 64), x: cells[0].x, y: top, w: cells[0].w, h: bottom - top,
        fills: [], children: cells, po: Math.min(...cells.map((c) => c.po)), dom: Math.min(...cells.map((c) => c.dom)),
      };
      roundBox(col);
      const al = fitAutoLayout(col, { disp: 'flex', dir: 'column', pad: [0, 0, 0, 0], stf: true });
      if (al) { col.al = al; alCount++; }
      frameCount++;
      cols.push(col);
    }
    const x0 = Math.min(...cols.map((c) => c.x));
    const x1 = Math.max(...cols.map((c) => c.x + c.w));
    // Cells that match no column keep their place, outside the column flow.
    const extras = rows.flatMap((ri) => ri.extras || []);
    for (const e of extras) e.abs = true;
    const block = {
      type: 'FRAME', name: 'Columns', x: x0, y: top, w: x1 - x0, h: bottom - top, fills: [], children: [...cols, ...extras],
      po: Math.min(...cols.map((c) => c.po)), dom: Math.min(...cols.map((c) => c.dom)),
    };
    roundBox(block);
    const al = fitAutoLayout(block, { disp: 'flex', dir: 'row', pad: [0, 0, 0, 0], stf: true });
    if (al) { block.al = al; alCount++; }
    frameCount++;
    return block;
  }

  function roundBox(n) { n.x = r2(n.x); n.y = r2(n.y); n.w = r2(n.w); n.h = r2(n.h); }

  // ----- finalize: paint order, pruning, rounding -------------------------
  let frameCount = 0;
  let alCount = 0;
  function finalize(f) {
    const kept = [];
    for (const c of f.children) {
      if (c.type === 'FRAME') {
        finalize(c);
        // Empty table cells are kept: they hold the grid together.
        if (!c.children.length && !c.fills.length && !c.strokes && !c.effects && c._role !== 'cell') continue;
      }
      kept.push(c);
    }
    // Negative z-index children paint below normal-flow content (Chrome's
    // paintOrders index does not reflect that inside stacking contexts).
    kept.sort((a, b) => (a.zneg || 0) - (b.zneg || 0) || a.po - b.po || a.dom - b.dom);
    f.children = kept;
    // A transparent wrapper paints when its content paints.
    if (!f.fills.length && !f.strokes && !f.effects && kept.length) {
      let m = Infinity;
      for (const c of kept) if (c.po >= 0 && c.po < m) m = c.po;
      if (m !== Infinity && m > f.po) f.po = m;
    }
    if (f._role === 'table') rebuildTable(f);
    if (f._xf) {
      // Captured upright: rotate the whole frame (children included) in Figma.
      f.rot = { a: r4(f._xf.a), cx: r2(f.x + f.w / 2 + f._xf.dx), cy: r2(f.y + f.h / 2 + f._xf.dy) };
      f.abs = true;
    } else if (f._rot && !f.children.length) {
      const rt = f._rot;
      f.rot = { a: r4(rt.a), cx: r2(rt.cx), cy: r2(rt.cy) };
      f.w = rt.w; f.h = rt.h;
      f.x = rt.cx - rt.w / 2; f.y = rt.cy - rt.h / 2;
      f.abs = true;
    }
    delete f._rot;
    delete f._xf;
    delete f._flt;
    f.x = r2(f.x); f.y = r2(f.y); f.w = r2(f.w); f.h = r2(f.h);
    for (const c of f.children) if (c.type !== 'FRAME') { c.x = r2(c.x); c.y = r2(c.y); c.w = r2(c.w); c.h = r2(c.h); }
    const al = fitAutoLayout(f, f._css || { disp: 'block', pad: [0, 0, 0, 0] });
    if (al) { f.al = al; alCount++; }
    delete f._css;
    frameCount++;
  }
  if (scope === 'viewport') pruneOutside(root, rootBox);
  finalize(root);
  const strip = (n) => {
    delete n.po; delete n.dom; delete n.zneg;
    delete n._role; delete n._span; delete n._head;
    if (n.type === 'SVG' || n.type === 'TEXT') { n.x = r2(n.x); n.y = r2(n.y); n.w = r2(n.w); n.h = r2(n.h); }
    if (n.children) n.children.forEach(strip);
  };
  strip(root);
  // 'element' scope: the tagged element becomes the exported frame (e.g. a modal)
  let out = root;
  if (scope === 'element') {
    const inTree = (n) => n === targetFrame || (n.children || []).some(inTree);
    if (!targetFrame || !inTree(root)) {
      throw new Error('This element has no exportable rendering (invisible, empty or inline in text): pick its container, or export the screen (scope "viewport").');
    }
    out = targetFrame;
    delete out.abs;
  }

  return { root: out, styles, shots, icons, patterns, stats: { frames: frameCount, autoLayout: alCount, texts: textCount, icons: icons.length, faVectors: faCount, shots: shots.length } };
}

const { fitAutoLayout } = require('./autolayout');

/** Drop layers that are entirely outside `box` (keeps ancestors of visible layers). */
function pruneOutside(n, box) {
  if (!n.children) return;
  n.children = n.children.filter((c) => {
    pruneOutside(c, box);
    const inside = c.x < box.x + box.w && c.x + c.w > box.x && c.y < box.y + box.h && c.y + c.h > box.y;
    return inside || (c.children && c.children.length);
  });
}

/** Resize the root <svg> of an SVG document to w×h, keeping its viewBox. */
function fitSvg(svg, w, h) {
  let out = svg.replace(/<\?xml[^>]*\?>/g, '').replace(/<!DOCTYPE[^>]*>/gi, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  const m = /<svg\b[^>]*>/i.exec(out);
  if (!m) return out;
  let tag = m[0];
  const attr = (n) => { const r = new RegExp(`\\s${n}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag); return r ? (r[2] != null ? r[2] : r[3]) : null; };
  const W0 = parseFloat(attr('width')), H0 = parseFloat(attr('height'));
  if (!attr('viewBox') && W0 && H0) tag = tag.replace(/<svg\b/i, `<svg viewBox="0 0 ${W0} ${H0}"`);
  tag = tag.replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*')/gi, '');
  tag = tag.replace(/<svg\b/i, `<svg width="${r2(w)}" height="${r2(h)}"`);
  if (!/xmlns=/.test(tag)) tag = tag.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return out.slice(0, m.index) + tag + out.slice(m.index + m[0].length);
}

module.exports = { PROPS, Snap, buildIR, collectImageUrls, fitSvg };
