'use strict';
// Infers a Figma auto layout for a frame from the exact positions of its
// children, so that turning auto layout on never moves anything.
// Returns null when no auto layout reproduces the layout (the frame then stays
// absolutely positioned).
//
// al = {
//   mode: 'VERTICAL' | 'HORIZONTAL', wrap: bool, gap, cgap (row gap when wrapping),
//   pad: [top, right, bottom, left], primary: 'MIN'|'CENTER'|'MAX', counter: 'MIN'|'CENTER'|'MAX',
//   hugP, hugC (hug contents on primary / counter axis),
//   before: [childIndex] (absolute, below the flow), after: [childIndex] (absolute, above),
//   items: [[childIndex, spacerBefore]], stretch: [childIndex]
// }

const TOL = 1.01;
const MARGIN_SLACK = 32; // extra space still considered "content driven" (margins)
const r2 = (v) => Math.round(v * 100) / 100;

const isImage = (c) => c.type === 'SVG' || !!c.img;

function fitAutoLayout(f, css) {
  const kids = f.children;
  const flow = [];
  kids.forEach((c, i) => { if (!c.abs) flow.push(i); });
  if (!flow.length) return null;
  const flex = /flex/.test(css.disp || '');
  const order = flex && /^column/.test(css.dir || '') ? ['V', 'H'] : flex ? ['H', 'V'] : ['V', 'H'];
  let fit = null;
  for (const m of order) { fit = tryAxis(f, kids, flow, m, css); if (fit) break; }
  if (!fit && flow.length > 1) fit = tryWrap(f, kids, flow, css);
  if (!fit) return null;
  if (!fit.wrap) fit = cleanAlignment(f, kids, fit, css);
  // Absolute children keep their paint order relative to the flow.
  const firstFlow = flow[0];
  fit.before = [];
  fit.after = [];
  kids.forEach((c, i) => { if (c.abs) (i < firstFlow ? fit.before : fit.after).push(i); });
  return fit;
}

function axes(m) {
  return m === 'V'
    ? { p: 'y', ps: 'h', c: 'x', cs: 'w', padS: 0, padE: 2, padA: 3, padB: 1 }
    : { p: 'x', ps: 'w', c: 'y', cs: 'h', padS: 3, padE: 1, padA: 0, padB: 2 };
}

/** Cross-axis alignment shared by all non-stretched items, or null. */
function crossAlign(items, A, f, padA, padB, m, css) {
  const C0 = f[A.c], CS = f[A.cs];
  let allowed = ['MIN', 'CENTER', 'MAX'];
  const stretch = [];
  for (const { i, c } of items) {
    const a = c[A.c] - C0, b = C0 + CS - (c[A.c] + c[A.cs]);
    const atA = Math.abs(a - padA) <= TOL, atB = Math.abs(b - padB) <= TOL;
    const centered = Math.abs((a - padA) - (b - padB)) <= TOL;
    let ok;
    if (c.type === 'TEXT' && m === 'V') {
      // Text width differs slightly in Figma: align by the text's own anchor.
      const want = c.anchor === 'C' ? 'CENTER' : c.anchor === 'R' ? 'MAX' : 'MIN';
      const geo = want === 'CENTER' ? centered : want === 'MAX' ? atB : atA;
      ok = geo ? [want] : [];
    } else if (atA && atB && Math.abs(c[A.cs] - (CS - padA - padB)) <= 0.5 && !isImage(c) && c.type !== 'TEXT') {
      stretch.push(i);
      continue;
    } else {
      ok = [];
      if (atA) ok.push('MIN');
      if (centered) ok.push('CENTER');
      if (atB) ok.push('MAX');
    }
    allowed = allowed.filter((x) => ok.includes(x));
    if (!allowed.length) return null;
  }
  const hint = m === 'H' ? { center: 'CENTER', 'flex-end': 'MAX', end: 'MAX' }[css.ai] : null;
  return { counter: hint && allowed.includes(hint) ? hint : allowed[0], stretch };
}

