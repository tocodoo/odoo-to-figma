#!/usr/bin/env bash
# Odoo To Figma – one-command install (macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/tocodoo/odoo-to-figma/main/install.sh | bash
#   or, from a clone: ./install.sh
#
# Always installs from a git clone, so the plugin can update itself from GitHub:
# installs git if needed, clones the repo (to ~/odootofigma) when run from
# anywhere else, then installs the dependencies, the launcher (starts the server
# from the plugin) and the MCP for Claude Code. Running it again updates everything.
set -euo pipefail

REPO_URL="${ODOO_TO_FIGMA_REPO:-https://github.com/tocodoo/odoo-to-figma.git}"
INSTALL_DIR="${ODOO_TO_FIGMA_DIR:-$HOME/odootofigma}"

ok() { printf '\033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '\033[33m⚠\033[0m %s\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1"; exit 1; }

echo "Odoo To Figma – install"
echo

[[ "$(uname)" == "Darwin" ]] || fail "This script is for macOS. Elsewhere: git clone, npm install, then npm start."

# 1. Git (ships with Apple's Command Line Tools)
if ! git --version >/dev/null 2>&1; then
  xcode-select --install >/dev/null 2>&1 || true
  fail "Git is required. A macOS window opened to install it (Command Line Tools): click Install, wait for it to finish, then run this command again."
fi
ok "$(git --version)"

# 2. Run from a git clone, or create one
HERE=""
[[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]] && HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "$HERE" || ! -e "$HERE/.git" ]]; then
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    echo "… updating $INSTALL_DIR"
    git -C "$INSTALL_DIR" pull --ff-only --quiet
  else
    [[ -e "$INSTALL_DIR" ]] && fail "$INSTALL_DIR already exists and is not a git clone. Move it away, then run this command again."
    echo "… downloading Odoo To Figma into $INSTALL_DIR"
    git clone --quiet "$REPO_URL" "$INSTALL_DIR"
  fi
  ok "Git clone: $INSTALL_DIR"
  exec bash "$INSTALL_DIR/install.sh"
fi
cd "$HERE"
git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1 \
  || warn "This branch does not track a GitHub branch: automatic updates are off."
case "$HERE" in
  "$HOME/Documents"*|"$HOME/Desktop"*|"$HOME/Downloads"*)
    warn "macOS keeps background services out of $HERE: automatic updates may not work. Prefer a folder like ~/odootofigma." ;;
esac
ok "Git clone: $HERE"

# 3. Node.js and Chrome
command -v node >/dev/null 2>&1 || fail "Node.js not found. Install it from https://nodejs.org (version 18 or later), then run this command again."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 18 )) || fail "Node.js $(node -v) is too old: version 18 or later is required (https://nodejs.org)."
ok "Node.js $(node -v)"

CHROME=""
for c in "/Applications/Google Chrome.app" "$HOME/Applications/Google Chrome.app" "/Applications/Chromium.app" "/Applications/Microsoft Edge.app" "/Applications/Brave Browser.app"; do
  [[ -d "$c" ]] && { CHROME="$c"; break; }
done
[[ -n "$CHROME" ]] || fail "Google Chrome not found. Install it from https://www.google.com/chrome, then run this command again."
ok "Browser: $(basename "$CHROME" .app)"

# 4. Dependencies, launcher, MCP
echo "… installing dependencies"
npm install --no-audit --no-fund --loglevel=error
ok "Dependencies installed"

echo "… installing the launcher and the Claude MCP"
node scripts/install-launcher.js

PLUGIN_MANIFEST="$(pwd)/figma-plugin/manifest.json"
cat <<EOF

────────────────────────────────────────────────────────────
Last step, in Figma Desktop:
  Plugins → Development → Import plugin from manifest…
  then pick:
  $PLUGIN_MANIFEST

Then: Plugins → Development → Odoo To Figma.
If you use Claude Code, restart it to enable the MCP.
────────────────────────────────────────────────────────────
EOF
