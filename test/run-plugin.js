'use strict';
// Runs figma-plugin/code.js against a capture JSON inside the strict mock.
// Usage: node test/run-plugin.js capture.json [--auto-layout]
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeFigma, mock } = require('./mock-figma');

const FONTS = [];
for (const fam of ['Inter', 'Roboto', 'Open Sans', 'Montserrat', 'Lato', 'Poppins', 'Helvetica', 'Helvetica Neue', 'Arial', 'Times New Roman', 'Menlo', 'SF Pro Text', 'Source Sans Pro', 'Noto Sans'])
  for (const st of ['Thin', 'Light', 'Regular', 'Medium', 'Semi Bold', 'SemiBold', 'Bold', 'Extra Bold', 'Black', 'Italic', 'Bold Italic', 'Medium Italic'])
    FONTS.push([fam, st]);

(async () => {
  const cap = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const autoLayout = process.argv.includes('--auto-layout');
  const figma = makeFigma(FONTS);
  const errors = [];
  const sandbox = { figma, __html__: '', console: { log() {}, warn: (...a) => errors.push(a.map(String).join(' ')), error: (...a) => errors.push(a.join(' ')) }, setTimeout, Promise, Math, JSON, Object, Array, String, Number, Date, Infinity };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../figma-plugin/code.js'), 'utf8'), sandbox);
  const images = {};
  for (const [id, b64] of Object.entries(cap.images)) images[id] = new Uint8Array(Buffer.from(b64, 'base64'));
  delete cap.images;
  const t = Date.now();
  await figma.ui.onmessage({ type: 'build', capture: cap, images, batchIndex: 0, batchSize: 1, autoLayout });
  const res = mock.messages.find((m) => m.type === 'built' || m.type === 'build-error');
  console.log(JSON.stringify(res, null, 1).slice(0, 1500));
  console.log('created', mock.counts, 'in', Date.now() - t, 'ms');
  if (errors.length) console.log('warnings:\n' + errors.slice(0, 30).join('\n'));
  process.exit(res && res.type === 'built' && !res.result.errors ? 0 : 1);
})();
