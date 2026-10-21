// Dev tool: run a function body (file) inside a page and print its result.
// Usage: node scripts/inspect.js <url> <file-with-function-body>
const fs = require('fs');
const { getBrowser, openUrl, trackNavigation } = require('../server/capture');
(async () => {
  const [url, file] = process.argv.slice(2);
  const b = await getBrowser();
  const p = await b.newPage();
  await p.setUserAgent((await b.userAgent()).replace('HeadlessChrome', 'Chrome'));
  await p.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await p.setViewport({ width: 1440, height: 900 });
  await openUrl(p, url, trackNavigation(p));
  console.log(await p.evaluate(new Function(fs.readFileSync(file, 'utf8'))));
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
