import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { loadConfig } from "./config";
import { hookPrompt, hookRead } from "./hooks";
import * as store from "./store";

const HELP = `peek - show files in a browser tab, and receive uploads back

Usage:
  peek <file>... [-n "note"]   Put files on the board and print the viewer URL
  peek ls                      List the board and the inbox
  peek pull                    Print paths of unclaimed uploads and mark them claimed
  peek rm <id>                 Delete one item
  peek --clear                 Empty the board
  peek url                     Print the viewer URL
  peek serve                   Run the server in the foreground
  peek hook read|prompt        Claude Code hook handlers (read JSON on stdin)

Supported types: ${store.supportedList()}
`;

function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

const err = (msg: string) => process.stderr.write(`peek: ${msg}\n`);

async function main(argv: string[]): Promise<number> {
  const cfg = loadConfig();
  const [cmd, ...rest] = argv;

  if (cmd === "hook") {
    // Hooks: always exit 0, never print anything except the prompt context.
    const kill = setTimeout(() => process.exit(0), 3000);
    try {
      const input = await Bun.stdin.text();
      if (rest[0] === "read") hookRead(input, cfg);
      else if (rest[0] === "prompt") {
        const out = hookPrompt(input, cfg);
        if (out) process.stdout.write(out + "\n");
      }
    } catch {}
    clearTimeout(kill);
    return 0;
  }

  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    process.stdout.write(HELP);
    return cmd ? 0 : 1;
  }

  if (cmd === "url") {
    console.log(cfg.publicUrl);
    return 0;
  }

  if (cmd === "serve") {
    const { startServer } = await import("./server");
    startServer(cfg);
    return -1; // keep running
  }

  if (cmd === "ls") {
    const now = Date.now();
    const board = store.list(cfg, "board");
    const inbox = store.list(cfg, "inbox");
    console.log(`board (${board.length})`);
    for (const i of board)
      console.log(`  ${i.id}  ${i.source.padEnd(6)} ${ago(i.created, now).padStart(4)}  ${i.name}${i.note ? `  — ${i.note}` : ""}`);
    console.log(`inbox (${inbox.length})`);
    for (const i of inbox) {
      const status = i.claimed ? `claimed by ${(i.claimedBy || "?").slice(0, 8)}` : "waiting";
      console.log(`  ${i.id}  ${status.padEnd(19)} ${ago(i.created, now).padStart(4)}  ${store.pathOf(cfg, "inbox", i)}${i.note ? `  — ${i.note}` : ""}`);
    }
    return 0;
  }

  if (cmd === "pull") {
    for (const i of store.unclaimed(cfg)) {
      const c = store.claim(cfg, i.id, "peek-pull");
      if (c) console.log(store.pathOf(cfg, "inbox", c));
    }
    return 0;
  }

  if (cmd === "rm") {
    if (!rest.length) {
      err("usage: peek rm <id>...");
      return 2;
    }
    let code = 0;
    for (const id of rest) {
      if (store.remove(cfg, id)) console.log(`removed ${id}`);
      else {
        err(`no item with id '${id}'`);
        code = 1;
      }
    }
    return code;
  }

  if (cmd === "--clear" || cmd === "clear") {
    console.log(`cleared ${store.clear(cfg, "board")} item(s) from the board`);
    return 0;
  }

  // Default: push files.
  const files: string[] = [];
  let note: string | null = null;
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k]!;
    if (a === "-n" || a === "--note") {
      if (k + 1 >= argv.length) {
        err(`${a} needs a value`);
        return 2;
      }
      note = argv[++k]!;
    } else if (a.startsWith("--note=")) note = a.slice(7);
    else if (a === "--") files.push(...argv.slice(k + 1)), (k = argv.length);
    else if (a.startsWith("-") && a.length > 1) {
      err(`unknown option '${a}' (see peek --help)`);
      return 2;
    } else files.push(a);
  }
  if (!files.length) {
    err("no files given (see peek --help)");
    return 2;
  }

  if (files.length > store.MAX_ITEMS)
    err(`warning: the board keeps ${store.MAX_ITEMS} items, so only the last ${store.MAX_ITEMS} of ${files.length} files stay`);
  let code = 0;
  let pushed = 0;
  for (const f of files) {
    const abs = resolve(f);
    if (!store.isSupported(abs)) {
      err(`${f}: unsupported type '${store.extOf(abs) ? "." + store.extOf(abs) : "(none)"}' (supported: ${store.supportedList()})`);
      code = 1;
      continue;
    }
    try {
      if (!statSync(abs).isFile()) throw new Error("not a regular file");
      const { item, deduped } = store.add(cfg, "board", { srcPath: abs, name: abs, note, source: "cli", cwd: process.cwd() });
      console.log(`${deduped ? "moved to top" : "added"}  ${item.id}  ${basename(abs)}`);
      pushed++;
    } catch (e: any) {
      err(`${f}: ${e?.code === "ENOENT" ? "no such file" : e?.message ?? e}`);
      code = 1;
    }
  }
  if (pushed) console.log(cfg.publicUrl);
  return code;
}

const code = await main(process.argv.slice(2));
if (code >= 0) process.exit(code);
