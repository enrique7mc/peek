import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFor, loadConfig, type Config } from "../src/config";
import { hookPrompt, hookRead, isUnattended } from "../src/hooks";
import { startServer } from "../src/server";
import * as store from "../src/store";
import { installHooks, installLine, isPeekHook, uninstallHooks, uninstallLine } from "../scripts/claude-config";

const REPO = join(import.meta.dir, "..");
const BUN = process.execPath;
const ATTENDED = { CLAUDE_CODE_SESSION_ATTENDED: "1", CLAUDE_CODE_ENTRYPOINT: "cli" };

const roots: string[] = [];
function fresh(): { cfg: Config; root: string } {
  const root = mkdtempSync(join(tmpdir(), "peek-test-"));
  roots.push(root);
  return { cfg: configFor(join(root, "data")), root };
}
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

const PNG = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
);
function file(root: string, name: string, data: Uint8Array | string = PNG) {
  const p = join(root, name);
  writeFileSync(p, data);
  return p;
}

describe("store", () => {
  let cfg: Config, root: string;
  beforeEach(() => ({ cfg, root } = fresh()));

  test("adds a file with metadata and time-sortable id", () => {
    const { item } = store.add(cfg, "board", { srcPath: file(root, "a.png"), name: "a.png", source: "cli", note: "hi", cwd: "/x/y" });
    expect(item.id).toMatch(store.ID_RE);
    expect(item).toMatchObject({ name: "a.png", mime: "image/png", size: PNG.byteLength, note: "hi", source: "cli", cwd: "/x/y" });
    expect(existsSync(join(cfg.boardDir, item.file))).toBe(true);
    expect(store.list(cfg, "board")).toHaveLength(1);
    expect(readdirSync(cfg.boardDir).some((n) => n.startsWith(".tmp"))).toBe(false);
  });

  test("rejects unsupported types", () => {
    expect(() => store.add(cfg, "board", { srcPath: file(root, "a.txt", "x"), name: "a.txt", source: "cli" })).toThrow(/unsupported/);
  });

  test("same content on the board moves to the top instead of duplicating", () => {
    const t = Date.now() - 10_000;
    const a = store.add(cfg, "board", { srcPath: file(root, "a.png"), name: "a.png", source: "hook", now: t });
    store.add(cfg, "board", { srcPath: file(root, "b.png", "other"), name: "b.png", source: "cli", now: t + 1000 });
    const again = store.add(cfg, "board", { srcPath: file(root, "a2.png"), name: "a2.png", source: "hook", note: "new note", now: t + 2000 });
    expect(again.deduped).toBe(true);
    const items = store.list(cfg, "board");
    expect(items).toHaveLength(2);
    expect(items[0]!.id).toBe(a.item.id);
    expect(items[0]!.note).toBe("new note");
  });

  test("keeps 8 newest and drops items older than 24 h", () => {
    const t0 = Date.now() - 1000;
    const ids = [];
    for (let k = 0; k < 9; k++)
      ids.push(store.add(cfg, "board", { srcPath: file(root, `f${k}.png`, `img${k}`), name: `f${k}.png`, source: "cli", now: t0 + k }).item.id);
    const left = store.list(cfg, "board").map((i) => i.id);
    expect(left).toHaveLength(8);
    expect(left).not.toContain(ids[0]);
    expect(readdirSync(cfg.boardDir).filter((n) => n.startsWith(ids[0]!))).toHaveLength(0);

    store.sweep(cfg, "board", t0 + store.MAX_AGE_MS + 10_000);
    expect(store.list(cfg, "board")).toHaveLength(0);
  });

  test("find only resolves ids and ignores tampered metadata", () => {
    const { item } = store.add(cfg, "board", { srcPath: file(root, "a.png"), name: "a.png", source: "cli" });
    expect(store.find(cfg, item.id)?.item.id).toBe(item.id);
    expect(store.find(cfg, "../../etc/passwd")).toBeNull();
    expect(store.find(cfg, `${item.id}/../x`)).toBeNull();
    const meta = JSON.parse(readFileSync(join(cfg.boardDir, `${item.id}.json`), "utf8"));
    writeFileSync(join(cfg.boardDir, `${item.id}.json`), JSON.stringify({ ...meta, file: "../../../etc/passwd" }));
    expect(store.find(cfg, item.id)).toBeNull();
  });

  test("inbox never drops waiting uploads; it refuses the 9th instead", () => {
    const ids = [];
    for (let k = 0; k < store.MAX_ITEMS; k++) ids.push(store.add(cfg, "inbox", { data: PNG, name: `u${k}.png`, source: "upload" }).item.id);
    expect(() => store.add(cfg, "inbox", { data: PNG, name: "u9.png", source: "upload" })).toThrow(/inbox full/);
    expect(store.list(cfg, "inbox").map((i) => i.id).sort()).toEqual(ids.sort());
    // Once claimed, old uploads make room again.
    store.claim(cfg, ids[0]!, "s");
    store.claim(cfg, ids[1]!, "s");
    store.add(cfg, "inbox", { data: PNG, name: "u10.png", source: "upload" });
    expect(store.list(cfg, "inbox")).toHaveLength(store.MAX_ITEMS);
    expect(store.pending(cfg)).toBe(store.MAX_ITEMS - 1);
  });

  test("expired items are hidden before the sweep runs", () => {
    store.add(cfg, "board", { data: PNG, name: "old.png", source: "cli", now: Date.now() - store.MAX_AGE_MS + 1000 });
    expect(store.list(cfg, "board")).toHaveLength(1);
    expect(store.list(cfg, "board", Date.now() + 2000)).toHaveLength(0);
  });

  test("long names keep their extension", () => {
    const name = "x".repeat(300) + ".png";
    const { item } = store.add(cfg, "board", { data: PNG, name, source: "cli" });
    expect(item.name).toHaveLength(200);
    expect(item.name.endsWith(".png")).toBe(true);
  });

  test("parallel pushes of the same bytes leave one item", async () => {
    const p = file(root, "same.png");
    const env = { ...process.env, PEEK_DIR: cfg.dir, PEEK_CONFIG: join(root, "none") };
    for (let round = 0; round < 3; round++) {
      const procs = Array.from({ length: 10 }, () =>
        Bun.spawn([BUN, join(REPO, "src/cli.ts"), p], { env, stdout: "ignore", stderr: "ignore" }),
      );
      await Promise.all(procs.map((x) => x.exited));
      expect(store.list(cfg, "board")).toHaveLength(1);
    }
  });

  test("claim is exclusive", () => {
    const { item } = store.add(cfg, "inbox", { data: PNG, name: "up.png", source: "upload" });
    expect(store.claim(cfg, item.id, "s1")?.claimedBy).toBe("s1");
    expect(store.claim(cfg, item.id, "s2")).toBeNull();
    expect(store.list(cfg, "inbox")[0]).toMatchObject({ claimedBy: "s1" });
  });
});

