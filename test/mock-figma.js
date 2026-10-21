'use strict';
// Minimal, strict mock of the Figma plugin API used by figma-plugin/code.js.
// It validates the values passed to the API the way Figma does (types,
// ranges, loaded fonts) so that errors surface in Node before reaching Figma.

const assert = (cond, msg) => { if (!cond) throw new Error('[figma-mock] ' + msg); };
const finite = (v, what) => assert(typeof v === 'number' && Number.isFinite(v), `${what} must be a finite number (got ${v})`);
const unit = (v, what) => { finite(v, what); assert(v >= 0 && v <= 1, `${what} out of [0,1]: ${v}`); };
const onlyKeys = (o, keys, what) => { for (const k of Object.keys(o)) assert(keys.includes(k), `Unrecognized key '${k}' in ${what}`); };

function checkRGB(c, what, withA) {
  assert(c && typeof c === 'object', `${what} missing`);
  onlyKeys(c, withA ? ['r', 'g', 'b', 'a'] : ['r', 'g', 'b'], what);
  unit(c.r, what + '.r'); unit(c.g, what + '.g'); unit(c.b, what + '.b');
  if (withA) unit(c.a, what + '.a');
}
function checkTransform(t, what) {
  assert(Array.isArray(t) && t.length === 2 && t.every((r) => Array.isArray(r) && r.length === 3), `${what} must be 2x3`);
  t.flat().forEach((v, i) => finite(v, `${what}[${i}]`));
}
function checkPaints(list, images) {
  assert(Array.isArray(list), 'paints must be an array');
  for (const p of list) {
    if (p.type === 'SOLID') {
      onlyKeys(p, ['type', 'color', 'opacity', 'visible', 'blendMode'], 'SolidPaint');
      checkRGB(p.color, 'SolidPaint.color', false);
      if (p.opacity != null) unit(p.opacity, 'SolidPaint.opacity');
    } else if (p.type === 'IMAGE') {
      onlyKeys(p, ['type', 'imageHash', 'scaleMode', 'imageTransform', 'scalingFactor', 'filters', 'opacity', 'visible', 'rotation'], 'ImagePaint');
      assert(images.has(p.imageHash), 'unknown imageHash');
      assert(['FILL', 'FIT', 'CROP', 'TILE'].includes(p.scaleMode), 'bad scaleMode ' + p.scaleMode);
      if (p.imageTransform) checkTransform(p.imageTransform, 'imageTransform');
      if (p.scalingFactor != null) { finite(p.scalingFactor, 'scalingFactor'); assert(p.scalingFactor > 0, 'scalingFactor <= 0'); }
      if (p.filters) { onlyKeys(p.filters, ['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows'], 'filters'); Object.values(p.filters).forEach((v) => { finite(v, 'filter'); assert(v >= -1 && v <= 1, 'filter range'); }); }
    } else if (/^GRADIENT_(LINEAR|RADIAL|ANGULAR|DIAMOND)$/.test(p.type)) {
      onlyKeys(p, ['type', 'gradientTransform', 'gradientStops', 'opacity', 'visible', 'blendMode'], 'GradientPaint');
      checkTransform(p.gradientTransform, 'gradientTransform');
      assert(Array.isArray(p.gradientStops) && p.gradientStops.length >= 1, 'gradientStops');
      p.gradientStops.forEach((s) => { onlyKeys(s, ['position', 'color'], 'ColorStop'); unit(s.position, 'stop.position'); checkRGB(s.color, 'stop.color', true); });
    } else throw new Error('[figma-mock] unknown paint type ' + p.type);
  }
}
function checkEffects(list) {
  for (const e of list) {
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      onlyKeys(e, ['type', 'color', 'offset', 'radius', 'spread', 'visible', 'blendMode', 'showShadowBehindNode'], e.type);
      checkRGB(e.color, 'shadow.color', true);
      finite(e.offset.x, 'offset.x'); finite(e.offset.y, 'offset.y');
      finite(e.radius, 'radius'); assert(e.radius >= 0, 'radius < 0');
      finite(e.spread, 'spread');
      assert(e.blendMode === 'NORMAL', 'blendMode');
    } else if (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') {
      onlyKeys(e, ['type', 'radius', 'visible', 'blurType'], e.type);
      finite(e.radius, 'blur radius'); assert(e.radius >= 0, 'blur < 0');
    } else throw new Error('[figma-mock] unknown effect ' + e.type);
  }
}

