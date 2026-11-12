// Claude Code hook handlers. Both MUST exit 0. They MUST NOT disturb the session.

import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import type { Config } from "./config";
import * as store from "./store";

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export function isInside(path: string, dir: string): boolean {
  const p = real(path);
  const d = real(dir);
  return p === d || p.startsWith(d.endsWith(sep) ? d : d + sep);
}

/** PostToolUse(Read): put an image the agent read on the board. Silent. */
export function hookRead(input: string, cfg: Config): void {
  try {
    const ev = JSON.parse(input);
    const fp = ev?.tool_input?.file_path;
    if (typeof fp !== "string" || !fp || !store.isImage(fp)) return;
    const cwd = typeof ev.cwd === "string" ? ev.cwd : null;
    const abs = isAbsolute(fp) ? fp : resolve(cwd ?? process.cwd(), fp);
    // Skip peek's own files, so `peek pull` followed by Read does not echo an
    // upload back onto the board.
    if (isInside(abs, cfg.dir)) return;
    const st = statSync(abs);
    if (!st.isFile() || st.size > store.MAX_UPLOAD_BYTES) return;
    store.add(cfg, "board", { srcPath: abs, name: abs, source: "hook", cwd });
  } catch {
    // Never fail the tool call.
  }
}

/** UserPromptSubmit: claim recent uploads and hand their paths to the agent. */
export function hookPrompt(input: string, cfg: Config, now = Date.now()): string | null {
  try {
    let session = "unknown";
    try {
      const ev = JSON.parse(input);
      if (typeof ev?.session_id === "string" && ev.session_id) session = ev.session_id;
    } catch {}

    const claimed: store.Item[] = [];
    for (const item of store.unclaimed(cfg, now, store.CLAIM_WINDOW_MS)) {
      const c = store.claim(cfg, item.id, session, now);
      if (c) claimed.push(c);
    }
    if (!claimed.length) return null;

    const parts = claimed.map((i) => {
      const extra = [i.name !== i.file ? `name: ${JSON.stringify(i.name)}` : "", i.note ? `note: ${JSON.stringify(i.note)}` : ""]
        .filter(Boolean)
        .join(", ");
      return store.pathOf(cfg, "inbox", i) + (extra ? ` (${extra})` : "");
    });
    const context = `The user uploaded files via peek: ${parts.join("; ")}. Read them if they are relevant.`;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } });
  } catch {
    return null;
  }
}