describe("hooks", () => {
  let cfg: Config, root: string;
  beforeEach(() => ({ cfg, root } = fresh()));
  const readEv = (fp: string) => JSON.stringify({ session_id: "s", cwd: root, tool_name: "Read", tool_input: { file_path: fp } });

  test("read hook pushes images, once", () => {
    const p = file(root, "shot.png");
    hookRead(readEv(p), cfg);
    hookRead(readEv(p), cfg);
    const items = store.list(cfg, "board");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: "hook", cwd: root });
  });

  test("read hook ignores non-images, missing files, garbage and peek's own dir", () => {
    hookRead(readEv(file(root, "a.ts", "x")), cfg);
    hookRead(readEv(join(root, "missing.png")), cfg);
    hookRead("not json", cfg);
    hookRead("", cfg);
    const { item } = store.add(cfg, "inbox", { data: PNG, name: "up.png", source: "upload" });
    hookRead(readEv(join(cfg.inboxDir, item.file)), cfg);
    expect(store.list(cfg, "board")).toHaveLength(0);
  });

  test("read hook survives a missing peek dir", () => {
    rmSync(cfg.dir, { recursive: true, force: true });
    hookRead(readEv(file(root, "x.png")), cfg);
    expect(store.list(cfg, "board")).toHaveLength(1);
  });

  test("prompt hook injects recent uploads once, to one session", () => {
    const { item } = store.add(cfg, "inbox", { data: PNG, name: "photo.png", source: "upload", note: "the bug" });
    const out = hookPrompt(JSON.stringify({ session_id: "sess-1" }), cfg, Date.now(), ATTENDED);
    const ctx = JSON.parse(out!).hookSpecificOutput;
    expect(ctx.hookEventName).toBe("UserPromptSubmit");
    expect(ctx.additionalContext).toContain(join(cfg.inboxDir, item.file));
    expect(ctx.additionalContext).toContain("the bug");
    expect(hookPrompt(JSON.stringify({ session_id: "sess-2" }), cfg, Date.now(), ATTENDED)).toBeNull();
    expect(store.list(cfg, "inbox")[0]!.claimedBy).toBe("sess-1");
  });

  test("unattended sessions do not claim uploads", () => {
    store.add(cfg, "inbox", { data: PNG, name: "p.png", source: "upload" });
    expect(isUnattended({ CLAUDE_CODE_SESSION_ATTENDED: "0" })).toBe(true);
    expect(isUnattended({ CLAUDE_CODE_ENTRYPOINT: "sdk-cli" })).toBe(true);
    expect(isUnattended({ CLAUDE_CODE_ENTRYPOINT: "sdk-cli", PEEK_CLAIM_UNATTENDED: "1" })).toBe(false);
    expect(isUnattended({})).toBe(false);
    expect(hookPrompt(JSON.stringify({ session_id: "bot" }), cfg, Date.now(), { CLAUDE_CODE_SESSION_ATTENDED: "0" })).toBeNull();
    expect(store.unclaimed(cfg)).toHaveLength(1);
  });

  test("hooks as processes: exit 0, read hook prints nothing", async () => {
    const env = { ...process.env, ...ATTENDED, PEEK_DIR: cfg.dir, PEEK_CONFIG: join(root, "none") };
    const run = async (kind: string, input: string) => {
      const p = Bun.spawn([BUN, join(REPO, "src/cli.ts"), "hook", kind], { env, stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
      return { code: await p.exited, out: await new Response(p.stdout).text(), errOut: await new Response(p.stderr).text() };
    };
    for (const input of ["", "garbage", readEv(file(root, "h.png")), readEv("/nope.png")]) {
      expect(await run("read", input)).toEqual({ code: 0, out: "", errOut: "" });
    }
    expect(await run("prompt", "garbage")).toEqual({ code: 0, out: "", errOut: "" });
    store.add(cfg, "inbox", { data: PNG, name: "q.png", source: "upload" });
    const r = await run("prompt", JSON.stringify({ session_id: "proc" }));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).hookSpecificOutput.additionalContext).toContain(cfg.inboxDir);
  });

  test("prompt hook skips uploads older than 30 minutes", () => {
    const old = Date.now() - store.CLAIM_WINDOW_MS - 60_000;
    store.add(cfg, "inbox", { data: PNG, name: "old.png", source: "upload", now: old });
    expect(hookPrompt(JSON.stringify({ session_id: "s" }), cfg, Date.now(), ATTENDED)).toBeNull();
    expect(store.unclaimed(cfg)).toHaveLength(1); // still there for `peek pull`
  });
});

