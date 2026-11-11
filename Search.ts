import { Database } from "bun:sqlite";
import { setImmediate } from "node:timers/promises";
import { Memory } from "./Memory.ts";

type Hit = { id: number; date: string; kind: string; text: string };
type Options = { since?: string; until?: string; limit?: number; after?: number };

export namespace Search {

  export async function find(mem: Memory, query: string, opts: Options, signal: AbortSignal): Promise<{ hits: Hit[]; more: boolean }> {
    if (query.trim() === "" || query.length > 500) {
      throw new Error("Give a word or phrase of 1 to 500 characters.");
    }
    const day = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
    if ((opts.since !== undefined && !day(opts.since)) || (opts.until !== undefined && !day(opts.until)) || (opts.since !== undefined && opts.until !== undefined && opts.since > opts.until)) {
      throw new Error("Use valid YYYY-MM-DD dates, since no later than until.");
    }
    const limit = opts.limit ?? 20;
    const after = opts.after ?? -1;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(after) || after < -1) {
      throw new Error("limit must be 1 to 100; after must be a message id (or -1).");
    }
    const db = new Database(mem.dir + "/search.sqlite", { create: true });
    try {
      db.run("CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(text, original UNINDEXED, date UNINDEXED, kind UNINDEXED, tokenize='trigram')");
      const last = () => (db.query("SELECT coalesce(max(rowid), -1) AS id FROM messages").get() as { id: number }).id;
      const insert = db.query("INSERT INTO messages(rowid, text, original, date, kind) VALUES (?, ?, ?, ?, ?)");
      const end = mem.count;
      while (last() + 1 < end) {
        signal.throwIfAborted();
        db.transaction(() => {
          const start = last() + 1;
          for (let i = start; i < Math.min(start + 256, end); i++) {
            const root = Memory.at(mem, i);
            insert.run(i, root.text.toLowerCase(), root.text, root.date, root.kind);
          }
        })();
        await setImmediate();
      }
      signal.throwIfAborted();
      const want = query.toLowerCase();
      const indexed = Array.from(want).length >= 3;
      const match = indexed ? 'messages MATCH ? AND ' : '';
      const sql = "SELECT rowid AS id, date, kind, original AS text FROM messages WHERE " + match + "rowid > ? AND rowid < ? AND substr(date, 1, 10) >= ? AND substr(date, 1, 10) <= ? AND instr(text, ?) > 0 ORDER BY rowid LIMIT ?";
      const params = [after, end, opts.since ?? "", opts.until ?? "9999-12-31", want, limit + 1];
      const rows = db.query(sql).all(...(indexed ? ['"' + want.replaceAll('"', '""') + '"', ...params] : params)) as Hit[];
      const hits = rows.slice(0, limit).map((row) => {
        const at = row.text.toLowerCase().indexOf(want);
        const start = Math.max(0, at - 60);
        return { ...row, text: (start > 0 ? "…" : "") + row.text.slice(start, start + 240).replace(/\s+/g, " ") + (row.text.length > start + 240 ? "…" : "") };
      });
      return { hits, more: rows.length > limit };
    } finally {
      db.close();
    }
  }

}
