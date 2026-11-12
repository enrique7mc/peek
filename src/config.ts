import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Config {
  port: number;
  dir: string;
  boardDir: string;
  inboxDir: string;
  publicUrl: string;
  /** Path prefix the proxy mounts us under, e.g. "/peek". "" when served at the root. */
  mount: string;
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p.replace(/^\$HOME(?=\/|$)/, homedir());
}

/** Parse a KEY=VALUE file. Missing or unreadable files yield {}. */
export function readEnvFile(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const value = m[2]!.trim();
    const quoted = value.match(/^(["'])(.*)\1(?:\s+#.*)?$/);
    out[m[1]!] = quoted ? quoted[2]! : value.replace(/(^|\s+)#.*$/, "");
  }
  return out;
}

export function configPath(env: Record<string, string | undefined> = process.env): string {
  if (env.PEEK_CONFIG) return expandHome(env.PEEK_CONFIG);
  const base = env.XDG_CONFIG_HOME ? expandHome(env.XDG_CONFIG_HOME) : join(homedir(), ".config");
  return join(base, "peek", "env");
}

/** Process env wins over the config file; the config file wins over defaults. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const file = readEnvFile(configPath(env));
  // An empty value means "unset", in the environment and in the file alike.
  const get = (k: string) => {
    const v = env[k]?.trim() || file[k]?.trim();
    return v ? v : undefined;
  };

  const rawPort = Number(get("PEEK_PORT") ?? 8790);
  const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : 8790;
  // A relative PEEK_DIR would follow each hook's cwd; anchor it at $HOME.
  const dir = resolve(homedir(), expandHome(get("PEEK_DIR") ?? "~/.peek"));
  let mount = (get("PEEK_MOUNT") ?? "").replace(/\/+$/, "");
  if (mount && !mount.startsWith("/")) mount = "/" + mount;
  let publicUrl = get("PEEK_PUBLIC_URL") ?? `http://127.0.0.1:${port}/`;
  if (!publicUrl.endsWith("/")) publicUrl += "/";

  return {
    port,
    dir,
    boardDir: join(dir, "board"),
    inboxDir: join(dir, "inbox"),
    publicUrl,
    mount,
  };
}

export function configFor(dir: string, extra: Partial<Config> = {}): Config {
  return {
    port: 0,
    dir,
    boardDir: join(dir, "board"),
    inboxDir: join(dir, "inbox"),
    publicUrl: "http://127.0.0.1:8790/",
    mount: "",
    ...extra,
  };
}
