'use strict';
// Replays Figma's auto layout rules on a capture's IR and checks that every
// layer lands exactly where the browser put it (auto layout must not move anything).
// Usage: node test/check-autolayout.js capture.json [capture2.json …]

const fs = require('fs');

const TOL = 1.5;

function simulate(root) {
  const out = new Map(); // ir node → {x, y, w, h}

  // Bottom-up sizes (hug contents); leaves keep their IR size.
  const size = new Map();
  function measure(n) {
    (n.children || []).forEach(measure);
    let w = n.w, h = n.h;
    const al = n.al;
    if (al && (al.hugP || al.hugC)) {
      const V = al.mode === 'VERTICAL';
      const flow = al.items.map(([i]) => n.children[i]);
      const sz = flow.map((c) => size.get(c));
      const spacers = al.items.reduce((a, [, sp]) => a + sp, 0);
      const along = sz.reduce((a, s) => a + (V ? s.h : s.w), 0) + al.gap * Math.max(0, flow.length - 1) + spacers;
      const across = Math.max(0, ...sz.map((s) => (V ? s.w : s.h)));
      const [pt, pr, pb, pl] = al.pad;
      if (al.wrap) {
        // rows break when the next item does not fit in the inner width
        const innerW = n.w - pl - pr;
        let rowW = 0, rowH = 0, total = 0, rows = 0;
        sz.forEach((s0, k) => {
          if (k > 0 && rowW + al.gap + s0.w > innerW + 0.01) { total += rowH; rows++; rowW = 0; rowH = 0; }
          else if (k > 0) rowW += al.gap;
          rowW += s0.w; rowH = Math.max(rowH, s0.h);
        });
        total += rowH; rows++;
        if (al.hugC) h = pt + total + al.cgap * (rows - 1) + pb;
      } else {
        if (al.hugP) { if (V) h = pt + along + pb; else w = pl + along + pr; }
        if (al.hugC) { if (V) w = pl + across + pr; else h = pt + across + pb; }
      }
    }
    size.set(n, { w, h });
  }
  measure(root);

  function place(n, x, y, w, h) {
    out.set(n, { x, y, w, h });
    const kids = n.children || [];
    if (!n.al) {
      for (const c of kids) { const s = size.get(c); place(c, x + (c.x - n.x), y + (c.y - n.y), s.w, s.h); }
      return;
    }
    const al = n.al;
    const V = al.mode === 'VERTICAL';
    const [pt, pr, pb, pl] = al.pad;
    const innerW = w - pl - pr, innerH = h - pt - pb;
    for (const i of al.before.concat(al.after)) { const c = kids[i]; const s = size.get(c); place(c, x + (c.x - n.x), y + (c.y - n.y), s.w, s.h); }
    const cross = (s, stretch, start, inner) => {
      if (stretch) return { pos: start, len: inner };
      const len = V ? s.w : s.h;
      if (al.counter === 'CENTER') return { pos: start + (inner - len) / 2, len };
      if (al.counter === 'MAX') return { pos: start + inner - len, len };
      return { pos: start, len };
    };
    if (al.wrap) {
      let cx = x + pl, cy = y + pt, rowH = 0, first = true;
      for (const [i] of al.items) {
        const c = kids[i]; const s = size.get(c);
        if (!first && cx + s.w > x + pl + innerW + 0.01) { cx = x + pl; cy += rowH + al.cgap; rowH = 0; first = true; }
        place(c, cx, cy, s.w, s.h);
        cx += s.w + al.gap; rowH = Math.max(rowH, s.h); first = false;
      }
      return;
    }
    let cur = V ? y + pt : x + pl;
    if (al.primary === 'CENTER' || al.primary === 'MAX') {
      const used = al.items.reduce((a, [i, sp], k) => { const s = size.get(kids[i]); return a + (V ? s.h : s.w) + (k ? al.gap + sp : 0); }, 0);
      const free = (V ? innerH : innerW) - used;
      cur += al.primary === 'CENTER' ? free / 2 : free;
    }
    al.items.forEach(([i, sp], k) => {
      const c = kids[i]; const s = size.get(c);
      if (k > 0) cur += al.gap;
      cur += sp;
      const stretch = al.stretch.includes(i);
      if (V) {
        const cr = cross(s, stretch, x + pl, innerW);
        place(c, cr.pos, cur, cr.len, s.h);
        cur += s.h;
      } else {
        const cr = cross(s, stretch, y + pt, innerH);
        place(c, cur, cr.pos, s.w, cr.len);
        cur += s.w;
      }
    });
  }
  const s0 = size.get(root);
  place(root, root.x, root.y, s0.w, s0.h);
  return out;
}

function check(file) {
  const cap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pos = simulate(cap.root);
  let n = 0, bad = 0, max = 0, frames = 0, al = 0, worst = null;
  const walk = (node, depth) => {
    if (node.type === 'FRAME') { frames++; if (node.al) al++; }
    const p = pos.get(node);
    const isTextAnchor = false;
    const dx = isTextAnchor ? 0 : Math.abs(p.x - node.x), dy = Math.abs(p.y - node.y);
    const dw = node.type === 'TEXT' ? 0 : Math.abs(p.w - node.w), dh = Math.abs(p.h - node.h);
    const d = Math.max(dx, dy, dw, dh);
    n++;
    if (d > TOL) {
      bad++;
      if (d > max) { max = d; worst = `${node.type} ${node.name} Δ${d.toFixed(1)}px`; }
      const par = parents.get(node);
      const parOk = !par || !badSet.has(par);
      badSet.add(node);
      if (process.env.DEBUG && parOk && shown++ < +process.env.DEBUG) {
        console.log(`  ✗ ${node.type} ${node.name} ir=(${node.x},${node.y} ${node.w}x${node.h}) sim=(${p.x.toFixed(1)},${p.y.toFixed(1)} ${p.w.toFixed(1)}x${p.h.toFixed(1)})` +
          (par ? ` parent=${par.name} (${par.x},${par.y} ${par.w}x${par.h}) al=${par.al ? JSON.stringify({ ...par.al, items: par.al.items.length }) : 'none'}` : ''));
      }
    }
    (node.children || []).forEach((c) => { parents.set(c, node); walk(c, depth + 1); });
  };
  const parents = new Map();
  const badSet = new Set();
  let shown = 0;
  walk(cap.root, 0);
  console.log(`${file}: ${al}/${frames} frames in auto layout · ${n} layers · ${bad} moved by more than ${TOL}px${worst ? ' (worst: ' + worst + ')' : ''}`);
  return bad;
}

let total = 0;
for (const f of process.argv.slice(2)) total += check(f);
process.exit(total ? 1 : 0);