function tryAxis(f, kids, flow, m, css) {
  const A = axes(m);
  const items = flow.map((i) => ({ i, c: kids[i] })).sort((a, b) => a.c[A.p] - b.c[A.p] || a.c[A.c] - b.c[A.c]);
  const gaps = [];
  for (let k = 1; k < items.length; k++) {
    const prev = items[k - 1].c, cur = items[k].c;
    const g = cur[A.p] - (prev[A.p] + prev[A.ps]);
    if (g < -TOL) return null; // overlap along the primary axis
    gaps.push(g); // small overlaps (collapsed borders) become negative spacing, like in Figma
  }
  const first = items[0].c, last = items[items.length - 1].c;
  const padS = first[A.p] - f[A.p];
  let padE = f[A.p] + f[A.ps] - (last[A.p] + last[A.ps]);
  if (padS < -TOL) return null;
  // Even a sub-pixel overflow would make a "hug" frame grow: keep it fixed then.
  const overflow = padE < -0.2 || padS < -0.2;
  padE = Math.max(0, padE);

  const ca = items.map(({ c }) => c[A.c] - f[A.c]);
  const cb = items.map(({ c }) => f[A.c] + f[A.cs] - (c[A.c] + c[A.cs]));
  if (ca.some((v) => v < -TOL) || cb.some((v) => v < -TOL)) return null;
  const rawB = Math.min(...cb), rawA = Math.min(...ca);
  const padA = Math.max(0, Math.min(...ca)), padB = Math.max(0, rawB);
  const cross = crossAlign(items, A, f, padA, padB, m, css);
  if (!cross) return null;

  const { gap, spacers } = spacing(gaps);
  const pad = [0, 0, 0, 0];
  pad[A.padS] = padS; pad[A.padE] = padE; pad[A.padA] = padA; pad[A.padB] = padB;
  const cssPad = css.pad || [0, 0, 0, 0];
  const contentDriven = (measured, cssV) => measured >= cssV - TOL && measured - cssV <= MARGIN_SLACK;
  const hasImageKids = items.some(({ c }) => isImage(c));
  const hugP = !css.cell && !overflow && (m === 'V' || css.stf) && contentDriven(padE, cssPad[A.padE]);
  const hugC = !css.cell && rawB >= -0.2 && rawA >= -0.2 && !cross.stretch.length && (m === 'H' || css.stf) && contentDriven(padB, cssPad[A.padB]) && !(hasImageKids && m === 'V' && !css.stf);

  return {
    mode: m === 'V' ? 'VERTICAL' : 'HORIZONTAL', wrap: false, gap: r2(gap), cgap: 0,
    pad: pad.map(r2), primary: 'MIN', counter: cross.counter, hugP, hugC,
    items: items.map(({ i }, k) => [i, k > 0 ? r2(spacers[k - 1]) : 0]), stretch: cross.stretch,
  };
}

/**
 * Prefer the element's real CSS padding plus an alignment (start / center / end)
 * over padding measured from where the content happens to sit. A centered
 * button label then gets "padding 8 · center" instead of "padding 13/4/8/4",
 * and the layout keeps working when the frame is resized in Figma.
 * A candidate is only kept if it puts every child exactly where it was.
 */
