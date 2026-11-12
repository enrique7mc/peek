import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFor, type Config } from "../src/config";
import { hookPrompt, hookRead } from "../src/hooks";
import { startServer } from "../src/server";
import * as store from "../src/store";
import { installHooks, installLine, uninstallHooks, uninstallLine } from "../scripts/claude-config";

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
    const a = store.add(cfg, "board", { srcPath: file(root, "a.png"), name: "a.png", source: "hook", now: 1_000_000 });
    store.add(cfg, "board", { srcPath: file(root, "b.png", "other"), name: "b.png", source: "cli", now: 2_000_000 });
    const again = store.add(cfg, "board", { srcPath: file(root, "a2.png"), name: "a2.png", source: "hook", note: "new note", now: 3_000_000 });
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
    const out = hookPrompt(JSON.stringify({ session_id: "sess-1" }), cfg);
    const ctx = JSON.parse(out!).hookSpecificOutput;
    expect(ctx.hookEventName).toBe("UserPromptSubmit");
    expect(ctx.additionalContext).toContain(join(cfg.inboxDir, item.file));
    expect(ctx.additionalContext).toContain("the bug");
    expect(hookPrompt(JSON.stringify({ session_id: "sess-2" }), cfg)).toBeNull();
    expect(store.list(cfg, "inbox")[0]!.claimedBy).toBe("sess-1");
  });

  test("prompt hook skips uploads older than 30 minutes", () => {
    const old = Date.now() - store.CLAIM_WINDOW_MS - 60_000;
    store.add(cfg, "inbox", { data: PNG, name: "old.png", source: "upload", now: old });
    expect(hookPrompt(JSON.stringify({ session_id: "s" }), cfg)).toBeNull();
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
    const r = await fetch(`${base}/files/${html.id}`);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("content-security-policy")).toBe("sandbox allow-scripts");

    const png = store.add(cfg, "board", { data: PNG, name: "p.png", source: "cli" }).item;
    const part = await fetch(`${base}/files/${png.id}`, { headers: { Range: "bytes=0-9" } });
    expect(part.status).toBe(206);
    expect((await part.arrayBuffer()).byteLength).toBe(10);
    expect(part.headers.get("content-range")).toBe(`bytes 0-9/${PNG.byteLength}`);
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
    expect(uninstallHooks(twice)).toEqual(existing);
  });

  test("agent line is added once and removed cleanly", () => {
    const line = "To show the user an image, run `peek <file> -n \"x\"`.";
    const once = installLine("# Notes\n", line);
    expect(installLine(once, line)).toBe(once);
    expect(uninstallLine(once).trim()).toBe("# Notes");
  });
});
