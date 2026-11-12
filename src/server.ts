import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "./config";
import * as store from "./store";

const VIEWER = join(import.meta.dir, "viewer.html");
const enc = new TextEncoder();

const PAGE_CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self'",
  "frame-src 'self'",
  "object-src 'self'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
const fail = (status: number, error: string) => json({ error }, status);

/**
 * Requests MUST name a host we serve: loopback, or the host of PEEK_PUBLIC_URL.
 * This blocks DNS rebinding, where a hostile page points its own name at
 * 127.0.0.1 and then reads or writes as "same-origin".
 */
export function allowedHosts(cfg: Config, port: number): Set<string> {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  try {
    const u = new URL(cfg.publicUrl);
    hosts.add(u.host);
    hosts.add(u.hostname); // a proxy may drop the default port
  } catch {}
  return hosts;
}

function hostOk(req: Request, allowed: Set<string>): boolean {
  const host = req.headers.get("host");
  const fwd = req.headers.get("x-forwarded-host");
  return !!host && allowed.has(host.toLowerCase()) && (!fwd || allowed.has(fwd.toLowerCase()));
}

/**
 * Writes MUST come from our own page. The custom header forces a CORS preflight
 * for cross-origin requests (which we never approve). Otherwise any web page
 * in the user's browser could POST files into the inbox, and from there into
 * an agent's context.
 */
function sameOriginWrite(req: Request): boolean {
  if (req.headers.get("x-peek") !== "1") return false;
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      const fwd = req.headers.get("x-forwarded-host");
      const host = req.headers.get("host");
      const o = new URL(origin).host;
      if (o !== host && o !== fwd) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function serveFile(req: Request, cfg: Config, id: string, download: boolean): Response {
  const found = store.find(cfg, id);
  if (!found) return fail(404, "not found");
  const { item, path } = found;
  const file = Bun.file(path);
  const size = file.size;

  // Trust the extension, not the metadata: a tampered .json MUST NOT be able
  // to turn a file into unsandboxed HTML.
  const mime = store.TYPES[store.extOf(item.file)] ?? "application/octet-stream";
  let type = mime;
  if (type === "text/html") type += "; charset=utf-8";
  const headers: Record<string, string> = {
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=3600",
    "Accept-Ranges": "bytes",
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(item.name)}`,
    "Referrer-Policy": "no-referrer",
  };
  // Agent-made HTML runs in an opaque origin: scripts yes, our cookies/DOM no.
  if (mime === "text/html") headers["Content-Security-Policy"] = "sandbox allow-scripts";
  // SVG opened directly (outside <img>) MUST NOT run script either.
  if (mime === "image/svg+xml")
    headers["Content-Security-Policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";

  // Single ranges only. Anything we don't understand (multi-range, malformed,
  // reversed) is ignored and the full body is sent, as RFC 9110 allows.
  const m = (req.headers.get("range") ?? "").trim().match(/^bytes=(\d*)-(\d*)$/);
  if (m && (m[1] || m[2]) && !(m[1] && m[2] && Number(m[1]) > Number(m[2]))) {
    let start: number, end: number;
    if (!m[1]) {
      start = Math.max(0, size - Number(m[2]));
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    }
    if (start >= size || (!m[1] && Number(m[2]) === 0)) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    headers["Content-Length"] = String(end - start + 1);
    return new Response(req.method === "HEAD" ? null : file.slice(start, end + 1), { status: 206, headers });
  }
  headers["Content-Length"] = String(size);
  return new Response(req.method === "HEAD" ? null : file, { headers });
}

async function upload(req: Request, cfg: Config): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, "expected multipart/form-data");
  }
  const note = String(form.get("note") ?? "").trim().slice(0, 500) || null;
  const files = form.getAll("file").filter((f): f is File => typeof f !== "string");
  if (!files.length) return fail(400, "no file in field 'file'");

  // Validate everything before writing anything.
  const named: { file: File; name: string }[] = [];
  for (const f of files) {
    let name = store.cleanName(f.name || "upload");
    if (!store.isSupported(name)) {
      const ext = store.extForMime(f.type || "");
      if (!ext) return fail(415, `${name}: unsupported type (supported: ${store.supportedList()})`);
      name = `${name}.${ext}`;
    }
    if (f.size > store.MAX_UPLOAD_BYTES) return fail(413, `${name}: larger than 50 MB`);
    named.push({ file: f, name });
  }
  const waiting = store.pending(cfg);
  if (waiting + named.length > store.MAX_ITEMS)
    return fail(409, `inbox full: ${waiting} upload(s) waiting, limit ${store.MAX_ITEMS}. Run \`peek pull\` or delete some.`);
  const items: store.Item[] = [];
  for (const { file, name } of named) {
    const data = new Uint8Array(await file.arrayBuffer());
    try {
      items.push(store.add(cfg, "inbox", { data, name, note, source: "upload" }).item);
    } catch (e) {
      if (e instanceof store.PeekError) return fail(409, e.message);
      throw e;
    }
  }
  return json({ items }, 201);
}