describe("server", () => {
  const { cfg, root } = fresh();
  const srv = startServer(cfg, { quiet: true });
  const base = `http://127.0.0.1:${srv.server.port}`;
  afterAll(() => srv.stop());

  test("serves the viewer and items", async () => {
    const page = await fetch(base + "/");
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("<title>peek</title>");
    const items = await (await fetch(base + "/api/items")).json();
    expect(items).toEqual({ board: [], inbox: [] });
  });

  test("unknown Host is refused (DNS rebinding) and the page can't be framed", async () => {
    const port = srv.server.port;
    const evil = await fetch(base + "/api/items", { headers: { Host: `evil.example:${port}` } });
    expect(evil.status).toBe(421);
    const fwd = await fetch(base + "/api/items", { headers: { "X-Forwarded-Host": "evil.example" } });
    expect(fwd.status).toBe(421);
    const page = await fetch(base + "/");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  test("path traversal never resolves", async () => {
    for (const p of ["/files/../../etc/passwd", "/files/..%2F..%2Fetc%2Fpasswd", "/files/%2e%2e/%2e%2e/etc/passwd", "/files/x"]) {
      const r = await fetch(base + p);
      expect(r.status).toBe(404);
      expect(await r.text()).not.toContain("root:");
    }
  });

  test("upload lands in the inbox; cross-site writes are refused", async () => {
    const fd = () => {
      const f = new FormData();
      f.append("file", new File([PNG], "phone.png", { type: "image/png" }));
      f.append("note", "from phone");
      return f;
    };
    expect((await fetch(base + "/api/upload", { method: "POST", body: fd() })).status).toBe(403);
    expect((await fetch(base + "/api/upload", { method: "POST", body: fd(), headers: { "X-Peek": "1", Origin: "https://evil.example" } })).status).toBe(403);
    const r = await fetch(base + "/api/upload", { method: "POST", body: fd(), headers: { "X-Peek": "1" } });
    expect(r.status).toBe(201);
    const inbox = store.list(cfg, "inbox");
    expect(inbox[0]).toMatchObject({ name: "phone.png", note: "from phone", source: "upload", claimed: null });

    const bad = new FormData();
    bad.append("file", new File(["hello"], "notes.txt", { type: "text/plain" }));
    expect((await fetch(base + "/api/upload", { method: "POST", body: bad, headers: { "X-Peek": "1" } })).status).toBe(415);
  });

  test("files carry type, sandbox CSP for HTML, and support ranges", async () => {
    const html = store.add(cfg, "board", { data: new TextEncoder().encode("<p>x</p>"), name: "page.html", source: "cli" }).item;
    // A tampered mime in the metadata MUST NOT change how the file is served.
    const metaPath = join(cfg.boardDir, `${html.id}.json`);
    writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(readFileSync(metaPath, "utf8")), mime: "text/html;charset=utf-8" }));
    const r = await fetch(`${base}/files/${html.id}`);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("content-security-policy")).toBe("sandbox allow-scripts");

    const png = store.add(cfg, "board", { data: PNG, name: "p.png", source: "cli" }).item;
    const part = await fetch(`${base}/files/${png.id}`, { headers: { Range: "bytes=0-9" } });
    expect(part.status).toBe(206);
    expect((await part.arrayBuffer()).byteLength).toBe(10);
    expect(part.headers.get("content-range")).toBe(`bytes 0-9/${PNG.byteLength}`);
    for (const r of ["bytes=0-1,3-4", "bytes=5-2", "bytes=abc"]) {
      const full = await fetch(`${base}/files/${png.id}`, { headers: { Range: r } });
      expect(full.status).toBe(200);
      expect((await full.arrayBuffer()).byteLength).toBe(PNG.byteLength);
    }
    expect((await fetch(`${base}/files/${png.id}`, { headers: { Range: "bytes=-0" } })).status).toBe(416);
    expect((await fetch(`${base}/files/${png.id}`, { headers: { Range: `bytes=${PNG.byteLength}-` } })).status).toBe(416);
    const tail = await fetch(`${base}/files/${png.id}`, { headers: { Range: "bytes=-5" } });
    expect(tail.status).toBe(206);
    expect((await tail.arrayBuffer()).byteLength).toBe(5);
  });

  test("SSE announces changes", async () => {
    const ctrl = new AbortController();
    const res = await fetch(base + "/api/events", { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    await reader.read(); // initial event
    setTimeout(() => store.add(cfg, "board", { data: new TextEncoder().encode("sse"), name: "s.svg", source: "cli" }), 50);
    const { value } = await reader.read();
    expect(dec.decode(value)).toContain("event: change");
    ctrl.abort();
  });

  test("a full inbox answers 409 and keeps what is waiting", async () => {
    const { cfg: c3 } = fresh();
    const s3 = startServer(c3, { quiet: true });
    const b3 = `http://127.0.0.1:${s3.server.port}`;
    const up = (n: number) => {
      const f = new FormData();
      for (let k = 0; k < n; k++) f.append("file", new File([PNG], `p${k}.png`, { type: "image/png" }));
      return fetch(b3 + "/api/upload", { method: "POST", body: f, headers: { "X-Peek": "1" } });
    };
    expect((await up(9)).status).toBe(409);
    expect(store.list(c3, "inbox")).toHaveLength(0);
    expect((await up(8)).status).toBe(201);
    const r = await up(1);
    expect(r.status).toBe(409);
    expect((await r.json()).error).toContain("inbox full");
    expect(store.pending(c3)).toBe(8);
    s3.stop();
  });

  test("delete one and clear", async () => {
    const it = store.add(cfg, "board", { data: new TextEncoder().encode("d"), name: "d.gif", source: "cli" }).item;
    expect((await fetch(`${base}/api/items/${it.id}`, { method: "DELETE" })).status).toBe(403);
    expect((await fetch(`${base}/api/items/${it.id}`, { method: "DELETE", headers: { "X-Peek": "1" } })).status).toBe(200);
    expect(store.find(cfg, it.id)).toBeNull();
    await fetch(`${base}/api/items`, { method: "DELETE", headers: { "X-Peek": "1" } });
    expect(store.list(cfg, "board")).toHaveLength(0);
  });

  test("mount prefix is accepted when the proxy keeps it", async () => {
    const { cfg: c2 } = fresh();
    const s2 = startServer({ ...c2, mount: "/peek" }, { quiet: true });
    const b2 = `http://127.0.0.1:${s2.server.port}`;
    expect((await fetch(b2 + "/peek/api/items")).status).toBe(200);
    expect((await fetch(b2 + "/api/items")).status).toBe(200);
    s2.stop();
    void root;
  });
});

