#!/usr/bin/env bash
# Remove everything install.sh set up. Safe to run again. Keeps ~/.peek and the config file.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
say() { printf '\033[1m==>\033[0m %s\n' "$*"; }

BUN="${BUN:-$(command -v bun || true)}"
[ -n "$BUN" ] || BUN="$HOME/.bun/bin/bun"
LABEL="${PEEK_LABEL:-com.$(id -un).peek}"
BIN_DIR="${PEEK_BIN_DIR:-$HOME/.local/bin}"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}/peek/env"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

TS="$(command -v tailscale || true)"
[ -n "$TS" ] || { [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale; } || true
MOUNT="$( [ -f "$CONF" ] && sed -n 's/^PEEK_MOUNT=//p' "$CONF" | tail -1 || true)"

if [ "${PEEK_TAILSCALE:-1}" != 0 ] && [ -n "$TS" ] && [ -n "$MOUNT" ]; then
  if "$TS" serve status 2>/dev/null | grep -q -- "|-- $MOUNT "; then
    "$TS" serve --https=443 --set-path "$MOUNT" off >/dev/null && say "tailscale serve: removed $MOUNT"
  fi
fi

if [ "$(uname)" = Darwin ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && say "unloaded $LABEL" || true
  [ -f "$PLIST" ] && rm -f "$PLIST" && say "removed $PLIST" || true
fi

if [ -L "$BIN_DIR/peek" ] && [ "$(readlink "$BIN_DIR/peek")" = "$REPO/bin/peek" ]; then
  rm -f "$BIN_DIR/peek"; say "removed $BIN_DIR/peek"
fi

rm -f "$(dirname "$CONF")/bun"

if [ -x "$BUN" ]; then
  [ -f "$CLAUDE_DIR/settings.json" ] && "$BUN" "$REPO/scripts/claude-config.ts" hooks uninstall "$CLAUDE_DIR/settings.json" \
    "\"$BUN\" \"$REPO/src/cli.ts\" hook read" "\"$BUN\" \"$REPO/src/cli.ts\" hook prompt"
  [ -f "$CLAUDE_DIR/CLAUDE.md" ] && "$BUN" "$REPO/scripts/claude-config.ts" line uninstall "$CLAUDE_DIR/CLAUDE.md"
  [ -f "$CODEX_DIR/AGENTS.md" ] && "$BUN" "$REPO/scripts/claude-config.ts" line uninstall "$CODEX_DIR/AGENTS.md"
fi
say "done. Data in ~/.peek and config in $CONF were kept."
