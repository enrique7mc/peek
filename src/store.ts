// Filesystem-backed store. The directory is the only source of truth: the CLI,
// the hooks and the server all read and write it directly, so each one works
// without the others running.
//
// Layout per directory (board/ or inbox/):
//   <id>.<ext>   the file
//   <id>.json    metadata (written last, so its presence means "complete")
//   <id>.claim   inbox only: created with O_EXCL; whoever creates it owns the claim
//   .tmp-*       in-flight writes, renamed into place

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, extname, join } from "node:path";
import type { Config } from "./config";

export const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  html: "text/html",
  htm: "text/html",
  mp4: "video/mp4",
  mov: "video/quicktime",
};
export const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg"]);

export const MAX_ITEMS = 8;
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CLAIM_WINDOW_MS = 30 * 60 * 1000;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** Cap for `peek <file>`: the file is read into memory to hash it. */
export const MAX_PUSH_BYTES = 200 * 1024 * 1024;
const ORPHAN_GRACE_MS = 5 * 60 * 1000;

export const ID_RE = /^\d{8}T\d{6}-[0-9a-f]{4}$/;
const FILE_RE = /^(\d{8}T\d{6}-[0-9a-f]{4})\.([a-z0-9]{1,5})$/;

export type Kind = "board" | "inbox";
export type Source = "hook" | "cli" | "upload";

export interface Item {
  id: string;
  file: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  note: string | null;
  source: Source;
  cwd: string | null;
  created: string;
  claimed?: string | null;
  claimedBy?: string | null;
}

export class PeekError extends Error {}

export const extOf = (name: string) => extname(name).slice(1).toLowerCase();
export const isSupported = (name: string) => extOf(name) in TYPES;
export const isImage = (name: string) => IMAGE_EXTS.has(extOf(name));
export const supportedList = () => Object.keys(TYPES).join(", ");

export function extForMime(mime: string): string | null {
  const m = mime.split(";")[0]!.trim().toLowerCase();
  for (const [ext, t] of Object.entries(TYPES)) if (t === m) return ext;
  return null;
}

export const dirOf = (cfg: Config, kind: Kind) => (kind === "board" ? cfg.boardDir : cfg.inboxDir);

export function ensureDirs(cfg: Config) {
  mkdirSync(cfg.boardDir, { recursive: true });
  mkdirSync(cfg.inboxDir, { recursive: true });
}

function newId(dir: string, now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  const ts =
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  for (;;) {
    const id = `${ts}-${randomBytes(2).toString("hex")}`;
    if (!existsSync(join(dir, `${id}.json`))) return id;
  }
}

const tmpIn = (dir: string) => join(dir, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);

