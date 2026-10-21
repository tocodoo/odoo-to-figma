#!/usr/bin/env bash
# Odoo To Figma – one-command install (macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/tocodoo/odoo-to-figma/main/install.sh | bash
#   or, from a clone: ./install.sh
#
# Checks every prerequisite and installs what is missing (Git, Node.js, Google
# Chrome, Figma Desktop), always installs from a git clone so the plugin can
# update itself from GitHub (clones the repo to ~/odootofigma when run from
# anywhere else), then installs the dependencies, the launcher (starts the server
# from the plugin) and the MCP for Claude Code. Running it again updates everything.
set -euo pipefail

REPO_URL="${ODOO_TO_FIGMA_REPO:-https://github.com/tocodoo/odoo-to-figma.git}"
INSTALL_DIR="${ODOO_TO_FIGMA_DIR:-$HOME/odootofigma}"
SUPPORT_DIR="$HOME/Library/Application Support/Odoo To Figma"
ARCH="$(uname -m)"

ok() { printf '\033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '\033[33m⚠\033[0m %s\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1"; exit 1; }

echo "Odoo To Figma – install"
echo

[[ "$(uname)" == "Darwin" ]] || fail "This script is for macOS. Elsewhere: git clone, npm install, then npm start."

# 1. Git (ships with Apple's Command Line Tools)
if ! git --version >/dev/null 2>&1; then
  echo "… installing Git: click Install in the macOS window that opens, then wait here"
  xcode-select --install >/dev/null 2>&1 || true
  for _ in $(seq 1 720); do xcode-select -p >/dev/null 2>&1 && break; sleep 5; done
  git --version >/dev/null 2>&1 || fail "Git is still missing. Finish the Command Line Tools install, then run this command again."
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

# 3. Node.js, Google Chrome and Figma Desktop (downloaded from their official sites)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

find_app() {
  for d in "/Applications" "$HOME/Applications"; do
    [[ -d "$d/$1.app" ]] && { echo "$d/$1.app"; return 0; }
  done
  return 1
}

# Copies an .app into /Applications, or ~/Applications without admin rights.
install_app() {
  local dest="/Applications"
  [[ -w "$dest" ]] || { dest="$HOME/Applications"; mkdir -p "$dest"; }
  ditto --noextattr --norsrc "$1" "$dest/$(basename "$1")"
  ok "$(basename "$1" .app) installed in $dest"
}

NODE_DIR="$SUPPORT_DIR/node"
[[ -x "$NODE_DIR/bin/node" ]] && export PATH="$NODE_DIR/bin:$PATH"
node_ok() { command -v node >/dev/null 2>&1 && (( $(node -p 'process.versions.node.split(".")[0]') >= 18 )); }
if ! node_ok; then
  echo "… installing Node.js"
  NODE_URL="https://nodejs.org/dist/latest-v22.x"
  LINE="$(curl -fsSL "$NODE_URL/SHASUMS256.txt" | grep "darwin-$([[ "$ARCH" == arm64 ]] && echo arm64 || echo x64)\.tar\.gz$")"
  FILE="${LINE##* }"
  curl -fL# "$NODE_URL/$FILE" -o "$TMP/$FILE"
  [[ "$(shasum -a 256 "$TMP/$FILE" | cut -d' ' -f1)" == "${LINE%% *}" ]] || fail "The Node.js download is corrupted. Run this command again."
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
  tar -xzf "$TMP/$FILE" -C "$NODE_DIR" --strip-components 1
  export PATH="$NODE_DIR/bin:$PATH"
fi
ok "Node.js $(node -v)"

CHROME=""
for c in "Google Chrome" "Chromium" "Microsoft Edge" "Brave Browser"; do
  CHROME="$(find_app "$c")" && break
done
if [[ -z "$CHROME" ]]; then
  echo "… installing Google Chrome"
  curl -fL# "https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg" -o "$TMP/chrome.dmg"
  hdiutil attach -nobrowse -readonly -quiet -mountpoint "$TMP/chrome" "$TMP/chrome.dmg"
  install_app "$TMP/chrome/Google Chrome.app"
  hdiutil detach -quiet "$TMP/chrome"
  CHROME="$(find_app "Google Chrome")"
fi
ok "Browser: $(basename "$CHROME" .app)"

if ! find_app "Figma" >/dev/null; then
  echo "… installing Figma Desktop"
  curl -fL# "https://desktop.figma.com/$([[ "$ARCH" == arm64 ]] && echo mac-arm || echo mac)/Figma.zip" -o "$TMP/figma.zip"
  ditto -x -k "$TMP/figma.zip" "$TMP/figma"
  install_app "$TMP/figma/Figma.app"
fi
ok "Figma Desktop"

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
