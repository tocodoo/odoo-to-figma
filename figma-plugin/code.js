// Odoo To Figma – plugin main thread.
// Receives the page capture (IR) from the UI and turns it into Figma layers.

var SETTINGS_KEY = 'o2f-settings';

figma.showUI(__html__, { width: 360, height: 540, themeColors: true, title: 'Odoo To Figma' });

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

var SYSTEM_SANS = ['SF Pro Text', 'SF Pro', 'Helvetica Neue', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'Inter'];
var GENERIC = {
  'sans-serif': ['Helvetica', 'Helvetica Neue', 'Arial', 'Inter'],
  'system-ui': SYSTEM_SANS,
  '-apple-system': SYSTEM_SANS,
  'blinkmacsystemfont': SYSTEM_SANS,
  'ui-sans-serif': SYSTEM_SANS,
  'serif': ['Times New Roman', 'Times', 'Georgia', 'Noto Serif'],
  'ui-serif': ['New York', 'Times New Roman', 'Georgia', 'Noto Serif'],
  'monospace': ['Menlo', 'SF Mono', 'Monaco', 'Courier New', 'Roboto Mono'],
  'ui-monospace': ['SF Mono', 'Menlo', 'Monaco', 'Roboto Mono'],
  'cursive': ['Comic Sans MS', 'Apple Chancery'],
  'fantasy': ['Papyrus', 'Impact'],
  'emoji': [], // emoji fonts render blank in Figma: keep the text font, Figma falls back per glyph
  'math': ['STIX Two Math', 'Cambria Math'],
};
var IGNORED_FAMILIES = /^(odoo unicode support noto|apple color emoji|segoe ui emoji|segoe ui symbol|noto color emoji|android emoji|emojisymbols|emojione mozilla|twemoji mozilla)$/i;

var fontIndex = null;
var fontCache = {};

function parseStyleName(style) {
  var s = style.toLowerCase().replace(/[\s_-]/g, '');
  var italic = /italic|oblique/.test(s);
  var w = 400;
  if (/thin|hairline/.test(s)) w = 100;
  else if (/extralight|ultralight/.test(s)) w = 200;
  else if (/semibold|demibold|demi/.test(s)) w = 600;
  else if (/extrabold|ultrabold/.test(s)) w = 800;
  else if (/black|heavy/.test(s)) w = 900;
  else if (/bold/.test(s)) w = 700;
  else if (/medium/.test(s)) w = 500;
  else if (/light/.test(s)) w = 300;
  var odd = /condensed|narrow|compressed|expanded|extended|wide|semicond|extracond/.test(s);
  return { style: style, w: w, italic: italic, odd: odd };
}