export function writeAtomic(path: string, data: string | Uint8Array) {
  const tmp = tmpIn(dirname(path));
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

const writeMeta = (dir: string, item: Item) =>
  writeAtomic(join(dir, `${item.id}.json`), JSON.stringify(item, null, 2) + "\n");

function readMeta(path: string): Item | null {
  try {
    const m = JSON.parse(readFileSync(path, "utf8"));
    if (!m || typeof m.id !== "string" || !ID_RE.test(m.id)) return null;
    // The data file name must be derived from the id. This stops a tampered
    // JSON file from pointing the server at an arbitrary path.
    const f = typeof m.file === "string" ? m.file.match(FILE_RE) : null;
    if (!f || f[1] !== m.id) return null;
    return m as Item;
  } catch {
    return null;
  }
}

function readClaim(path: string): { at: string; by: string } | null {
  try {
    const c = JSON.parse(readFileSync(path, "utf8"));
    return { at: String(c.at ?? ""), by: String(c.by ?? "") };
  } catch {
    // The claim file exists but its body is not written yet. It is still claimed.
    return existsSync(path) ? { at: new Date().toISOString(), by: "" } : null;
  }
}

const newestFirst = (a: Item, b: Item) =>
  a.created < b.created ? 1 : a.created > b.created ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;

/** Items newest first, without the ones past MAX_AGE_MS (the next sweep removes those). */
export function list(cfg: Config, kind: Kind, now = Date.now()): Item[] {
  return listAll(cfg, kind).filter((i) => now - Date.parse(i.created) <= MAX_AGE_MS);
}

function listAll(cfg: Config, kind: Kind): Item[] {
  const dir = dirOf(cfg, kind);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const nameSet = new Set(names);
  const items: Item[] = [];
  for (const n of names) {
    if (n.startsWith(".") || !n.endsWith(".json")) continue;
    const m = readMeta(join(dir, n));
    if (!m || `${m.id}.json` !== n || !nameSet.has(m.file)) continue;
    if (kind === "inbox") {
      m.claimed ??= null;
      m.claimedBy ??= null;
      if (!m.claimed && nameSet.has(`${m.id}.claim`)) {
        const c = readClaim(join(dir, `${m.id}.claim`));
        if (c) {
          m.claimed = c.at;
          m.claimedBy = c.by || null;
        }
      }
    }
    items.push(m);
  }
  return items.sort(newestFirst);
}

export function find(cfg: Config, id: string): { kind: Kind; item: Item; path: string } | null {
  if (!ID_RE.test(id)) return null;
  for (const kind of ["board", "inbox"] as Kind[]) {
    const dir = dirOf(cfg, kind);
    const m = readMeta(join(dir, `${id}.json`));
    if (m && m.id === id) {
      const path = join(dir, m.file);
      if (existsSync(path)) return { kind, item: m, path };
    }
  }
  return null;
}

export function sha256(data: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

/** A safe display name of at most 200 chars. Truncation keeps the extension. */
export function cleanName(name: string): string {
  const n = basename(name).replace(/[\u0000-\u001f\u007f]/g, "").trim() || "file";
  if (n.length <= 200) return n;
  const ext = extname(n);
  return ext.length > 1 && ext.length <= 10 ? n.slice(0, 200 - ext.length) + ext : n.slice(0, 200);
}

const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10_000;

/**
 * Run `fn` while holding `<dir>/.lock` (an O_EXCL file). This serializes the
 * read-modify-write steps (dedupe, sweep, delete, claim) across processes.
 * If the lock can't be taken in time, `fn` runs anyway: a rare duplicate is
 * better than a hook that hangs.
 */
export function withLock<T>(dir: string, fn: () => T): T {
  const lock = join(dir, ".lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      held = true;
      break;
    } catch (e: any) {
      if (e?.code !== "EEXIST") break;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          unlinkQuiet(lock);
          continue;
        }
      } catch {
        continue; // the holder released it between our two calls
      }
      if (Date.now() > deadline) break;
      Bun.sleepSync(3);
    }
  }
  try {
    return fn();
  } finally {
    if (held) unlinkQuiet(lock);
  }
}

export interface AddInput {
  name: string;
  source: Source;
  note?: string | null;
  cwd?: string | null;
  /** Either a path to copy from, or the bytes. */
  srcPath?: string;
  data?: Uint8Array;
  now?: number;
}

export function add(cfg: Config, kind: Kind, input: AddInput): { item: Item; deduped: boolean } {
  const name = cleanName(input.name);
  const ext = extOf(name);
  const mime = TYPES[ext];
  if (!mime) throw new PeekError(`unsupported type '${ext ? "." + ext : name}' (supported: ${supportedList()})`);

  ensureDirs(cfg);
  const dir = dirOf(cfg, kind);
  const now = input.now ?? Date.now();
  if (!input.data && statSync(input.srcPath!).size > MAX_PUSH_BYTES)
    throw new PeekError(`larger than ${MAX_PUSH_BYTES / 1024 / 1024} MB`);
  const bytes = input.data ?? readFileSync(input.srcPath!);
  const hash = sha256(bytes);
  const note = input.note?.trim() || null;
  const cwd = input.cwd ?? null;

  return withLock(dir, () => {
    if (kind === "board") {
      const dup = list(cfg, "board", now).find((i) => i.sha256 === hash);
      if (dup) {
        dup.created = new Date(now).toISOString();
        if (note) dup.note = note;
        if (cwd) dup.cwd = cwd;
        writeMeta(dir, dup);
        sweepLocked(cfg, kind, now);
        return { item: dup, deduped: true };
      }
    } else if (pending(cfg, now) >= MAX_ITEMS) {
      throw new PeekError(`inbox full: ${MAX_ITEMS} uploads are waiting. Run \`peek pull\` or delete some.`);
    }
    return { item: insert(cfg, kind, dir, { name, ext, mime, bytes, hash, note, cwd, now, source: input.source }), deduped: false };
  });
}

function insert(
  cfg: Config,
  kind: Kind,
  dir: string,
  a: { name: string; ext: string; mime: string; bytes: Uint8Array; hash: string; note: string | null; cwd: string | null; now: number; source: Source },
): Item {
  const { name, ext, mime, bytes, hash, note, cwd, now } = a;
  const id = newId(dir, now);
  const file = `${id}.${ext}`;
  // Write the bytes we hashed (not a copy of the path) so the stored file
  // matches sha256 and gets a fresh mtime.
  writeAtomic(join(dir, file), bytes);

  const item: Item = {
    id,
    file,
    name,
    mime,
    size: bytes.byteLength,
    sha256: hash,
    note,
    source: a.source,
    cwd,
    created: new Date(now).toISOString(),
  };
  if (kind === "inbox") {
    item.claimed = null;
    item.claimedBy = null;
  }
  writeMeta(dir, item);
  sweepLocked(cfg, kind, now);
  return item;
}

