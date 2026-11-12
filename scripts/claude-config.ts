// Idempotent edits to Claude Code / Codex config, used by install.sh and uninstall.sh.
//
//   bun scripts/claude-config.ts hooks install   <settings.json> <read-cmd> <prompt-cmd>
//   bun scripts/claude-config.ts hooks uninstall <settings.json>
//   bun scripts/claude-config.ts line  install   <file> <line>
//   bun scripts/claude-config.ts line  uninstall <file>
//
// Hooks are merged into the existing arrays. Entries from other tools are never touched.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

type Hook = { type: string; command?: string; timeout?: number; [k: string]: unknown };
type Group = { matcher?: string; hooks?: Hook[]; [k: string]: unknown };
type Settings = { hooks?: Record<string, Group[]>; [k: string]: unknown };

const KINDS = {
  read: { event: "PostToolUse", matcher: "Read" as string | undefined },
  prompt: { event: "UserPromptSubmit", matcher: undefined as string | undefined },
};

export function isPeekHook(cmd: unknown, kind: "read" | "prompt"): boolean {
  // Matches `"<bun>" "<repo>/src/cli.ts" hook <kind>` and `peek hook <kind>`,
  // wherever the repo is cloned.
  return typeof cmd === "string" && new RegExp(`(src/cli\\.ts|\\bpeek)["']?\\s+hook\\s+${kind}\\s*$`).test(cmd);
}

function strip(settings: Settings, kind: "read" | "prompt") {
  const arr = settings.hooks?.[KINDS[kind].event];
  if (!arr) return;
  const out: Group[] = [];
  for (const g of arr) {
    const hooks = (g.hooks ?? []).filter((h) => !isPeekHook(h.command, kind));
    if (hooks.length === (g.hooks ?? []).length) out.push(g);
    else if (hooks.length) out.push({ ...g, hooks });
  }
  if (out.length) settings.hooks![KINDS[kind].event] = out;
  else delete settings.hooks![KINDS[kind].event];
}

export function installHooks(settings: Settings, cmds: { read: string; prompt: string }): Settings {
  const s: Settings = structuredClone(settings);
  s.hooks ??= {};
  for (const kind of ["read", "prompt"] as const) {
    const { event, matcher } = KINDS[kind];
    const want: Group = { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: cmds[kind], timeout: 5 }] };
    const arr = s.hooks[event] ?? [];
    const mine = arr.filter((g) => (g.hooks ?? []).some((h) => isPeekHook(h.command, kind)));
    if (mine.length === 1 && JSON.stringify(mine[0]) === JSON.stringify(want)) continue;
    strip(s, kind);
    (s.hooks[event] ??= []).push(want);
  }
  return s;
}

export function uninstallHooks(settings: Settings): Settings {
  const s: Settings = structuredClone(settings);
  strip(s, "read");
  strip(s, "prompt");
  if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
  return s;
}

const MARK = /run `peek <file>/;

export function installLine(text: string, line: string): string {
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => MARK.test(l));
  if (idx >= 0) {
    lines[idx] = line;
    return lines.filter((l, i) => i <= idx || !MARK.test(l)).join("\n");
  }
  const body = text.replace(/\n*$/, "");
  return (body ? body + "\n\n" : "") + line + "\n";
}

export function uninstallLine(text: string): string {
  return text
    .split("\n")
    .filter((l) => !MARK.test(l))
    .join("\n")
    .replace(/\n{3,}$/, "\n");
}

function writeIfChanged(path: string, before: string, after: string): boolean {
  if (before === after) return false;
  if (before) writeFileSync(`${path}.peek-backup`, before);
  const tmp = `${path}.peek-tmp`;
  writeFileSync(tmp, after);
  renameSync(tmp, path);
  return true;
}

if (import.meta.main) {
  const [what, action, path, ...args] = process.argv.slice(2);
  if (!what || !action || !path) {
    console.error("usage: claude-config.ts hooks|line install|uninstall <file> [...]");
    process.exit(2);
  }
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  let after: string;
  if (what === "hooks") {
    const settings: Settings = before.trim() ? JSON.parse(before) : {};
    const next =
      action === "install" ? installHooks(settings, { read: args[0]!, prompt: args[1]! }) : uninstallHooks(settings);
    after = JSON.stringify(settings) === JSON.stringify(next) ? before : JSON.stringify(next, null, 2) + "\n";
  } else if (what === "line") {
    if (action === "uninstall" && !before) process.exit(0);
    after = action === "install" ? installLine(before, args[0]!) : uninstallLine(before);
  } else {
    console.error(`unknown target '${what}'`);
    process.exit(2);
  }
  console.log(`${writeIfChanged(path, before, after) ? "updated" : "unchanged"}: ${path}`);
}