let nextId = 1;
class BaseNode {
  constructor(type) {
    this.id = '1:' + nextId++;
    this.type = type;
    this.name = type;
    this.parent = null;
    this.removed = false;
    this._x = 0; this._y = 0; this._w = 100; this._h = 100;
    this._opacity = 1;
    this._effects = [];
    this._fills = [];
  }
  get x() { return this._x; } set x(v) { finite(v, 'x'); this._x = v; }
  get y() { return this._y; } set y(v) { finite(v, 'y'); this._y = v; }
  get width() { return this._w; } get height() { return this._h; }
  resize(w, h) { finite(w, 'width'); finite(h, 'height'); assert(w >= 0.01 && h >= 0.01, `resize too small ${w}x${h}`); this._w = w; this._h = h; }
  rescale(k) { finite(k, 'scale'); assert(k > 0.01, 'scale'); this._w *= k; this._h *= k; }
  get opacity() { return this._opacity; } set opacity(v) { unit(v, 'opacity'); this._opacity = v; }
  get effects() { return this._effects; } set effects(v) { checkEffects(v); this._effects = v; }
  get fills() { return this._fills; } set fills(v) { checkPaints(v, mock.images); this._fills = v; }
  set relativeTransform(t) { checkTransform(t, 'relativeTransform'); this._rt = t; this._x = t[0][2]; this._y = t[1][2]; }
  get relativeTransform() { return this._rt || [[1, 0, this._x], [0, 1, this._y]]; }
  set blendMode(v) { assert(typeof v === 'string', 'blendMode'); this._blend = v; }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; this.removed = true; }
  // auto layout child properties
  set layoutPositioning(v) {
    assert(['AUTO', 'ABSOLUTE'].includes(v), 'layoutPositioning ' + v);
    assert(this.parent && this.parent._layoutMode && this.parent._layoutMode !== 'NONE', 'layoutPositioning requires an auto layout parent');
    this._lp = v;
  }
  set constraints(v) {
    onlyKeys(v, ['horizontal', 'vertical'], 'constraints');
    for (const k of ['horizontal', 'vertical']) assert(['MIN', 'CENTER', 'MAX', 'STRETCH', 'SCALE'].includes(v[k]), 'constraint ' + v[k]);
    this._cons = v;
  }
  set layoutAlign(v) {
    assert(['MIN', 'CENTER', 'MAX', 'STRETCH', 'INHERIT'].includes(v), 'layoutAlign ' + v);
    assert(this.parent && this.parent._layoutMode && this.parent._layoutMode !== 'NONE', 'layoutAlign requires an auto layout parent');
    this._la = v;
  }
}
class FrameNode extends BaseNode {
  constructor() { super('FRAME'); this.children = []; this._fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]; this.clipsContent = true; this._layoutMode = 'NONE'; }
  set layoutMode(v) { assert(['NONE', 'HORIZONTAL', 'VERTICAL'].includes(v), 'layoutMode ' + v); this._layoutMode = v; mock.counts.AL += v !== 'NONE' ? 1 : 0; }
  get layoutMode() { return this._layoutMode; }
  _needAL(what) { assert(this._layoutMode !== 'NONE', what + ' requires layoutMode'); }
  set primaryAxisSizingMode(v) { this._needAL('primaryAxisSizingMode'); assert(['FIXED', 'AUTO'].includes(v), 'sizing ' + v); }
  set counterAxisSizingMode(v) { this._needAL('counterAxisSizingMode'); assert(['FIXED', 'AUTO'].includes(v), 'sizing ' + v); }
  set layoutWrap(v) { assert(this._layoutMode === 'HORIZONTAL', 'wrap needs HORIZONTAL'); assert(['NO_WRAP', 'WRAP'].includes(v), 'wrap'); }
  set counterAxisSpacing(v) { finite(v, 'counterAxisSpacing'); }
  set itemSpacing(v) { finite(v, 'itemSpacing'); }
  set paddingTop(v) { finite(v, 'padding'); assert(v >= 0, 'padding < 0'); }
  set paddingRight(v) { finite(v, 'padding'); assert(v >= 0, 'padding < 0'); }
  set paddingBottom(v) { finite(v, 'padding'); assert(v >= 0, 'padding < 0'); }
  set paddingLeft(v) { finite(v, 'padding'); assert(v >= 0, 'padding < 0'); }
  set primaryAxisAlignItems(v) { assert(['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'].includes(v), 'primaryAxisAlignItems ' + v); }
  set counterAxisAlignItems(v) { assert(['MIN', 'CENTER', 'MAX', 'BASELINE'].includes(v), 'counterAxisAlignItems ' + v); }
  appendChild(n) { assert(n instanceof BaseNode, 'appendChild arg'); if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = this; this.children.push(n); }
  insertChild(i, n) {
    assert(n instanceof BaseNode, 'insertChild arg'); assert(Number.isInteger(i) && i >= 0 && i <= this.children.length, 'insertChild index ' + i);
    if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1);
    n.parent = this; this.children.splice(Math.min(i, this.children.length), 0, n);
  }
  findOne(fn) { for (const c of this.children) { if (fn(c)) return c; if (c.findOne) { const r = c.findOne(fn); if (r) return r; } } return null; }
  set strokes(v) { checkPaints(v, mock.images); this._strokes = v; } get strokes() { return this._strokes || []; }
  set strokeAlign(v) { assert(['INSIDE', 'OUTSIDE', 'CENTER'].includes(v), 'strokeAlign ' + v); }
  set strokeWeight(v) { finite(v, 'strokeWeight'); assert(v >= 0, 'strokeWeight'); }
  set strokeTopWeight(v) { finite(v, 'strokeTopWeight'); assert(v >= 0, 'w'); }
  set strokeRightWeight(v) { finite(v, 'strokeRightWeight'); assert(v >= 0, 'w'); }
  set strokeBottomWeight(v) { finite(v, 'strokeBottomWeight'); assert(v >= 0, 'w'); }
  set strokeLeftWeight(v) { finite(v, 'strokeLeftWeight'); assert(v >= 0, 'w'); }
  set dashPattern(v) { assert(Array.isArray(v), 'dash'); v.forEach((x) => { finite(x, 'dash'); assert(x >= 0, 'dash'); }); }
  set cornerRadius(v) { finite(v, 'cornerRadius'); assert(v >= 0, 'radius'); }
  set topLeftRadius(v) { finite(v, 'radius'); } set topRightRadius(v) { finite(v, 'radius'); }
  set bottomLeftRadius(v) { finite(v, 'radius'); } set bottomRightRadius(v) { finite(v, 'radius'); }
}
class VectorNode extends BaseNode {
  constructor() { super('VECTOR'); }
  set isMask(v) { assert(typeof v === 'boolean', 'isMask'); assert(this.parent, 'isMask on a detached node'); this._mask = v; }
  get isMask() { return !!this._mask; }
}
class RectangleNode extends FrameNode {
  constructor() { super(); this.type = 'RECTANGLE'; delete this.children; }
  appendChild() { throw new Error('[figma-mock] rectangles have no children'); }
  set clipsContent(v) { if (v !== undefined && this.type === 'RECTANGLE') throw new Error('[figma-mock] rectangles have no clipsContent'); }
  lockAspectRatio() { this._locked = true; mock.counts.LOCKED++; }
}
class TextNode extends BaseNode {
  constructor() { super('TEXT'); this._chars = ''; this._font = { family: 'Inter', style: 'Regular' }; this._size = 12; this._lh = null; this.autoResize = 'NONE'; }
  get fontName() { return this._font; }
  set fontName(f) { assert(mock.loaded.has(f.family + '|' + f.style), `font not loaded: ${f.family} ${f.style}`); this._font = f; }
  get characters() { return this._chars; }
  set characters(v) { assert(typeof v === 'string', 'characters'); assert(mock.loaded.has(this._font.family + '|' + this._font.style), 'font of node not loaded before characters'); this._chars = v; this._layout(); }
  set lineHeight(v) { onlyKeys(v, ['value', 'unit'], 'lineHeight'); finite(v.value, 'lineHeight'); this._lh = v.value; this._layout(); }
  _range(s, e) { assert(Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e <= this._chars.length && s < e, `bad range ${s}-${e} (len ${this._chars.length})`); }
  setRangeFontName(s, e, f) { this._range(s, e); assert(mock.loaded.has(f.family + '|' + f.style), `range font not loaded: ${f.family} ${f.style}`); }
  setRangeFontSize(s, e, v) { this._range(s, e); finite(v, 'fontSize'); assert(v >= 1, 'fontSize < 1'); this._size = Math.max(this._size, v); this._layout(); }
  setRangeFills(s, e, v) { this._range(s, e); checkPaints(v, mock.images); }
  setRangeLetterSpacing(s, e, v) { this._range(s, e); onlyKeys(v, ['value', 'unit'], 'letterSpacing'); finite(v.value, 'ls'); }
  setRangeTextDecoration(s, e, v) { this._range(s, e); assert(['NONE', 'UNDERLINE', 'STRIKETHROUGH'].includes(v), 'decoration ' + v); }
  setRangeTextCase(s, e, v) { this._range(s, e); assert(['ORIGINAL', 'UPPER', 'LOWER', 'TITLE', 'SMALL_CAPS', 'SMALL_CAPS_FORCED'].includes(v), 'textCase ' + v); }
  setRangeHyperlink(s, e, v) { this._range(s, e); assert(v.type === 'URL' && typeof v.value === 'string', 'hyperlink'); }
  set textAlignHorizontal(v) { assert(['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED'].includes(v), 'align ' + v); }
  set textTruncation(v) { assert(['DISABLED', 'ENDING'].includes(v), 'textTruncation'); this._trunc = v; }
  set maxLines(v) { assert(this._trunc === 'ENDING', 'maxLines requires textTruncation ENDING'); assert(Number.isInteger(v) && v >= 1, 'maxLines'); }
  set textAutoResize(v) { assert(['NONE', 'WIDTH_AND_HEIGHT', 'HEIGHT', 'TRUNCATE'].includes(v), 'autoResize'); this.autoResize = v; this._layout(); }
  _layout() {
    const lines = this._chars.split('\n');
    if (this.autoResize === 'WIDTH_AND_HEIGHT') this._w = Math.max(1, Math.max(...lines.map((l) => l.length)) * this._size * 0.5);
    this._h = (this._lh || this._size * 1.2) * lines.length;
  }
}

