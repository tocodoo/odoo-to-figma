'use strict';
// Font Awesome 4.7 icons as vectors.
// Reads the glyph outlines from the font-awesome package (SVG font) so icon-font
// glyphs become real, recolorable vector layers in Figma instead of pictures.

const fs = require('fs');
const path = require('path');

let cache = null;

function pkgDir() {
  try { return path.dirname(require.resolve('font-awesome/package.json')); } catch (e) { return null; }
}

function load() {
  if (cache) return cache;
  cache = { glyphs: new Map(), names: new Map(), em: 1792, ascent: 1536, descent: 256 };
  const dir = pkgDir();
  if (!dir) return cache;
  try {
    const svg = fs.readFileSync(path.join(dir, 'fonts', 'fontawesome-webfont.svg'), 'utf8');
    const face = /<font-face([^>]*)>/.exec(svg);
    const attr = (src, n) => { const m = new RegExp(`\\s${n}="([^"]*)"`).exec(src); return m ? m[1] : null; };
    if (face) {
      cache.em = parseFloat(attr(face[1], 'units-per-em')) || 1792;
      cache.ascent = parseFloat(attr(face[1], 'ascent')) || 1536;
      cache.descent = Math.abs(parseFloat(attr(face[1], 'descent')) || -256);
    }
    const font = /<font\s([^>]*)>/.exec(svg);
    const defAdv = (font && parseFloat(attr(font[1], 'horiz-adv-x'))) || cache.em;
    const re = /<glyph\b([^>]*?)\/>/gs;
    let m;
    while ((m = re.exec(svg))) {
      const a = m[1];
      const uni = attr(a, 'unicode');
      const d = attr(a, 'd');
      if (!uni || !d) continue;
      const hex = /^&#x([0-9a-f]+);$/i.exec(uni);
      const cp = hex ? parseInt(hex[1], 16) : uni.codePointAt(0);
      const adv = parseFloat(attr(a, 'horiz-adv-x')) || defAdv;
      cache.glyphs.set(cp, { d: d.replace(/\s+/g, ' ').trim(), adv });
    }
    // Official class names (fa-check…) from the package stylesheet
    const cssText = fs.readFileSync(path.join(dir, 'css', 'font-awesome.css'), 'utf8');
    const rule = /((?:\.fa-[\w-]+:before,?\s*)+)\{\s*content:\s*"\\([0-9a-f]+)";/gi;
    while ((m = rule.exec(cssText))) {
      const cp = parseInt(m[2], 16);
      // aliases come first (".fa-gear:before, .fa-cog:before"): the last name is the official one
      const all = m[1].match(/\.fa-[\w-]+(?=:before)/g) || [];
      if (all.length && !cache.names.has(cp)) cache.names.set(cp, all[all.length - 1].slice(1));
    }
  } catch (e) {
    cache.glyphs.clear();
  }
  return cache;
}

function isFontAwesome4(family) {
  const first = String(family || '').split(',')[0].trim().replace(/^["']|["']$/g, '');
  return /^(FontAwesome|Font Awesome 4|fontawesome-webfont)$/i.test(first);
}

/**
 * Vector SVG for the icon text rendered with Font Awesome 4 at `size` px, or null
 * when a character is not a Font Awesome glyph. The box matches the browser's
 * text box: width = advance, height = font size, baseline at the font ascent.
 */
function iconSvg(text, size, color) {
  const f = load();
  const chars = Array.from(String(text).replace(/\s/g, ''));
  if (!chars.length || !f.glyphs.size) return null;
  const glyphs = chars.map((c) => f.glyphs.get(c.codePointAt(0)));
  if (glyphs.some((g) => !g)) return null;
  const k = size / f.em;
  let x = 0;
  const paths = glyphs.map((g) => {
    const p = `<path transform="translate(${x} ${f.ascent}) scale(1 -1)" d="${g.d}"/>`;
    x += g.adv;
    return p;
  });
  const w = x * k, h = (f.ascent + f.descent) * k;
  const fill = `rgb(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)})`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${r2(w)}" height="${r2(h)}" viewBox="0 0 ${x} ${f.ascent + f.descent}">`
    + `<g fill="${fill}"${color.a < 1 ? ` fill-opacity="${r2(color.a)}"` : ''}>${paths.join('')}</g></svg>`;
  const name = chars.length === 1 ? f.names.get(chars[0].codePointAt(0)) || 'fa-icon' : 'fa-icons';
  return { svg, w, h, name };
}

const r2 = (v) => Math.round(v * 100) / 100;

module.exports = { iconSvg, isFontAwesome4, load };
