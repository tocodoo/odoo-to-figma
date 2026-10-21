'use strict';
// Image format sniffing and intrinsic size parsing (PNG / JPEG / GIF),
// used to decide whether a file can go straight to figma.createImage().

function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.slice(4, 12).toString().startsWith('ftypavi')) return 'image/avif';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'image/x-icon';
  const head = buf.slice(0, 1024).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg')) || head.includes('<svg')) return 'image/svg+xml';
  return null;
}

function dimensions(buf, type) {
  try {
    if (type === 'image/png') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (type === 'image/gif') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (type === 'image/jpeg') {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch (e) { /* fallthrough */ }
  return null;
}

function decodeDataUrl(url) {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(url);
  if (!m) return null;
  const isB64 = /;base64/i.test(m[2]);
  try {
    const buf = isB64 ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
    return { buf, mime: m[1] || 'text/plain' };
  } catch (e) {
    return null;
  }
}

module.exports = { sniff, dimensions, decodeDataUrl };