const mock = {
  images: new Set(),
  loaded: new Set(),
  available: [],
  messages: [],
  counts: { FRAME: 0, RECT: 0, TEXT: 0, SVG: 0, IMAGE: 0, AL: 0, LOCKED: 0 },
};

function makeFigma(fonts) {
  mock.available = fonts;
  const page = new FrameNode();
  page.type = 'PAGE';
  page.selection = [];
  const ui = { onmessage: null, postMessage: (m) => mock.messages.push(m), resize() {} };
  const storage = {};
  return {
    showUI() {},
    ui,
    clientStorage: { getAsync: async (k) => storage[k], setAsync: async (k, v) => { storage[k] = v; } },
    notify: (t) => mock.messages.push({ type: 'notify', text: t }),
    listAvailableFontsAsync: async () => mock.available.map(([family, style]) => ({ fontName: { family, style } })),
    loadFontAsync: async (f) => {
      assert(mock.available.some(([a, b]) => a === f.family && b === f.style), `font unavailable ${f.family} ${f.style}`);
      mock.loaded.add(f.family + '|' + f.style);
    },
    createFrame: () => { mock.counts.FRAME++; return new FrameNode(); },
    createRectangle: () => { mock.counts.RECT++; return new RectangleNode(); },
    createText: () => { mock.counts.TEXT++; return new TextNode(); },
    createImage: (bytes) => {
      assert(bytes instanceof Uint8Array, 'createImage expects Uint8Array');
      const png = bytes[0] === 0x89 && bytes[1] === 0x50, jpg = bytes[0] === 0xff && bytes[1] === 0xd8, gif = bytes[0] === 0x47 && bytes[1] === 0x49;
      assert(png || jpg || gif, 'Image type is unsupported');
      const hash = 'h' + mock.images.size;
      mock.images.add(hash);
      mock.counts.IMAGE++;
      return { hash };
    },
    createNodeFromSvg: (svg) => {
      assert(typeof svg === 'string' && /<svg/i.test(svg), 'createNodeFromSvg expects svg markup');
      mock.counts.SVG++;
      const f = new FrameNode();
      const w = /<svg[^>]*\swidth="([\d.]+)"/.exec(svg), h = /<svg[^>]*\sheight="([\d.]+)"/.exec(svg);
      f._w = w ? parseFloat(w[1]) : 100; f._h = h ? parseFloat(h[1]) : 100;
      for (let k = 0; k < (svg.match(/<path\b/g) || []).length; k++) { const v = new VectorNode(); f.appendChild(v); }
      return f;
    },
    currentPage: page,
    viewport: { center: { x: 0, y: 0 }, scrollAndZoomIntoView() {} },
  };
}

module.exports = { makeFigma, mock };