/** Normalized family key: case, accents, spaces and dashes are ignored ("Söhne" = "sohne"). */
function familyKey(name) {
  var s = String(name);
  try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* no Unicode normalization */ }
  return s.toLowerCase().replace(/[\s_\-'"]+/g, '');
}

/** Candidate spellings for a CSS family name ("sohne-var" → "sohne", "InterVariable" → "Inter"). */
function familyCandidates(name) {
  var out = [name];
  var stripped = name.replace(/[\s_-]*(variable|var|vf|web|webfont|regular)$/i, '');
  if (stripped && stripped !== name) out.push(stripped);
  return out;
}

async function getFontIndex() {
  if (fontIndex) return fontIndex;
  var list = await figma.listAvailableFontsAsync();
  fontIndex = {};
  for (var i = 0; i < list.length; i++) {
    var fn = list[i].fontName;
    var key = familyKey(fn.family);
    if (!fontIndex[key]) fontIndex[key] = { family: fn.family, styles: [] };
    fontIndex[key].styles.push(parseStyleName(fn.style));
  }
  return fontIndex;
}

function pickStyle(styles, weight, italic) {
  var best = null, bestScore = Infinity;
  for (var i = 0; i < styles.length; i++) {
    var s = styles[i];
    var score = Math.abs(s.w - weight) + (s.italic !== italic ? 1000 : 0) + (s.odd ? 300 : 0);
    if (weight >= 500 && s.w < weight) score += 1;
    if (score < bestScore) { bestScore = score; best = s; }
  }
  return best ? best.style : 'Regular';
}

/** Resolve a CSS font stack to an available Figma font. */
function resolveFont(families, weight, italic, missing) {
  var cacheKey = families.join(',') + '|' + weight + '|' + italic;
  if (fontCache[cacheKey]) return fontCache[cacheKey];
  var idx = fontIndex;
  var result = null;
  var firstReal = null;
  for (var i = 0; i < families.length && !result; i++) {
    var fam = families[i];
    var low = fam.toLowerCase();
    if (IGNORED_FAMILIES.test(low)) continue;
    var cands = GENERIC[low] || familyCandidates(fam);
    if (!GENERIC[low] && !firstReal) firstReal = fam;
    for (var k = 0; k < cands.length; k++) {
      var e = idx[familyKey(cands[k])];
      if (e) { result = { family: e.family, style: pickStyle(e.styles, weight, italic) }; break; }
    }
  }
  if (!result) {
    var inter = idx[familyKey('Inter')];
    result = { family: 'Inter', style: inter ? pickStyle(inter.styles, weight, italic) : 'Regular' };
  }
  if (firstReal && familyCandidates(firstReal).map(familyKey).indexOf(familyKey(result.family)) < 0) missing[firstReal] = result.family;
  fontCache[cacheKey] = result;
  return result;
}

async function loadFonts(fonts) {
  var seen = {};
  var jobs = [];
  var failed = {};
  fonts.forEach(function (f) {
    var k = f.family + '|' + f.style;
    if (seen[k]) return;
    seen[k] = true;
    jobs.push(figma.loadFontAsync(f).catch(function () { failed[k] = true; }));
  });
  await Promise.all(jobs);
  if (Object.keys(failed).length) await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  return failed;
}

// ---------------------------------------------------------------------------
// Paints & effects
// ---------------------------------------------------------------------------

function toPaints(list, ctx, lenient) {
  var out = [];
  (list || []).forEach(function (p) {
    if (p.type === 'SOLID') {
      out.push({ type: 'SOLID', color: p.color, opacity: p.opacity });
    } else if (p.type === 'IMAGE') {
      var hash = ctx.hashes[p.id];
      if (!hash) return;
      var ip = { type: 'IMAGE', imageHash: hash, scaleMode: lenient && p.scaleMode === 'CROP' ? 'FILL' : p.scaleMode };
      if (!lenient && p.scaleMode === 'CROP' && p.t) ip.imageTransform = p.t;
      if (p.scaleMode === 'TILE' && p.sf) ip.scalingFactor = p.sf;
      if (p.filters) ip.filters = p.filters;
      out.push(ip);
    } else if (p.type && p.type.indexOf('GRADIENT') === 0) {
      out.push({ type: p.type, gradientTransform: p.t, gradientStops: p.stops });
    }
  });
  return out;
}

function setFills(node, list, ctx) {
  try { node.fills = toPaints(list, ctx, false); }
  catch (e) {
    try { node.fills = toPaints(list, ctx, true); } catch (e2) { node.fills = []; ctx.errors++; }
  }
}

function toEffects(list, withBlurType) {
  var out = [];
  (list || []).forEach(function (e) {
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      var o = {
        type: e.type, color: { r: e.c.r, g: e.c.g, b: e.c.b, a: e.c.a },
        offset: { x: e.x || 0, y: e.y || 0 }, radius: Math.max(0, e.blur || 0), spread: e.spread || 0,
        visible: true, blendMode: 'NORMAL',
      };
      if (e.type === 'DROP_SHADOW') o.showShadowBehindNode = false;
      out.push(o);
    } else if (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') {
      var b = { type: e.type, radius: Math.max(0, e.radius || 0), visible: true };
      if (withBlurType) b.blurType = 'NORMAL';
      out.push(b);
    }
  });
  return out;
}

function setEffects(node, list, ctx) {
  if (!list || !list.length) return;
  try { node.effects = toEffects(list, false); }
  catch (e) {
    try { node.effects = toEffects(list, true); }
    catch (e2) {
      try { node.effects = toEffects(list.filter(function (x) { return x.type.indexOf('BLUR') < 0; }), false); } catch (e3) { ctx.errors++; }
    }
  }
}