export function startServer(cfg: Config = loadConfig(), opts: { quiet?: boolean } = {}) {
  store.ensureDirs(cfg);
  const log = opts.quiet ? () => {} : (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

  // --- change feed -------------------------------------------------------
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const send = (chunk: string) => {
    const bytes = enc.encode(chunk);
    for (const c of clients) {
      try {
        c.enqueue(bytes);
      } catch {
        clients.delete(c);
      }
    }
  };
  let pending: ReturnType<typeof setTimeout> | null = null;
  const changed = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      send(`event: change\ndata: {}\n\n`);
    }, 100);
  };

  let watchers: FSWatcher[] = [];
  const rewatch = () => {
    for (const w of watchers) w.close();
    watchers = [];
    store.ensureDirs(cfg);
    for (const dir of [cfg.boardDir, cfg.inboxDir]) {
      try {
        const w = watch(dir, changed);
        w.on("error", () => setTimeout(rewatch, 1000));
        watchers.push(w);
      } catch (e) {
        log("watch failed", dir, e);
      }
    }
  };
  rewatch();

  const sweepAll = () => {
    try {
      const n = store.sweep(cfg, "board") + store.sweep(cfg, "inbox");
      if (n) log(`sweep removed ${n} item(s)`);
    } catch (e) {
      log("sweep failed", e);
    }
  };
  sweepAll();
  const hourly = setInterval(() => {
    sweepAll();
    rewatch(); // recover if ~/.peek was deleted and recreated
  }, 60 * 60 * 1000);
  const heartbeat = setInterval(() => send(`: hb\n\n`), 25 * 1000);

  // --- http --------------------------------------------------------------
  let hosts: Set<string> | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: cfg.port,
    idleTimeout: 60,
    maxRequestBodySize: store.MAX_UPLOAD_BYTES + 1024 * 1024,
    async fetch(req, srv) {
      if (!hostOk(req, hosts ??= allowedHosts(cfg, srv.port))) return fail(421, "unknown host");
      const url = new URL(req.url);
      let path = url.pathname;
      // Accept requests whether or not the proxy strips the mount prefix.
      if (cfg.mount && (path === cfg.mount || path.startsWith(cfg.mount + "/"))) path = path.slice(cfg.mount.length) || "/";
      const method = req.method;

      try {
        if ((method === "GET" || method === "HEAD") && (path === "/" || path === "/index.html")) {
          return new Response(Bun.file(VIEWER), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
              "Content-Security-Policy": PAGE_CSP,
              "X-Frame-Options": "DENY",
              "X-Content-Type-Options": "nosniff",
              "Referrer-Policy": "no-referrer",
            },
          });
        }

        if (method === "GET" && path === "/api/items") {
          return json({ board: store.list(cfg, "board"), inbox: store.list(cfg, "inbox") });
        }

        if (method === "GET" && path === "/api/events") {
          srv.timeout(req, 0);
          let ctrl!: ReadableStreamDefaultController<Uint8Array>;
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              ctrl = c;
              clients.add(c);
              c.enqueue(enc.encode(`retry: 2000\nevent: change\ndata: {}\n\n`));
            },
            cancel() {
              clients.delete(ctrl);
            },
          });
          req.signal.addEventListener("abort", () => clients.delete(ctrl));
          return new Response(stream, {
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
          });
        }

        const fm = path.match(/^\/files\/([^/]+)$/);
        if ((method === "GET" || method === "HEAD") && fm) {
          return serveFile(req, cfg, fm[1]!, url.searchParams.has("download"));
        }
        if (path.startsWith("/files/")) return fail(404, "not found");

        if (method === "POST" && path === "/api/upload") {
          if (!sameOriginWrite(req)) return fail(403, "forbidden");
          const res = await upload(req, cfg);
          if (res.status === 201) log("upload", req.headers.get("content-length") ?? "?", "bytes");
          return res;
        }

        if (method === "DELETE" && path === "/api/items") {
          if (!sameOriginWrite(req)) return fail(403, "forbidden");
          return json({ removed: store.clear(cfg, "board") });
        }
        const dm = path.match(/^\/api\/items\/([^/]+)$/);
        if (method === "DELETE" && dm) {
          if (!sameOriginWrite(req)) return fail(403, "forbidden");
          return store.remove(cfg, dm[1]!) ? json({ removed: 1 }) : fail(404, "not found");
        }

        return fail(404, "not found");
      } catch (e) {
        log("error", method, path, e);
        return fail(500, "internal error");
      }
    },
  });

  log(`peek listening on http://127.0.0.1:${server.port} (dir ${cfg.dir}, mount ${cfg.mount || "/"})`);

  return {
    server,
    stop() {
      clearInterval(hourly);
      clearInterval(heartbeat);
      if (pending) clearTimeout(pending);
      for (const w of watchers) w.close();
      for (const c of clients) {
        try {
          c.close();
        } catch {}
      }
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const s = startServer();
  // Close the fs watchers before exiting. Exiting with live watchers makes
  // some Bun versions abort with SIGTRAP and leave a crash report.
  for (const sig of ["SIGTERM", "SIGINT"] as const)
    process.on(sig, () => {
      s.stop();
      process.exit(0);
    });
}
