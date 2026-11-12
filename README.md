# peek

A clipboard for images between coding agents on a remote machine and you, over your tailnet.

Agents (Claude Code, Codex, scripts) run on a headless box you reach over ssh. When an agent wants to show you a screenshot, the file exists only on that box, and a terminal can't display it. peek fixes both directions:

- **Agent → you:** `peek shot.png -n "login page after the fix"` puts the file on a board. An open browser tab on your laptop, phone or tablet shows it within a second, with no reload. A Claude Code hook also pushes every image an agent `Read`s.
- **You → agent:** drop, paste or pick a file in the same tab. The next prompt in a Claude Code session gets its path in context, one time only.

Supported types: PNG, JPG, WebP, GIF, SVG, PDF, HTML (sandboxed) and video (mp4, mov). The board keeps the 8 newest items for at most 24 hours. The inbox follows the same rule.

## Requirements

- macOS (launchd). The server and CLI also run on Linux. Supervise `peek serve` yourself there.
- [Bun](https://bun.sh) 1.1 or later. No npm dependencies.
- [Tailscale](https://tailscale.com) for access from other devices (optional; without it peek serves on `127.0.0.1` only).

## Install

```sh
git clone https://github.com/enrique7mc/peek.git ~/projects/peek
cd ~/projects/peek
./install.sh
```

`install.sh` is idempotent. It:

1. Writes `~/.config/peek/env` if the file is missing. If Tailscale is running, it sets `PEEK_PUBLIC_URL=https://<your-machine>.<tailnet>.ts.net/peek/`.
2. Links `~/.local/bin/peek` to `bin/peek`.
3. Writes a launchd agent (`com.<user>.peek`, from `launchd/peek.plist.template`) with `KeepAlive` and `RunAtLoad`. Logs go to `~/Library/Logs/peek/`.
4. Merges two hooks into `~/.claude/settings.json`. Existing hooks stay. The previous file is saved as `settings.json.peek-backup`.
   - `PostToolUse` with matcher `Read` → `peek hook read`
   - `UserPromptSubmit` → `peek hook prompt`
5. Adds one line to `~/.claude/CLAUDE.md` (and `~/.codex/AGENTS.md` if it exists) that tells agents how to use `peek`.
6. Runs `tailscale serve --bg --set-path /peek http://127.0.0.1:8790`. Other serve routes are not touched.

Overrides: `PEEK_LABEL`, `PEEK_BIN_DIR`, `PEEK_TAILSCALE=0`, `PEEK_AGENT_LINE`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`.

`./uninstall.sh` reverses steps 2 to 6. It keeps `~/.peek` and the config file.

## Usage

```
peek <file>... [-n "note"]   Put files on the board and print the viewer URL
peek ls                      List the board and the inbox
peek pull                    Print paths of unclaimed uploads and mark them claimed
peek rm <id>                 Delete one item
peek --clear                 Empty the board
peek url                     Print the viewer URL
peek serve                   Run the server in the foreground
```

Open the URL from `peek url` on any device in your tailnet. While the tab is in the background, the title shows `(N) peek` and the icon gets a dot. Focusing the tab clears them.

## Configuration

`~/.config/peek/env` (or `$PEEK_CONFIG`). Environment variables take precedence.

| Key | Default | Meaning |
|---|---|---|
| `PEEK_PORT` | `8790` | Port on `127.0.0.1` |
| `PEEK_DIR` | `~/.peek` | Data directory (`board/`, `inbox/`) |
| `PEEK_PUBLIC_URL` | `http://127.0.0.1:8790/` | URL the CLI prints |
| `PEEK_MOUNT` | (empty) | Path prefix of the reverse proxy, such as `/peek` |

## How it works

```
agent (Read hook / peek CLI) ──writes──▶ ~/.peek/board/ ◀──watches── server :8790 ◀── tailscale serve /peek ◀── browser
browser upload ──POST──▶ server ──writes──▶ ~/.peek/inbox/ ◀──claims── UserPromptSubmit hook ──▶ agent context
```

- The filesystem is the only source of truth. Each item is `<id>.<ext>` plus `<id>.json`. Writers write a temp file and rename it. The CLI and the hooks work while the server is down.
- On the board, a file with the same SHA-256 as an existing item moves that item to the top. It does not add a duplicate. So an agent that reads the same screenshot again does not flood the board.
- The prompt hook claims uploads from the last 30 minutes only, so a stale upload does not land in some other session days later. `peek pull` has no time limit. A claim is an `O_EXCL` create of `<id>.claim`, so two sessions can't claim the same item.
- The hooks always exit 0 and finish in about 10 ms. A Read never fails because of peek.
- `tailscale serve --set-path` strips the prefix before it proxies. The page uses relative URLs only, so it works at any mount path.

## Security model

peek has no login. Access control is your tailnet: the server binds to `127.0.0.1`, and `tailscale serve` (not `funnel`) exposes it to tailnet members only.

- `/files/<id>` resolves IDs only. It never accepts a path from the client.
- HTML items render in `<iframe sandbox="allow-scripts">` and are served with `Content-Security-Policy: sandbox allow-scripts`. They can't read the viewer, its cookies or its storage. SVG renders through `<img>` and is served with a sandbox CSP.
- Uploads and deletes require an `X-Peek` header and a same-origin request. A web page on another origin can't push files into an agent's context.
- Uploads are limited to 50 MB per file and to the supported types.

Anything you upload becomes text in an agent's prompt context. Upload only files you mean the agent to read.

## Development

```sh
bun test          # unit and HTTP tests, uses temp dirs
bun src/server.ts # run the server in the foreground
```

## License

MIT