function cleanAlignment(f, kids, fit, css) {
  const cp = css.pad;
  if (!cp) return fit;
  const V = fit.mode === 'VERTICAL';
  const [ps, pe, ca, cb] = V ? [0, 2, 3, 1] : [3, 1, 0, 2];
  const near = (a, b) => Math.abs(a - b) < 0.01;
  const primaryOk = !fit.hugP && fit.pad[ps] >= cp[ps] - TOL && fit.pad[pe] >= cp[pe] - TOL;
  const counterOk = !fit.hugC && fit.pad[ca] >= cp[ca] - TOL && fit.pad[cb] >= cp[cb] - TOL;
  if (!primaryOk && !counterOk) return fit;
  if ((!primaryOk || (near(fit.pad[ps], cp[ps]) && near(fit.pad[pe], cp[pe])))
    && (!counterOk || (near(fit.pad[ca], cp[ca]) && near(fit.pad[cb], cp[cb])))) return fit;
  const ALIGN = ['MIN', 'CENTER', 'MAX'];
  const prim = primaryOk ? ALIGN : [fit.primary];
  // Keep the alignment found from the geometry first, then the others.
  const cross = counterOk ? [fit.counter, ...ALIGN.filter((a) => a !== fit.counter)] : [fit.counter];
  for (const p of prim) {
    for (const c of cross) {
      const pad = fit.pad.slice();
      if (primaryOk) { pad[ps] = r2(cp[ps]); pad[pe] = r2(cp[pe]); }
      if (counterOk) { pad[ca] = r2(cp[ca]); pad[cb] = r2(cp[cb]); }
      const cand = { ...fit, pad, primary: p, counter: c };
      if (reproduces(f, kids, cand, 0.6)) return cand;
    }
  }
  return fit;
}

/** True when Figma's auto layout rules put every flow child where the browser did. */
function reproduces(f, kids, al, tol = TOL) {
  const V = al.mode === 'VERTICAL';
  const A = axes(V ? 'V' : 'H');
  const [pt, pr, pb, pl] = al.pad;
  const innerP = (V ? f.h - pt - pb : f.w - pl - pr);
  const innerC = (V ? f.w - pl - pr : f.h - pt - pb);
  const startP = f[A.p] + (V ? pt : pl);
  const startC = f[A.c] + (V ? pl : pt);
  const items = al.items.map(([i, sp]) => ({ c: kids[i], sp, stretch: al.stretch.includes(i) }));
  const total = items.reduce((a, it, k) => a + it.c[A.ps] + (k ? al.gap + it.sp : 0), 0);
  let p = al.primary === 'CENTER' ? startP + (innerP - total) / 2 : al.primary === 'MAX' ? startP + innerP - total : startP;
  for (let k = 0; k < items.length; k++) {
    const { c, sp, stretch } = items[k];
    if (k) p += al.gap + sp;
    if (Math.abs(c[A.p] - p) > tol) return false;
    p += c[A.ps];
    if (stretch) {
      if (Math.abs(c[A.c] - startC) > tol || Math.abs(c[A.cs] - innerC) > 0.5) return false;
      continue;
    }
    let want;
    if (c.type === 'TEXT' && V) {
      // Figma may set a text slightly narrower or wider: compare its anchor.
      const anchor = c.anchor === 'C' ? c.x + c.w / 2 : c.anchor === 'R' ? c.x + c.w : c.x;
      const pos = al.counter === 'CENTER' ? startC + innerC / 2 : al.counter === 'MAX' ? startC + innerC : startC;
      const expect = c.anchor === 'C' ? 'CENTER' : c.anchor === 'R' ? 'MAX' : 'MIN';
      if (expect !== al.counter || Math.abs(anchor - pos) > tol) return false;
      continue;
    }
    want = al.counter === 'CENTER' ? startC + (innerC - c[A.cs]) / 2 : al.counter === 'MAX' ? startC + innerC - c[A.cs] : startC;
    if (Math.abs(c[A.c] - want) > tol) return false;
  }
  return true;
}

/** Uniform gap, or the smallest gap plus invisible spacers for the extra space. */
function spacing(gaps) {
  if (!gaps.length) return { gap: 0, spacers: [] };
  const min = Math.min(...gaps), max = Math.max(...gaps);
  if (max - min <= TOL) {
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    // An average gap is fine as long as the error does not pile up along the line.
    let drift = 0, sum = 0;
    for (const g of gaps) { sum += g - avg; drift = Math.max(drift, Math.abs(sum)); }
    if (drift <= 0.3) return { gap: Math.abs(avg) < 0.05 ? 0 : avg, spacers: gaps.map(() => 0) };
  }
  return { gap: min, spacers: gaps.map((g) => (g - min > 0.5 ? g - min : 0)) };
}