function applyStrokes(node, s) {
  node.strokes = s.paints.map(function (p) { return { type: 'SOLID', color: p.color, opacity: p.opacity }; });
  node.strokeAlign = s.align || 'INSIDE';
  var w = s.weights;
  if (w[0] === w[1] && w[1] === w[2] && w[2] === w[3]) node.strokeWeight = w[0];
  else {
    node.strokeTopWeight = w[0];
    node.strokeRightWeight = w[1];
    node.strokeBottomWeight = w[2];
    node.strokeLeftWeight = w[3];
  }
  if (s.dash) node.dashPattern = s.dash;
}

function applyRadii(node, r) {
  if (r[0] === r[1] && r[1] === r[2] && r[2] === r[3]) node.cornerRadius = r[0];
  else {
    node.topLeftRadius = r[0];
    node.topRightRadius = r[1];
    node.bottomRightRadius = r[2];
    node.bottomLeftRadius = r[3];
  }
}

// ---------------------------------------------------------------------------
// Node builders
// ---------------------------------------------------------------------------

function makeFrame(ir, ctx) {
  var isImage = ir.img && !(ir.children && ir.children.length);
  // Pictures are kept as they are: an image layer (rectangle) with the original file.
  var f = isImage ? figma.createRectangle() : figma.createFrame();
  f.name = ir.name || 'Frame';
  f.resize(Math.max(ir.w, 0.01), Math.max(ir.h, 0.01));
  setFills(f, ir.fills, ctx);
  if (isImage) {
    try { if (f.lockAspectRatio) f.lockAspectRatio(); else f.constrainProportions = true; } catch (e) { /* older API */ }
  } else {
    f.clipsContent = !!ir.clip;
  }
  if (ir.strokes) { try { applyStrokes(f, ir.strokes); } catch (e) { ctx.errors++; } }
  if (ir.radii) applyRadii(f, ir.radii);
  setEffects(f, ir.effects, ctx);
  if (ir.opacity != null) f.opacity = ir.opacity;
  if (ir.blend) { try { f.blendMode = ir.blend; } catch (e) { /* ignore */ } }
  return f;
}

/**
 * clip-path → vector mask. A Figma mask only clips the layers above it inside
 * the same parent, so the frame's own background and borders move into a
 * "Fill" layer placed right above the mask; both stay out of the auto layout flow.
 */
function applyMask(frame, ir, ctx) {
  var shape = null;
  try {
    var svg = figma.createNodeFromSvg('<svg xmlns="http://www.w3.org/2000/svg" width="' + Math.max(ir.w, 0.01) + '" height="' + Math.max(ir.h, 0.01) + '" viewBox="0 0 ' + Math.max(ir.w, 0.01) + ' ' + Math.max(ir.h, 0.01) + '"><path d="' + ir.mask + '" fill="#000"/></svg>');
    shape = svg.findOne(function (n) { return n.type === 'VECTOR' || n.type === 'BOOLEAN_OPERATION'; });
    if (shape) { frame.insertChild(0, shape); shape.x = 0; shape.y = 0; }
    svg.remove();
  } catch (e) { shape = null; }
  if (!shape) { ctx.errors++; return; }
  shape.name = 'Clip shape';
  shape.isMask = true;
  var auto = frame.layoutMode && frame.layoutMode !== 'NONE';
  if (auto) shape.layoutPositioning = 'ABSOLUTE';
  shape.x = 0; shape.y = 0;
  var hasPaint = (frame.fills && frame.fills.length) || (frame.strokes && frame.strokes.length) || (frame.effects && frame.effects.length);
  if (hasPaint) {
    var bg = figma.createRectangle();
    bg.name = 'Fill';
    bg.resize(Math.max(ir.w, 0.01), Math.max(ir.h, 0.01));
    bg.fills = frame.fills;
    if (frame.strokes && frame.strokes.length) {
      bg.strokes = frame.strokes;
      bg.strokeAlign = frame.strokeAlign;
      if (frame.strokeWeight !== figma.mixed) bg.strokeWeight = frame.strokeWeight;
      else { bg.strokeTopWeight = frame.strokeTopWeight; bg.strokeRightWeight = frame.strokeRightWeight; bg.strokeBottomWeight = frame.strokeBottomWeight; bg.strokeLeftWeight = frame.strokeLeftWeight; }
    }
    frame.insertChild(1, bg);
    if (auto) bg.layoutPositioning = 'ABSOLUTE';
    bg.x = 0; bg.y = 0;
    bg.constraints = { horizontal: 'STRETCH', vertical: 'STRETCH' };
    frame.fills = [];
    frame.strokes = [];
  }
  shape.constraints = { horizontal: 'SCALE', vertical: 'SCALE' };
}

