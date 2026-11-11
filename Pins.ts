import type { Block } from "./AskAI.ts";
import type { Out } from "./Agent.ts";
import * as config from "./Config.ts";
import { get, text_of } from "./Json.ts";
import { Memory } from "./Memory.ts";
import { write_whole } from "./Write.ts";

// what the agent learned about the user that must not fade with the
// memory's compression: one line each, the same in every chat and
// subagent, in pins.json in the server's dir. A pin with until is
// temporary; a lasting one leaves when unused for STALE days
export type Pin = {
  id    : number;
  text  : string;
  from  : number | null;
  until : string | null;
  made  : string;
  used  : string;
};

const FILE = config.DIR + "/pins.json";

const CAP = 60;

const STALE = 45;

const LONGEST = 400;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const HEAD = `Pinned: what the user taught you that holds in every chat and subagent, kept
outside the view's compression. Each line is id|pin (#the message it came
from), with until on a temporary one. Follow them as the user's standing
instructions. With the pin tool: mark as used each pin that shaped what you
did this turn (a lasting pin unused ${STALE} days is unpinned); pin a correction,
preference or rule of the user's on how you work in general, never one-time
context (unsure: ask the user once, "pin …?"; "one-time" means no pin); give
until to a pin tied to a goal or a date; replace the pin a new rule changes
instead of adding one; unpin when the user asks. Say each change in your reply,
as "📌 pinned: …" or "📌 unpinned: …". At ${CAP} pins, propose merges or drops to
the user before adding one.`;

const SUB_HEAD = "Pinned: what the user taught the agent you work for, its standing instructions; follow them. Each line is id|pin (#the message it came from), with until on a temporary one.";

function today(now = new Date()): string {
  return now.toLocaleDateString("sv-SE");
}

export function read(): Pin[] {
  try {
    const all = JSON.parse(Memory.file_text(FILE) || "[]") as unknown;
    return Array.isArray(all) ? (all as Pin[]) : [];
  } catch {
    return [];
  }
}

function write(pins: Pin[]): void {
  write_whole(FILE, JSON.stringify(pins, null, 1) + "\n");
}

export function line(pin: Pin): string {
  return pin.id + "|" + pin.text + (pin.from === null ? "" : " (#" + pin.from + ")") + (pin.until === null ? "" : " until " + pin.until);
}

// the block every turn gets after the chat: no used dates in it, so
// marking a pin used leaves the prompt's cache alone
export function block(boss: boolean): Block {
  const pins = read();
  if (!boss && pins.length === 0) {
    return { text: "", mark: false };
  }
  const lines = pins.length === 0 ? "(None yet.)" : pins.map(line).join("\n");
  return { text: (boss ? HEAD : SUB_HEAD) + "\n" + lines + "\n\n", mark: false };
}

// the pins whose time is up: a temporary one past its until, a lasting
// one unused STALE days. Takes them out, and answers them with why
export function sweep(day = today()): { pin: Pin; why: string }[] {
  const pins = read();
  const stale = new Date(Date.parse(day) - STALE * 864e5).toISOString().slice(0, 10);
  const gone = pins.flatMap((pin) => {
    if (pin.until !== null && pin.until < day) {
      return [{ pin, why: "expired " + pin.until }];
    }
    if (pin.until === null && pin.used < stale) {
      return [{ pin, why: "unused " + STALE + "d" }];
    }
    return [];
  });
  if (gone.length > 0) {
    write(pins.filter((pin) => !gone.some((g) => g.pin === pin)));
  }
  return gone;
}

export function unpin(id: number): Pin | null {
  const pins = read();
  const pin = pins.find((p) => p.id === id) ?? null;
  if (pin !== null) {
    write(pins.filter((p) => p !== pin));
  }
  return pin;
}

function ids(args: Record<string, unknown>): number[] {
  const all = get(args, "ids");
  return Array.isArray(all) ? all.map(Number).filter(Number.isInteger) : [];
}

function fields(args: Record<string, unknown>): Pick<Pin, "text" | "from" | "until"> | string {
  const text = text_of(args.text, "").replace(/\s+/g, " ").trim();
  const from = args.from === undefined || args.from === null ? null : Number(args.from);
  const until = args.until === undefined || args.until === null || args.until === "" ? null : text_of(args.until, "");
  if (text === "") {
    return "A pin needs its text.";
  }
  if (Buffer.byteLength(text) > LONGEST) {
    return "A pin is one line of at most " + LONGEST + " bytes: shorten it.";
  }
  if (from !== null && !Number.isInteger(from)) {
    return "from is the id of the message the pin came from.";
  }
  if (until !== null && (!DAY.test(until) || Number.isNaN(Date.parse(until)))) {
    return "until is a date, YYYY-MM-DD.";
  }
  return { text, from, until };
}

export function tool(args: Record<string, unknown>, day = today()): Out {
  const pins = read();
  const action = text_of(args.action, "");
  switch (action) {
    case "add": {
      const f = fields(args);
      if (typeof f === "string") {
        return { text: f, fail: true };
      }
      if (pins.length >= CAP) {
        return { text: "There are " + CAP + " pins, the most kept: propose merges or drops to the user first.", fail: true };
      }
      const pin: Pin = { id: Math.max(0, ...pins.map((p) => p.id)) + 1, ...f, made: day, used: day };
      write([...pins, pin]);
      return { text: "Pinned " + line(pin), fail: false };
    }
    case "replace": {
      const id = Number(args.id);
      const old = pins.find((p) => p.id === id);
      if (old === undefined) {
        return { text: "No pin " + String(args.id) + ".", fail: true };
      }
      const f = fields({ from: old.from, until: old.until, ...args });
      if (typeof f === "string") {
        return { text: f, fail: true };
      }
      const pin: Pin = { ...old, ...f, used: day };
      write(pins.map((p) => (p === old ? pin : p)));
      return { text: "Replaced " + line(old) + "\nwith " + line(pin), fail: false };
    }
    case "unpin": {
      const want = ids(args);
      const gone = pins.filter((p) => want.includes(p.id));
      if (gone.length === 0) {
        return { text: "No pin " + want.join(", ") + ".", fail: true };
      }
      write(pins.filter((p) => !gone.includes(p)));
      return { text: "Unpinned " + gone.map(line).join("\n"), fail: false };
    }
    case "used": {
      const want = ids(args);
      const hit = pins.filter((p) => want.includes(p.id));
      write(pins.map((p) => (hit.includes(p) ? { ...p, used: day } : p)));
      return { text: hit.length === 0 ? "No pin " + want.join(", ") + "." : "Marked used: " + hit.map((p) => p.id).join(", ") + ".", fail: hit.length === 0 };
    }
    default: {
      return { text: "action is add, replace, unpin or used.", fail: true };
    }
  }
}
