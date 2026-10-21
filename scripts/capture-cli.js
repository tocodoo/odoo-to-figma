// Usage: node scripts/capture-cli.js <url> [desktop|tablet|mobile] [out.json]
const fs = require('fs');
const { capture, getBrowser } = require('../server/capture');
(async () => {
  const [url, vp = 'desktop', out = 'capture.json'] = process.argv.slice(2);
  const t = Date.now();
  const res = await capture({ url, viewport: vp }, (m, p) => console.log(`[${p}%] ${m}`));
  fs.writeFileSync(out, JSON.stringify(res));
  console.log('meta', JSON.stringify(res.meta), 'size', (fs.statSync(out).size / 1e6).toFixed(1) + 'MB', ((Date.now() - t) / 1000).toFixed(1) + 's');
  (await getBrowser()).close();
})().catch((e) => { console.error(e); process.exit(1); });