/** Unclaimed inbox items that still count against the inbox limit. */
export function pending(cfg: Config, now = Date.now()): number {
  return list(cfg, "inbox", now).filter((i) => !i.claimed).length;
}

function unlinkQuiet(path: string) {
  try {
    unlinkSync(path);
  } catch {}
}

function removeIn(dir: string, id: string) {
  // Metadata first, so readers stop seeing the item before its file goes.
  unlinkQuiet(join(dir, `${id}.json`));
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {}
  for (const n of names) if (n.startsWith(`${id}.`)) unlinkQuiet(join(dir, n));
}

export function remove(cfg: Config, id: string): boolean {
  const f = find(cfg, id);
  if (!f) return false;
  const dir = dirOf(cfg, f.kind);
  withLock(dir, () => removeIn(dir, id));
  return true;
}

export function clear(cfg: Config, kind: Kind): number {
  const dir = dirOf(cfg, kind);
  return withLock(dir, () => {
    const items = listAll(cfg, kind);
    for (const i of items) removeIn(dir, i.id);
    return items.length;
  });
}

/**
 * Keep the MAX_ITEMS newest items that are younger than MAX_AGE_MS, and remove
 * stray files. In the inbox, unclaimed uploads never lose their place to newer
 * ones: `add` refuses new uploads instead, so nothing is dropped silently.
 */
export function sweep(cfg: Config, kind: Kind, now = Date.now()): number {
  const dir = dirOf(cfg, kind);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}
  return withLock(dir, () => sweepLocked(cfg, kind, now));
}

function sweepLocked(cfg: Config, kind: Kind, now: number): number {
  const dir = dirOf(cfg, kind);
  const items = listAll(cfg, kind);
  const isFresh = (i: Item) => now - Date.parse(i.created) <= MAX_AGE_MS;
  const isWaiting = (i: Item) => kind === "inbox" && !i.claimed;
  // Waiting uploads always keep their place; the other items share what is left.
  let slots = MAX_ITEMS - items.filter((i) => isFresh(i) && isWaiting(i)).length;
  const live = new Set<string>();
  let removed = 0;
  for (const item of items) {
    if (isFresh(item) && (isWaiting(item) || slots-- > 0)) live.add(item.id);
    else {
      removeIn(dir, item.id);
      removed++;
    }
  }

  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {}
  for (const n of names) {
    const id = n.startsWith(".") ? null : n.split(".")[0]!;
    if (id && live.has(id)) continue;
    try {
      if (Date.now() - statSync(join(dir, n)).mtimeMs > ORPHAN_GRACE_MS) unlinkQuiet(join(dir, n));
    } catch {}
  }
  return removed;
}

/**
 * Claim one inbox item for `by`. Creating `<id>.claim` with O_EXCL is the atomic
 * step: exactly one caller wins, even across processes.
 */
export function claim(cfg: Config, id: string, by: string, now = Date.now()): Item | null {
  if (!ID_RE.test(id)) return null;
  const dir = cfg.inboxDir;
  // The lock keeps a sweep or delete from removing the item between our read
  // and our write, so a claimed path always exists when we hand it out.
  return withLock(dir, () => claimLocked(dir, id, by, now));
}

function claimLocked(dir: string, id: string, by: string, now: number): Item | null {
  const meta = readMeta(join(dir, `${id}.json`));
  if (!meta || meta.claimed || !existsSync(join(dir, meta.file))) return null;

  const at = new Date(now).toISOString();
  let fd: number;
  try {
    fd = openSync(join(dir, `${id}.claim`), "wx");
  } catch {
    return null;
  }
  try {
    writeSync(fd, JSON.stringify({ at, by }));
  } finally {
    closeSync(fd);
  }
  meta.claimed = at;
  meta.claimedBy = by;
  writeMeta(dir, meta);
  return meta;
}

/** Unclaimed inbox items, oldest first. `windowMs` limits them by age. */
export function unclaimed(cfg: Config, now = Date.now(), windowMs = Infinity): Item[] {
  return list(cfg, "inbox", now)
    .filter((i) => !i.claimed && now - Date.parse(i.created) <= windowMs)
    .reverse();
}

export const pathOf = (cfg: Config, kind: Kind, item: Item) => join(dirOf(cfg, kind), item.file);