function textFills(st, ir) {
  if (st.grad && ir.gradFill) return [{ type: ir.gradFill.type, gradientTransform: ir.gradFill.t, gradientStops: ir.gradFill.stops }];
  var c = st.c || { r: 0, g: 0, b: 0, a: 1 };
  return [{ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a }];
}

function makeText(ir, ctx) {
  var t = figma.createText();
  var runs = ir.runs;
  var font0 = ctx.fonts[runs[0][2]];
  t.fontName = font0;
  t.characters = ir.chars;
  t.lineHeight = { unit: 'PIXELS', value: Math.max(1, ir.lh) };
  for (var i = 0; i < runs.length; i++) {
    var s = runs[i][0], e = runs[i][1], si = runs[i][2];
    if (e <= s) continue;
    var st = ctx.styles[si];
    var fn = ctx.fonts[si];
    if (runs.length > 1 || fn.family !== font0.family || fn.style !== font0.style) t.setRangeFontName(s, e, fn);
    t.setRangeFontSize(s, e, Math.max(1, st.sz));
    t.setRangeFills(s, e, textFills(st, ir));
    if (st.ls) t.setRangeLetterSpacing(s, e, { unit: 'PIXELS', value: st.ls });
    if (st.dec) t.setRangeTextDecoration(s, e, st.dec);
    if (st.tt) t.setRangeTextCase(s, e, st.tt);
    if (st.href) { try { t.setRangeHyperlink(s, e, { type: 'URL', value: st.href }); } catch (err) { /* ignore */ } }
  }
  t.textAlignHorizontal = ir.align || 'LEFT';
  if (ir.trunc) {
    // text-overflow: ellipsis / line-clamp
    t.textAutoResize = 'NONE';
    t.resize(Math.max(ir.trunc.w, 1), Math.max(ir.lh * ir.trunc.lines, 1));
    try { t.textTruncation = 'ENDING'; t.maxLines = ir.trunc.lines; } catch (e) { /* older API */ }
  } else if (ir.mode === 'wrap') {
    t.textAutoResize = 'HEIGHT';
    t.resize(Math.max(ir.w, 1), Math.max(t.height, 1));
  } else {
    t.textAutoResize = 'WIDTH_AND_HEIGHT';
  }
  setEffects(t, ir.effects, ctx);
  return t;
}

function makeSvg(ir, ctx) {
  var node = null;
  try { node = figma.createNodeFromSvg(ir.svg); } catch (e) { node = null; }
  if (!node) {
    if (ir.fallback && ctx.hashes[ir.fallback]) {
      node = figma.createFrame();
      node.resize(Math.max(ir.w, 0.01), Math.max(ir.h, 0.01));
      node.fills = [{ type: 'IMAGE', imageHash: ctx.hashes[ir.fallback], scaleMode: 'FIT' }];
    } else {
      ctx.errors++;
      return null;
    }
  } else if (Math.abs(node.width - ir.w) > 0.5 || Math.abs(node.height - ir.h) > 0.5) {
    if (node.width > 0 && node.height > 0) node.rescale(Math.min(ir.w / node.width, ir.h / node.height));
  }
  node.name = ir.name || 'SVG';
  if (ir.opacity != null) node.opacity = ir.opacity;
  return node;
}

function place(node, ir, parentIR) {
  if (ir.rot) {
    var a = ir.rot.a, cos = Math.cos(a), sin = Math.sin(a);
    var w = ir.w, h = ir.h;
    var tx = ir.rot.cx - (w / 2 * cos - h / 2 * sin) - parentIR.x;
    var ty = ir.rot.cy - (w / 2 * sin + h / 2 * cos) - parentIR.y;
    node.relativeTransform = [[cos, -sin, tx], [sin, cos, ty]];
    return;
  }
  var x = ir.x;
  if (ir.type === 'TEXT' && ir.mode !== 'wrap' && !ir.trunc) {
    if (ir.anchor === 'C') x = ir.ax - node.width / 2;
    else if (ir.anchor === 'R') x = ir.ax - node.width;
  }
  node.x = x - parentIR.x;
  node.y = ir.y - parentIR.y;
}

function countNodes(ir) {
  var n = 1;
  if (ir.children) for (var i = 0; i < ir.children.length; i++) n += countNodes(ir.children[i]);
  return n;
}