/** Horizontal wrap (flex-wrap rows, grids, Bootstrap .row). */
function tryWrap(f, kids, flow, css) {
  const items = flow.map((i) => ({ i, c: kids[i] })).sort((a, b) => a.c.y - b.c.y || a.c.x - b.c.x);
  const rows = [];
  for (const it of items) {
    const row = rows[rows.length - 1];
    if (row && it.c.y < row.bottom - TOL && it.c.y + it.c.h > row.top + TOL) {
      row.items.push(it);
      row.top = Math.min(row.top, it.c.y);
      row.bottom = Math.max(row.bottom, it.c.y + it.c.h);
    } else rows.push({ items: [it], top: it.c.y, bottom: it.c.y + it.c.h });
  }
  if (rows.length < 2) return null;
  const hgaps = [];
  let left = null, right = -Infinity;
  for (const row of rows) {
    row.items.sort((a, b) => a.c.x - b.c.x);
    const x0 = row.items[0].c.x;
    if (left === null) left = x0;
    else if (Math.abs(x0 - left) > TOL) return null; // rows must start at the same x
    for (let k = 1; k < row.items.length; k++) {
      const g = row.items[k].c.x - (row.items[k - 1].c.x + row.items[k - 1].c.w);
      if (g < -TOL) return null;
      hgaps.push(g);
    }
    const last = row.items[row.items.length - 1].c;
    right = Math.max(right, last.x + last.w);
    for (const { c } of row.items) if (Math.abs(c.y - row.top) > TOL) return null; // top-aligned rows only
  }
  const hg = hgaps.length ? hgaps : [0];
  if (Math.max(...hg) - Math.min(...hg) > TOL) return null;
  const gap = hg.reduce((a, b) => a + b, 0) / hg.length;
  const vgaps = [];
  for (let k = 1; k < rows.length; k++) vgaps.push(rows[k].top - rows[k - 1].bottom);
  if (Math.min(...vgaps) < -TOL || Math.max(...vgaps) - Math.min(...vgaps) > TOL) return null;
  const cgap = Math.max(0, vgaps.reduce((a, b) => a + b, 0) / vgaps.length);
  // Rows must break where the browser broke: the next item must not fit on the row.
  const cssPad = css.pad || [0, 0, 0, 0];
  const padL = left - f.x;
  const avail = f.w - padL - Math.max(0, cssPad[1]);
  if (right - f.x > f.w + TOL || padL < -TOL) return null;
  for (let k = 0; k < rows.length - 1; k++) {
    const row = rows[k];
    const used = row.items.reduce((a, { c }) => a + c.w, 0) + gap * (row.items.length - 1);
    const next = rows[k + 1].items[0].c.w;
    if (used + gap + next <= avail + TOL) return null;
  }
  const padT = rows[0].top - f.y;
  const rowOverflow = padT < -0.2;
  const padB = f.y + f.h - rows[rows.length - 1].bottom;
  if (padT < -TOL) return null;
  const stretchable = false;
  return {
    mode: 'HORIZONTAL', wrap: true, gap: r2(gap), cgap: r2(cgap),
    pad: [r2(padT), r2(Math.max(0, cssPad[1] - 0.5)), r2(Math.max(0, padB)), r2(Math.max(0, padL))],
    primary: 'MIN', counter: 'MIN', hugP: false,
    hugC: !stretchable && !rowOverflow && padB >= -0.2 && padB >= cssPad[2] - TOL && padB - cssPad[2] <= MARGIN_SLACK,
    items: rows.flatMap((row) => row.items.map(({ i }) => [i, 0])), stretch: [],
  };
}

module.exports = { fitAutoLayout };
