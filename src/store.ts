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

export function list(cfg: Config, kind: Kind): Item[] {
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

export function cleanName(name: string): string {
  const n = basename(name).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (n || "file").slice(0, 200);
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
  const bytes = input.data ?? readFileSync(input.srcPath!);
  const hash = sha256(bytes);
  const note = input.note?.trim() || null;
  const cwd = input.cwd ?? null;

  if (kind === "board") {
    const dup = list(cfg, "board").find((i) => i.sha256 === hash);
    if (dup) {
      dup.created = new Date(now).toISOString();
      if (note) dup.note = note;
      if (cwd) dup.cwd = cwd;
      writeMeta(dir, dup);
      sweep(cfg, kind, now);
      return { item: dup, deduped: true };
    }
  }

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
    source: input.source,
    cwd,
    created: new Date(now).toISOString(),
  };
  if (kind === "inbox") {
    item.claimed = null;
    item.claimedBy = null;
  }
  writeMeta(dir, item);
  sweep(cfg, kind, now);
  return { item, deduped: false };
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
  removeIn(dirOf(cfg, f.kind), id);
  return true;
}

export function clear(cfg: Config, kind: Kind): number {
  const items = list(cfg, kind);
  for (const i of items) removeIn(dirOf(cfg, kind), i.id);
  return items.length;
}

/** Keep the MAX_ITEMS newest items that are younger than MAX_AGE_MS. Remove stray files. */
export function sweep(cfg: Config, kind: Kind, now = Date.now()): number {
  const dir = dirOf(cfg, kind);
  const items = list(cfg, kind);
  let removed = 0;
  items.forEach((item, idx) => {
    const age = now - Date.parse(item.created);
    if (idx >= MAX_ITEMS || !(age <= MAX_AGE_MS)) {
      removeIn(dir, item.id);
      removed++;
    }
  });

  const live = new Set(items.slice(0, MAX_ITEMS).map((i) => i.id));
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {}
  for (const n of names) {
    const id = n.startsWith(".") ? null : n.split(".")[0]!;
    if (id && live.has(id)) continue;
    try {
      if (now - statSync(join(dir, n)).mtimeMs > ORPHAN_GRACE_MS) unlinkQuiet(join(dir, n));
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
  const meta = readMeta(join(dir, `${id}.json`));
  if (!meta || meta.claimed) return null;

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
  return list(cfg, "inbox")
    .filter((i) => !i.claimed && now - Date.parse(i.created) <= windowMs)
    .reverse();
}

export const pathOf = (cfg: Config, kind: Kind, item: Item) => join(dirOf(cfg, kind), item.file);