describe("config file", () => {
  test("empty values and inline comments", () => {
    const { root } = fresh();
    const p = join(root, "env");
    writeFileSync(p, 'PEEK_PORT="9001" # quoted\nPEEK_DIR=\nPEEK_MOUNT=/peek # c\nPEEK_PUBLIC_URL=\n');
    const c = loadConfig({ PEEK_CONFIG: p });
    expect(c.port).toBe(9001);
    expect(c.dir.endsWith("/.peek")).toBe(true);
    expect(c.mount).toBe("/peek");
    expect(c.publicUrl).toBe("http://127.0.0.1:9001/");
    writeFileSync(p, "PEEK_PORT=nope\nPEEK_DIR=rel/dir\n");
    const d = loadConfig({ PEEK_CONFIG: p });
    expect(d.port).toBe(8790);
    expect(d.dir.startsWith("/")).toBe(true);
  });
});

describe("config edits", () => {
  const existing = {
    hooks: {
      PostToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "other-tool.js" }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "notify" }] }],
    },
  };
  const cmds = { read: '"/b/bun" "/r/src/cli.ts" hook read', prompt: '"/b/bun" "/r/src/cli.ts" hook prompt' };

  test("install merges, twice gives one entry each, uninstall restores", () => {
    const once = installHooks(existing, cmds);
    const twice = installHooks(once, cmds);
    expect(twice).toEqual(once);
    const count = (s: any, ev: string, kind: string) =>
      s.hooks[ev].flatMap((g: any) => g.hooks).filter((h: any) => h.command.endsWith(`hook ${kind}`)).length;
    expect(count(twice, "PostToolUse", "read")).toBe(1);
    expect(count(twice, "UserPromptSubmit", "prompt")).toBe(1);
    expect(twice.hooks!.PostToolUse![0]).toEqual(existing.hooks.PostToolUse[0]!);
    expect(uninstallHooks(twice, [cmds.read, cmds.prompt])).toEqual(existing);
  });

  test("agent line is added once and removed cleanly", () => {
    const line = "To show the user an image, run `peek <file> -n \"x\"`.";
    const once = installLine("# Notes\n", line);
    expect(installLine(once, line)).toBe(once);
    expect(uninstallLine(once)).toBe("# Notes\n");
  });

  test("a custom agent line is idempotent and replaces the old wording", () => {
    const legacy = "# N\n\nTo show the user an image, run `peek <file> -n \"x\"`.\n";
    const custom = "Use the viewer tool for images.";
    const a = installLine(legacy, custom);
    expect(a).not.toContain("run `peek <file>");
    expect(installLine(installLine(a, custom), custom)).toBe(a);
    expect(uninstallLine(a)).toBe("# N\n");
  });

  test("other tools' hooks that look similar are left alone", () => {
    expect(isPeekHook("node ~/tools/other/src/cli.ts hook read", "read")).toBe(false);
    expect(isPeekHook("/usr/bin/my-peek hook read", "read")).toBe(false);
    expect(isPeekHook('"/b/bun" "/x/peek/src/cli.ts" hook read', "read")).toBe(true);
    expect(isPeekHook("peek hook prompt", "prompt")).toBe(true);
  });

  test("writes through a symlinked settings file and keeps its mode", async () => {
    const { root } = fresh();
    const real = join(root, "dotfiles-settings.json");
    const link = join(root, "settings.json");
    writeFileSync(real, JSON.stringify(existing, null, 2) + "\n");
    chmodSync(real, 0o600);
    symlinkSync(real, link);
    const p = Bun.spawn([BUN, join(REPO, "scripts/claude-config.ts"), "hooks", "install", link, cmds.read, cmds.prompt], { stdout: "ignore" });
    expect(await p.exited).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(statSync(real).mode & 0o777).toBe(0o600);
    expect(readFileSync(real, "utf8")).toContain("hook read");
  });
});