function yieldToUI() { return new Promise(function (r) { setTimeout(r, 0); }); }

function makeSpacer(size, mode) {
  var sp = figma.createFrame();
  sp.name = 'Spacer';
  sp.fills = [];
  sp.clipsContent = false;
  if (mode === 'VERTICAL') sp.resize(0.01, Math.max(size, 0.01));
  else sp.resize(Math.max(size, 0.01), 0.01);
  return sp;
}

/** Children in the order auto layout needs (absolute ones first/last, spacers in between). */
function layoutSequence(ir, ctx) {
  var kids = ir.children || [];
  if (!ctx.autoLayout || !ir.al) return kids.map(function (c) { return { ir: c }; });
  var al = ir.al, seq = [];
  al.before.forEach(function (i) { seq.push({ ir: kids[i], abs: true }); });
  al.items.forEach(function (it) {
    if (it[1] > 0) seq.push({ spacer: it[1] });
    seq.push({ ir: kids[it[0]], stretch: al.stretch.indexOf(it[0]) >= 0 });
  });
  al.after.forEach(function (i) { seq.push({ ir: kids[i], abs: true }); });
  return seq;
}

function applyAutoLayout(node, ir, placed, ctx) {
  var al = ir.al;
  try {
    node.layoutMode = al.mode;
    node.primaryAxisSizingMode = 'FIXED';
    node.counterAxisSizingMode = 'FIXED';
    if (al.wrap) { node.layoutWrap = 'WRAP'; node.counterAxisSpacing = al.cgap; }
    node.itemSpacing = al.gap;
    node.paddingTop = al.pad[0];
    node.paddingRight = al.pad[1];
    node.paddingBottom = al.pad[2];
    node.paddingLeft = al.pad[3];
    node.primaryAxisAlignItems = al.primary;
    node.counterAxisAlignItems = al.counter;
    node.resize(Math.max(ir.w, 0.01), Math.max(ir.h, 0.01));
    placed.forEach(function (p) {
      if (p.abs) {
        p.node.layoutPositioning = 'ABSOLUTE';
        place(p.node, p.ir, ir);
      } else if (p.stretch) {
        p.node.layoutAlign = 'STRETCH';
      }
    });
    if (al.hugP) node.primaryAxisSizingMode = 'AUTO';
    if (al.hugC) node.counterAxisSizingMode = 'AUTO';
    ctx.autoLayouts++;
  } catch (e) {
    // Could not apply: back to free positioning, nothing moves.
    try {
      node.layoutMode = 'NONE';
      node.resize(Math.max(ir.w, 0.01), Math.max(ir.h, 0.01));
      placed.forEach(function (p) { if (p.ir) place(p.node, p.ir, ir); else p.node.remove(); });
    } catch (e2) { /* ignore */ }
    ctx.alFailures++;
  }
}

