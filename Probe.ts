import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as config from "./Config.ts";
import { err_why } from "./Err.ts";

type Ask = { vendor: string; model: string; effort: string; speed: string; system: string; searches: number; server: string; blocks: Array<{ text: string; mark: boolean }> };

type Asked = { done: Promise<{ ok: boolean; text: string }> };

type Used = { read: number; write: number; input: number };

const MODEL = "claude-haiku-5-5";

const SIZES = [40, 65, 90];

const REUSE = 0.8;

const LEAST = 5000;

const CACHE_LINE = /^cache claude-sub \S+ \S+: read (\d+)(?:, write (\d+))?, uncached (\d+)/;

const SUM = "What is 1234 + 4321? Reply with just the number.";

const UP = 60e3;

const ANSWER = 180e3;

// Each turn adds more than the API's 20-block lookback to the view; AskAI marks the previous turn's end too, as the server's calls do
function blocks(salt: string, size: number): Ask["blocks"] {
  const line = (i: number) => `#${i} [${salt}] the user and the agent discussed item ${i}: a plan step, some file paths, a decision about topic ${(i * 7919) % 1000}, and what to do next.\n`;
  const view = Array.from({ length: size }, (_, k) => ({ text: [0, 1, 2, 3].map((i) => line(k * 4 + i)).join(""), mark: k === size - 1 }));
  return [{ text: "<chat>\n", mark: false }, ...view, { text: "</chat>\n", mark: false }, { text: "A new message from user: Say ok.", mark: true }];
}

function total(u: Used): number {
  return u.read + u.write + u.input;
}

export async function gate_turns(dir: string): Promise<number> {
  const salt = Date.now().toString(36);
  const system = `You are a cache test (${salt}). Reply with the single word ok.\n` + "Rules: be brief. ".repeat(200);
  const { AskAI } = (await import(path.join(dir, "AskAI.ts"))) as { AskAI: { ask: (ask: Ask, on: () => void) => Asked } };
  const { ClaudeSub } = (await import(path.join(dir, "ClaudeSub.ts"))) as { ClaudeSub: { installed: () => string; find: () => Promise<string>; bin: () => Promise<string> } };
  const used: Used[] = [];
  let lines: Used[] = [];
  const log = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    const m = CACHE_LINE.exec(args.map(String).join(" "));
    if (m === null) {
      log(...args);
    } else {
      lines.push({ read: Number(m[1]), write: Number(m[2] ?? 0), input: Number(m[3]) });
    }
  };
  try {
    const bundled = ClaudeSub.installed();
    ClaudeSub.find = () => Promise.resolve(bundled);
    if ((await ClaudeSub.bin()) !== bundled) {
      throw new Error("the candidate would run " + (await ClaudeSub.bin()) + ", not its bundled " + bundled);
    }
    console.log("Claude Code " + Bun.spawnSync([bundled, "--version"]).stdout.toString().trim() + " at " + bundled);
    for (const size of SIZES) {
      lines = [];
      const end = await AskAI.ask({ vendor: "claude-sub", model: MODEL, effort: "low", speed: "slow", system, searches: 0, server: "", blocks: blocks(salt, size) }, () => {}).done;
      if (!end.ok) {
        throw new Error("a claude-sub turn failed: " + end.text);
      }
      if (lines.length === 0) {
        throw new Error("a claude-sub turn reported no cache numbers");
      }
      used.push(lines[0]);
    }
  } catch (err) {
    console.error = log;
    console.log("cache gate: " + err_why(err));
    return 1;
  }
  console.error = log;
  const rows = used.map((u, k) => {
    const before = k === 0 ? null : total(used[k - 1]);
    const ok = before === null ? total(u) >= LEAST : u.read >= REUSE * before;
    const why = before === null ? (ok ? "" : "  too small to cache: the test sent " + total(u) + " tokens, needs " + LEAST) : "  reads " + Math.round((100 * u.read) / before) + "% of the turn before" + (ok ? "" : ", needs " + REUSE * 100 + "%");
    return { ok, text: "turn " + (k + 1) + ": read " + u.read + ", write " + u.write + ", uncached " + u.input + why };
  });
  console.log(rows.map((r) => r.text).join("\n"));
  const fine = rows.every((r) => r.ok);
  console.log(fine ? "cache gate: pass" : "cache gate: FAIL, a turn doesn't read the view the turn before cached");
  return fine ? 0 : 1;
}

async function free_port(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port ?? 0;
  await server.stop(true);
  return port;
}

async function until<T>(what: string, ms: number, probe: () => Promise<T | null>): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(500)) {
    const got = await probe().catch(() => null);
    if (got !== null) {
      return got;
    }
  }
  throw new Error("no " + what + " in " + ms / 1000 + " s");
}

export async function smoke(bin: string): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "unii-smoke-"));
  const site = "http://127.0.0.1:" + (await free_port());
  const pick = "claude-sub:haiku-5.5:low:slow";
  const env = { ...process.env, UNII_DIR: tmp, UNII_SERVICE: "serve", UNII_SITE: site, UNII_VENDORS: "claude-sub", UNII_PICK: pick, UNII_COMPACTOR: pick, UNII_CLAUDE_SUB: config.CLAUDE_SUB, UNII_CLAUDE: "" };
  const server = Bun.spawn([bin, "serve", site.replace(/.*:/, "")], { env, stdout: Bun.file(tmp + "/out.log"), stderr: Bun.file(tmp + "/out.log") });
  try {
    await until("server", UP, async () => ((await fetch(site)).ok ? true : null));
    const link = Bun.spawnSync([bin, "serve", "link"], { env }).stdout.toString();
    const ticket = /auth\?t=(\S+)/.exec(link)?.[1];
    if (ticket === undefined) {
      throw new Error("no sign-in link: " + link);
    }
    const auth = await fetch(site + "/auth", { method: "POST", body: new URLSearchParams({ t: ticket }), redirect: "manual" });
    const cookie = (auth.headers.get("set-cookie") ?? "").split(";")[0];
    const say = await fetch(site + "/api/act?$=say&id=" + crypto.randomUUID() + "&sizes=", { method: "POST", headers: { cookie }, body: SUM });
    if (!say.ok) {
      throw new Error("the say was refused: " + (await say.text()));
    }
    await until("answer", ANSWER, async () => ((await (await fetch(site + "/export", { headers: { cookie } })).text()).includes("5555") ? true : null));
  } catch (err) {
    const log = fs.existsSync(tmp + "/out.log") ? fs.readFileSync(tmp + "/out.log", "utf8").trim().split("\n").slice(-15).join("\n") : "";
    throw new Error(err_why(err) + (log === "" ? "" : "\n" + log));
  } finally {
    server.kill();
    await server.exited;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
