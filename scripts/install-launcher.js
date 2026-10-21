'use strict';
// Installs the Odoo To Figma launcher as a macOS LaunchAgent (starts with your
// session), so the plugin's "Start server" button works without a terminal,
// and registers the MCP server in Claude Code so Claude can drive exports.
//
//   npm run install-launcher      install or update
//   npm run uninstall-launcher    remove everything
//
// The server is copied to ~/Library/Application Support/Odoo To Figma/app because
// macOS forbids background services from reading ~/Documents. The browser profile
// used by Claude sessions (cookies, logins) lives next to it and is kept on update.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const LABEL = 'com.odoo.odoo-to-figma.launcher';
const ROOT = path.resolve(__dirname, '..');
const HOME = os.homedir();
const APP_DIR = path.join(HOME, 'Library', 'Application Support', 'Odoo To Figma');
const APP = path.join(APP_DIR, 'app');
const MCP_NAME = 'odoo-to-figma';
const LOG_DIR = path.join(HOME, 'Library', 'Logs', 'Odoo To Figma');
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const DOMAIN = `gui/${process.getuid ? process.getuid() : 501}`;

function launchctl(...args) {
  try { execFileSync('launchctl', args, { stdio: 'pipe' }); return true; } catch (e) { return false; }
}

function stopAgent() {
  if (!launchctl('bootout', `${DOMAIN}/${LABEL}`)) launchctl('unload', PLIST);
}

function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function plist(node) {
  const pathEnv = [path.dirname(node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(path.join(APP, 'server', 'launcher.js'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(APP)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(pathEnv)}</string>
    <key>REPO_DIR</key><string>${xml(ROOT)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(path.join(LOG_DIR, 'launcher.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(LOG_DIR, 'launcher.log'))}</string>
</dict>
</plist>
`;
}

function ping() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 3998, path: '/health', timeout: 1000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function install() {
  if (process.platform !== 'darwin') {
    console.log('The launcher is for macOS only. On this system, start the server with "npm start".');
    return;
  }
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'puppeteer-core'))) {
    console.error('Run "npm install" in the odootofigma folder first.');
    process.exit(1);
  }
  stopAgent();
  // previous layout (code directly in APP_DIR)
  for (const old of ['server', 'node_modules', 'package.json']) fs.rmSync(path.join(APP_DIR, old), { recursive: true, force: true });
  fs.rmSync(APP, { recursive: true, force: true });
  fs.mkdirSync(APP, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  for (const item of ['server', 'node_modules', 'package.json']) {
    fs.cpSync(path.join(ROOT, item), path.join(APP, item), { recursive: true });
  }
  fs.writeFileSync(PLIST, plist(process.execPath));
  if (!launchctl('bootstrap', DOMAIN, PLIST) && !launchctl('load', '-w', PLIST)) {
    console.error(`Could not register the launcher (launchctl). File: ${PLIST}`);
    process.exit(1);
  }
  for (let i = 0; i < 20; i++) {
    if (await ping()) {
      console.log('✓ Odoo To Figma launcher installed. The plugin\'s "Start server" button is ready.');
      console.log(`  Logs: ${path.join(LOG_DIR, 'launcher.log')}`);
      registerMcp();
      console.log('  The plugin updates itself from GitHub each time it opens.');
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.error(`The launcher is not responding. See ${path.join(LOG_DIR, 'launcher.log')}`);
  process.exit(1);
}

function claudeCli() {
  for (const c of [path.join(HOME, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) if (fs.existsSync(c)) return c;
  try { return execFileSync('/usr/bin/which', ['claude'], { encoding: 'utf8' }).trim() || null; } catch (e) { return null; }
}

/** Register the MCP server in Claude Code (user scope) and show the Claude Desktop config. */
function registerMcp() {
  const mcp = path.join(APP, 'server', 'mcp.js');
  const cli = claudeCli();
  if (cli) {
    try { execFileSync(cli, ['mcp', 'remove', '-s', 'user', MCP_NAME], { stdio: 'pipe' }); } catch (e) { /* not registered yet */ }
    try {
      execFileSync(cli, ['mcp', 'add', '-s', 'user', MCP_NAME, '--', process.execPath, mcp], { stdio: 'pipe' });
      console.log(`✓ MCP "${MCP_NAME}" added to Claude Code (all your projects). Restart Claude Code to use it.`);
    } catch (e) {
      console.log(`⚠ Could not add the MCP to Claude Code: ${(e.stderr || e.message || '').toString().trim()}`);
    }
  }
  console.log('  For Claude Desktop, add to claude_desktop_config.json → "mcpServers":');
  console.log(`  "${MCP_NAME}": { "command": ${JSON.stringify(process.execPath)}, "args": [${JSON.stringify(mcp)}] }`);
}

function uninstall() {
  if (process.platform !== 'darwin') return;
  const cli = claudeCli();
  if (cli) { try { execFileSync(cli, ['mcp', 'remove', '-s', 'user', MCP_NAME], { stdio: 'pipe' }); } catch (e) { /* not registered */ } }
  stopAgent();
  fs.rmSync(PLIST, { force: true });
  fs.rmSync(APP_DIR, { recursive: true, force: true });
  console.log('✓ Odoo To Figma launcher removed.');
}

if (process.argv.includes('--uninstall')) uninstall();
else install();
