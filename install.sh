#!/usr/bin/env bash
# Install peek for the current user. Safe to run again: every step is idempotent.
#
# Environment overrides:
#   PEEK_LABEL       launchd label            (default: com.<user>.peek)
#   PEEK_BIN_DIR     where the `peek` symlink goes (default: ~/.local/bin)
#   PEEK_TAILSCALE   0 to skip `tailscale serve` (default: 1)
#   PEEK_AGENT_LINE  the line added to CLAUDE.md / AGENTS.md
#   CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_CONFIG_HOME
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }

# --- bun (absolute path: launchd has no PATH) --------------------------------
BUN="${BUN:-$(command -v bun || true)}"
[ -n "$BUN" ] || BUN="$HOME/.bun/bin/bun"
[ -x "$BUN" ] || die "bun not found. Install it from https://bun.sh"
BUN="$(cd "$(dirname "$BUN")" && pwd -P)/$(basename "$BUN")"

LABEL="${PEEK_LABEL:-com.$(id -un).peek}"
BIN_DIR="${PEEK_BIN_DIR:-$HOME/.local/bin}"
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/peek"
CONF="$CONF_DIR/env"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
LOG_DIR="$HOME/Library/Logs/peek"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
AGENT_LINE="${PEEK_AGENT_LINE:-To show the user an image, PDF, HTML page or video, run \`peek <file> -n \"<what it shows>\"\`. They view it in the peek browser tab.}"

TS="$(command -v tailscale || true)"
[ -n "$TS" ] || { [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale; } || true

# --- 1. config ---------------------------------------------------------------
mkdir -p "$CONF_DIR"
if [ ! -f "$CONF" ]; then
  public="http://127.0.0.1:8790/"
  mount=""
  if [ "${PEEK_TAILSCALE:-1}" != 0 ] && [ -n "$TS" ]; then
    host="$("$TS" status --json 2>/dev/null | "$BUN" -e 'const s=await Bun.stdin.json();process.stdout.write((s.Self?.DNSName||"").replace(/\.$/,""))' 2>/dev/null || true)"
    if [ -n "$host" ]; then public="https://$host/peek/"; mount="/peek"; fi
  fi
  cat > "$CONF" <<CONF
# peek configuration (read by the CLI, the hooks and the server)
PEEK_PORT=8790
PEEK_DIR=~/.peek
PEEK_PUBLIC_URL=$public
PEEK_MOUNT=$mount
CONF
  say "wrote $CONF"
else
  say "kept existing $CONF"
fi
# Read the values the way peek itself does (quotes, comments, env overrides).
eval "$(PEEK_CONFIG="$CONF" "$BUN" -e '
  const { loadConfig } = await import(process.argv[1]);
  const c = loadConfig();
  const q = (v) => "\x27" + String(v).replaceAll("\x27", "\x27\\\x27\x27") + "\x27";
  console.log(`PORT=${q(c.port)}; MOUNT=${q(c.mount)}`);
' "$REPO/src/config.ts")"

printf '%s\n' "$BUN" > "$CONF_DIR/bun"   # bin/peek uses it when bun is not on PATH

# --- 2. CLI symlink ----------------------------------------------------------
mkdir -p "$BIN_DIR"
if [ -e "$BIN_DIR/peek" ] && [ ! -L "$BIN_DIR/peek" ]; then
  die "$BIN_DIR/peek exists and is not a symlink. Move it away, or set PEEK_BIN_DIR."
fi
ln -sfn "$REPO/bin/peek" "$BIN_DIR/peek"
say "linked $BIN_DIR/peek"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "note: $BIN_DIR is not on PATH" ;; esac

# --- 3. launchd --------------------------------------------------------------
if [ "$(uname)" = Darwin ]; then
  mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"
  tmp="$(mktemp)"
  # The server MUST read the same config file as the CLI and the hooks.
  sed -e "s|__LABEL__|$LABEL|g" -e "s|__BUN__|$BUN|g" -e "s|__REPO__|$REPO|g" -e "s|__LOG_DIR__|$LOG_DIR|g" \
    -e "s|__CONFIG__|$CONF|g" "$REPO/launchd/peek.plist.template" > "$tmp"
  plutil -lint "$tmp" >/dev/null || die "generated plist is invalid"
  domain="gui/$(id -u)"
  if ! cmp -s "$tmp" "$PLIST"; then
    if launchctl bootout "$domain/$LABEL" 2>/dev/null; then
      # bootout returns before the job is gone; bootstrap too early fails with error 5.
      for _ in $(seq 1 50); do launchctl print "$domain/$LABEL" >/dev/null 2>&1 || break; sleep 0.1; done
    fi
    mv "$tmp" "$PLIST"
    say "wrote $PLIST"
  else
    rm -f "$tmp"
  fi
  if ! launchctl print "$domain/$LABEL" >/dev/null 2>&1; then
    ok=""
    for _ in 1 2 3 4 5; do
      if launchctl bootstrap "$domain" "$PLIST" 2>/dev/null; then ok=1; break; fi
      sleep 1
    done
    [ -n "$ok" ] || launchctl bootstrap "$domain" "$PLIST" || die "launchctl bootstrap failed for $PLIST"
    say "loaded $LABEL"
  else
    launchctl kickstart -k "$domain/$LABEL"
    say "restarted $LABEL"
  fi
else
  say "not macOS: skipping launchd. Run \`peek serve\` under your own supervisor."
fi

# --- 4. Claude Code hooks ----------------------------------------------------
mkdir -p "$CLAUDE_DIR"
"$BUN" "$REPO/scripts/claude-config.ts" hooks install "$CLAUDE_DIR/settings.json" \
  "\"$BUN\" \"$REPO/src/cli.ts\" hook read" \
  "\"$BUN\" \"$REPO/src/cli.ts\" hook prompt"

# --- 5. agent instructions ---------------------------------------------------
"$BUN" "$REPO/scripts/claude-config.ts" line install "$CLAUDE_DIR/CLAUDE.md" "$AGENT_LINE"
if [ -f "$CODEX_DIR/AGENTS.md" ]; then
  "$BUN" "$REPO/scripts/claude-config.ts" line install "$CODEX_DIR/AGENTS.md" "$AGENT_LINE"
fi

# --- 6. tailscale serve ------------------------------------------------------
if [ "${PEEK_TAILSCALE:-1}" != 0 ] && [ -n "$TS" ] && [ -n "$MOUNT" ]; then
  # Output stays visible: if Serve is not enabled on the tailnet, tailscale
  # prints the URL to enable it and waits.
  say "tailscale serve: $MOUNT -> 127.0.0.1:$PORT"
  "$TS" serve --bg --set-path "$MOUNT" "http://127.0.0.1:$PORT"
fi

# --- 7. health ---------------------------------------------------------------
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:$PORT/api/items" >/dev/null 2>&1; then
    say "server is up. Viewer: $(PEEK_CONFIG="$CONF" "$BUN" "$REPO/src/cli.ts" url)"
    exit 0
  fi
  sleep 0.5
done
die "server did not answer on 127.0.0.1:$PORT. See $LOG_DIR/server-error.log"