async function buildChildren(parent, parentIR, ctx) {
  var seq = layoutSequence(parentIR, ctx);
  var placed = [];
  for (var i = 0; i < seq.length; i++) {
    if (seq[i].spacer) {
      var sp = makeSpacer(seq[i].spacer, parentIR.al.mode);
      parent.appendChild(sp);
      placed.push({ node: sp });
      continue;
    }
    var c = seq[i].ir;
    var node = null;
    try {
      if (c.type === 'FRAME') node = makeFrame(c, ctx);
      else if (c.type === 'TEXT') node = makeText(c, ctx);
      else if (c.type === 'SVG') node = makeSvg(c, ctx);
    } catch (e) {
      ctx.errors++;
      if (ctx.errors < 20) console.warn('Odoo To Figma – node error', c.type, c.name, e);
    }
    ctx.done++;
    if (ctx.done - ctx.lastReport >= 150) {
      ctx.lastReport = ctx.done;
      figma.ui.postMessage({ type: 'build-progress', done: ctx.done, total: ctx.total });
      await yieldToUI();
    }
    if (!node) continue;
    parent.appendChild(node);
    try { place(node, c, parentIR); } catch (e) { ctx.errors++; }
    placed.push({ node: node, ir: c, abs: seq[i].abs, stretch: seq[i].stretch });
    if (c.type === 'FRAME' && c.children && c.children.length) await buildChildren(node, c, ctx);
    if (c.mask && node.type === 'FRAME') { try { applyMask(node, c, ctx); } catch (e) { ctx.errors++; } }
  }
  if (ctx.autoLayout && parentIR.al && parent.type === 'FRAME') applyAutoLayout(parent, parentIR, placed, ctx);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

var lastFrames = [];

function nextPosition(width, batchIndex) {
  if (batchIndex > 0 && lastFrames.length) {
    var prev = lastFrames[lastFrames.length - 1];
    if (!prev.removed) return { x: prev.x + prev.width + 120, y: prev.y };
  }
  var maxX = null, minY = null;
  var kids = figma.currentPage.children;
  for (var i = 0; i < kids.length; i++) {
    var n = kids[i];
    var right = n.x + n.width;
    if (maxX === null || right > maxX) maxX = right;
    if (minY === null || n.y < minY) minY = n.y;
  }
  if (maxX === null) {
    var c = figma.viewport.center;
    return { x: Math.round(c.x - width / 2), y: Math.round(c.y - 300) };
  }
  return { x: Math.round(maxX + 200), y: Math.round(minY) };
}

async function buildCapture(cap, images, batchIndex, batchSize, autoLayout) {
  var t0 = Date.now();
  await getFontIndex();
  var missing = {};
  var fonts = cap.styles.map(function (st) { return resolveFont(st.fam || [], st.w || 400, !!st.it, missing); });
  var failed = await loadFonts(fonts);
  fonts = fonts.map(function (f) { return failed[f.family + '|' + f.style] ? { family: 'Inter', style: 'Regular' } : f; });

  var ctx = {
    hashes: {}, fonts: fonts, styles: cap.styles, errors: 0, done: 0, lastReport: 0, total: countNodes(cap.root),
    autoLayout: !!autoLayout, autoLayouts: 0, alFailures: 0,
  };
  var ids = Object.keys(images || {});
  for (var i = 0; i < ids.length; i++) {
    try { ctx.hashes[ids[i]] = figma.createImage(images[ids[i]]).hash; } catch (e) { ctx.errors++; }
  }

  var root = cap.root;
  var meta = cap.meta || {};
  var frame = makeFrame(root, ctx);
  var host = '';
  try { host = meta.url.replace(/^https?:\/\//, '').replace(/\/$/, ''); } catch (e) { /* ignore */ }
  frame.name = meta.name || ((meta.title || host || 'Page') + ' — ' + (meta.viewport ? meta.viewport.label + ' ' + meta.viewport.width : ''));
  var pos = nextPosition(root.w, batchIndex);
  figma.currentPage.appendChild(frame);
  frame.x = pos.x;
  frame.y = pos.y;
  if (batchIndex === 0) lastFrames = [];
  lastFrames.push(frame);

  await buildChildren(frame, root, ctx);

  figma.currentPage.selection = lastFrames.filter(function (f) { return !f.removed; });
  figma.viewport.scrollAndZoomIntoView(figma.currentPage.selection);

  return {
    nodes: ctx.done,
    errors: ctx.errors,
    autoLayouts: ctx.autoLayouts,
    frame: frame.name,
    frameId: frame.id,
    ms: Date.now() - t0,
    missingFonts: missing,
    last: batchIndex === batchSize - 1,
  };
}

figma.ui.onmessage = async function (msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'load-settings') {
    var s = await figma.clientStorage.getAsync(SETTINGS_KEY);
    figma.ui.postMessage({ type: 'settings', settings: s || null });
  } else if (msg.type === 'save-settings') {
    await figma.clientStorage.setAsync(SETTINGS_KEY, msg.settings);
  } else if (msg.type === 'build') {
    try {
      var res = await buildCapture(msg.capture, msg.images, msg.batchIndex || 0, msg.batchSize || 1, msg.autoLayout);
      figma.ui.postMessage({ type: 'built', result: res });
      if (res.last) figma.notify('Odoo To Figma: page imported ✓');
    } catch (e) {
      figma.ui.postMessage({ type: 'build-error', message: String(e && e.message ? e.message : e) });
    }
  } else if (msg.type === 'notify') {
    figma.notify(msg.text, { error: !!msg.error });
  } else if (msg.type === 'close') {
    figma.closePlugin(msg.text);
  } else if (msg.type === 'resize') {
    figma.ui.resize(360, Math.max(300, Math.min(800, msg.height)));
  }
};
