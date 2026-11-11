import { Database } from "bun:sqlite";
import * as child from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import * as config from "./Config.ts";
import { err_why } from "./Err.ts";
import { gate_turns, smoke } from "./Probe.ts";
import { get, text_of } from "./Json.ts";

type Out = { ok: boolean; out: string; err: string };

type Surface = { tools: string[]; boundary: string; code: string };

type Entry = { version: string; text: string };

class Stop extends Error {}

const UPDATES = process.env.UNII_UPDATES ?? path.join(os.homedir(), ".unii-updates");
const WORK = UPDATES + "/work";
const PREVIOUS = UPDATES + "/previous";
const SNAPSHOTS = UPDATES + "/snapshots";
const LOGS = UPDATES + "/logs";
const KEPT = 5;
const PENDING = UPDATES + "/pending.json";

const REMOTE = "upstream";
const SDK = "@anthropic-ai/claude-agent-sdk";
const REGISTRY = "https://registry.npmjs.org/" + SDK;
const CHANGELOGS = {
  sdk  : "https://raw.githubusercontent.com/anthropics/claude-agent-sdk-typescript/main/CHANGELOG.md",
  code : "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md",
};
const UNITS = ["unii-serve", "unii-device"];
const RIG = "unii-update-rig";
const SHOWN = 25;
const WAIT = 90e3;

const HELP = `unii update check [--all]            what upstream and the Agent SDK have new, and where it touches our changes
unii update apply [upstream] [sdk[=VERSION]] [--dry-run]
                                     merge and/or bump in a worktree, test, then install and restart
unii update apply current            the same for the clone's main as it is, nothing merged
unii update apply --resume           go on after you fixed what it stopped on
unii update rollback                 put the previous binary back and restart
unii update gate [dir]               the cache test alone, on a checkout (default: this clone)
Options: --src DIR (the git clone; remembered), --bin FILE (where unii is installed), --base BRANCH (main)`;

function sh(cmd: string[], cwd?: string, env: Record<string, string> = {}): Out {
  const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env }, stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}

function git(dir: string, ...args: string[]): Out {
  return sh(["git", "-C", dir, ...args]);
}

function lines(text: string): string[] {
  return text.split("\n").filter((l) => l !== "");
}

function cut(text: string, n: number): string {
  return text.length > n ? text.slice(0, n - 1) + "…" : text;
}

function stamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z").replace(/[:]/g, "");
}

function compare(a: string, b: string): number {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  return x.reduce((d, n, k) => d || n - (y[k] ?? 0), 0) || x.length - y.length;
}

function source(flag: string | undefined): string {
  const saved = fs.existsSync(UPDATES + "/src") ? fs.readFileSync(UPDATES + "/src", "utf8").trim() : "";
  const dir = path.resolve(flag ?? process.env.UNII_SRC ?? (saved || process.cwd()));
  const top = git(dir, "rev-parse", "--show-toplevel");
  if (!top.ok || !fs.existsSync(top.out + "/Cli.ts") || !git(top.out, "remote", "get-url", REMOTE).ok) {
    throw new Stop("no uniichat clone with an `" + REMOTE + "` remote at " + dir + ": give it with --src DIR (it is remembered)");
  }
  fs.mkdirSync(UPDATES, { recursive: true, mode: 0o700 });
  fs.writeFileSync(UPDATES + "/src", top.out + "\n");
  return top.out;
}

async function fetched(url: string, accept = "*/*"): Promise<Response> {
  const res = await fetch(url, { headers: { accept }, signal: AbortSignal.timeout(30e3) });
  if (!res.ok) {
    throw new Error(url + ": HTTP " + res.status);
  }
  return res;
}

async function json(url: string): Promise<unknown> {
  return (await fetched(url, "application/vnd.npm.install-v1+json")).json();
}

async function text(url: string): Promise<string> {
  return (await fetched(url)).text();
}

function version_in(src: string, ref: string): string {
  return /VERSION\s*=\s*"([^"]+)"/.exec(git(src, "show", ref + ":Update.ts").out)?.[1] ?? "?";
}

type Part = { lines: string[]; available: boolean; reasons: string[] };

function upstream_lines(src: string, base: string, track: string): Part {
  const ahead = lines(git(src, "log", "--format=%h %s", base + ".." + track).out);
  if (ahead.length === 0) {
    return { lines: ["  nothing new: " + track + " is in " + base + " (Version " + version_in(src, track) + ")"], available: false, reasons: [] };
  }
  const mb = git(src, "merge-base", base, track).out;
  const names = (to: string) => lines(git(src, "diff", "--name-only", mb, to).out);
  const ours = names(base);
  const both = names(track).filter((f) => ours.includes(f));
  const merge = git(src, "merge-tree", "--write-tree", "--name-only", base, track);
  const clash = merge.ok ? [] : lines(merge.out.split("\n\n")[0]).slice(1);
  const subjects = (range: string, file: string) => lines(git(src, "log", "--format=%s", range, "--", file).out).slice(0, 2).map((s) => cut(s, 70));
  const out = [
    "  " + ahead.length + " new commits, Version " + version_in(src, base) + " -> " + version_in(src, track) + ": " + ahead.slice(0, 4).map((l) => cut(l, 90)).join(" | ") + (ahead.length > 4 ? " | …" : ""),
    merge.ok || clash.length > 0 ? (merge.ok ? "  merge: clean" : "  merge: CONFLICTS in " + clash.join(", ")) : "  merge: could not be tried: " + cut(merge.err, 120),
  ];
  if (both.length > 0) {
    out.push("  both sides changed " + both.length + " file" + (both.length === 1 ? "" : "s") + " (ours -> theirs):");
    for (const f of both) {
      out.push("    " + f + (clash.includes(f) ? "  [conflict]" : "") + ": " + subjects(mb + ".." + base, f).join(" / ") + "  ->  " + subjects(mb + ".." + track, f).join(" / "));
    }
  }
  const reasons = [
    ...(clash.length > 0 ? ["upstream's merge conflicts in " + clash.join(", ")] : []),
    ...(!merge.ok && clash.length === 0 ? ["upstream's merge could not be tried"] : []),
    ...(both.length > clash.length ? ["upstream changed " + (both.length - clash.length) + " more file(s) we changed too"] : []),
  ];
  return { lines: out, available: true, reasons };
}

async function surface(version: string): Promise<Surface> {
  const dir = UPDATES + "/sdk/" + version;
  if (!fs.existsSync(dir + "/package/package.json")) {
    const res = await fetch(REGISTRY + "/-/claude-agent-sdk-" + version + ".tgz", { signal: AbortSignal.timeout(120e3) });
    if (!res.ok) {
      throw new Error("the SDK " + version + " tarball: HTTP " + res.status);
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dir + ".tgz", Buffer.from(await res.arrayBuffer()));
    const tar = sh(["tar", "-xzf", dir + ".tgz", "-C", dir]);
    fs.rmSync(dir + ".tgz", { force: true });
    if (!tar.ok) {
      throw new Error("tar: " + tar.err);
    }
  }
  const read = (f: string) => (fs.existsSync(dir + "/package/" + f) ? fs.readFileSync(dir + "/package/" + f, "utf8") : "");
  const types = read("sdk.d.ts") + read("core.d.ts");
  const tools = [...(/BUILTIN_TOOL_NAMES: readonly \[([^\]]*)\]/.exec(types)?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const pkg: unknown = JSON.parse(read("package.json"));
  return { tools, boundary: /"(__[A-Z_]*BOUNDARY__)"/.exec(read("sdk.mjs"))?.[1] ?? "?", code: text_of(get(pkg, "claudeCodeVersion"), "?") };
}

function changes(md: string, lo: string, hi: string): Entry[] {
  let version = "";
  return md.split("\n").flatMap((l): Entry[] => {
    const head = /^## (\d+\.\d+\.\d+)/.exec(l);
    version = head?.[1] ?? version;
    return head === null && l.startsWith("- ") && compare(version, lo) > 0 && compare(version, hi) <= 0 ? [{ version, text: l.slice(2) }] : [];
  });
}

function relied_on(src: string, base: string): Array<[string, RegExp]> {
  const code = git(src, "show", base + ":ClaudeSub.ts").out;
  const words = (names: string[]) => new RegExp("\\b(?:" + names.join("|") + ")\\b");
  const env = [...new Set(code.match(/\b(?:CLAUDE_|ANTHROPIC_|DISABLE_|MCP_|FORCE_)[A-Z0-9_]+\b/g) ?? [])];
  const options = [...new Set([...code.matchAll(/^ {6,8}([a-z]+[A-Z]\w*|[A-Z]\w+) +:/gm)].map((m) => m[1]))];
  const denied = [...code.matchAll(/const (?:MORE|WEB) += \[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"(\w+)"/g)].map((n) => n[1]));
  return [
    ["boundary", /SYSTEM_PROMPT_DYNAMIC_BOUNDARY|dynamic boundary|system prompt/i],
    ["cache", /cache_control|cache control|prompt cach|cache ttl|cache.?creation|cache.?read|cache breakpoint/i],
    ["permissions", /permission ?mode|permissionMode|dontAsk|don't ask|deny rule|disallowedTools|allowedTools|canUseTool/i],
    ["env", words(env)],
    ["options", words(options)],
    ["tools", new RegExp("BUILTIN_TOOL_NAMES|built-in .{0,30}tools?|\\b(?:added|renamed|removed) (?:the )?`?\\w+`? tool\\b|`(?:" + denied.join("|") + ")`", "i")],
  ];
}

async function sdk_lines(src: string, base: string, target: string | undefined, all: boolean): Promise<Part> {
  const pkg: unknown = JSON.parse(git(src, "show", base + ":package.json").out);
  const pinned = text_of(get(get(pkg, "dependencies"), SDK), "?");
  const meta = await json(REGISTRY);
  const latest = text_of(get(get(meta, "dist-tags"), "latest"));
  const to = target ?? latest;
  if (compare(to, pinned) <= 0) {
    return { lines: ["  pinned " + pinned + " is the latest"], available: false, reasons: [] };
  }
  const [from, next] = [await surface(pinned), await surface(to)];
  const behind = Object.keys(get(meta, "versions") ?? {}).filter((v) => compare(v, pinned) > 0 && compare(v, to) <= 0).length;
  const out = ["  pinned " + pinned + " (Claude Code " + from.code + "), " + to + " is " + behind + " releases on (Claude Code " + next.code + ")"];
  const added = next.tools.filter((t) => !from.tools.includes(t));
  const gone = from.tools.filter((t) => !next.tools.includes(t));
  out.push("  built-in tools we deny: " + (added.length + gone.length === 0 ? "same " + next.tools.length : (added.length > 0 ? "new " + added.join(", ") + " (denied from the start: ClaudeSub denies every built-in but WebSearch)" : "") + (gone.length > 0 ? " gone " + gone.join(", ") : "")));
  out.push("  system prompt boundary: " + (from.boundary === next.boundary ? "same" : "CHANGED " + from.boundary + " -> " + next.boundary));
  const [sdk, code] = await Promise.all([text(CHANGELOGS.sdk), text(CHANGELOGS.code)]);
  const watch = relied_on(src, base);
  const all_entries = [...changes(sdk, pinned, to).map((e) => ({ ...e, from: "SDK" })), ...changes(code, from.code, next.code).map((e) => ({ ...e, from: "Claude Code" }))];
  const hits = all_entries.flatMap((e) => {
    const tags = watch.filter(([, re]) => re.test(e.text)).map(([tag]) => tag);
    return tags.length === 0 ? [] : [{ ...e, tags }];
  });
  const is_sharp = (h: { tags: string[] }) => h.tags.includes("env") || h.tags.includes("boundary");
  const sharp = hits.filter(is_sharp);
  hits.sort((x, y) => Number(is_sharp(y)) - Number(is_sharp(x)));
  out.push("  changelog entries on what we rely on: " + hits.length + " of " + all_entries.length + " (" + sharp.length + " on the env vars we set or the system prompt, which the cache test can't see)");
  for (const h of hits.slice(0, all ? hits.length : SHOWN)) {
    out.push("    " + h.from + " " + h.version + " [" + h.tags.join(",") + "] " + cut(h.text, 200));
  }
  if (hits.length > SHOWN && !all) {
    out.push("    … " + (hits.length - SHOWN) + " more: --all");
  }
  out.push("  read the rest: " + CHANGELOGS.sdk.replace("raw.githubusercontent.com", "github.com").replace("/main/", "/blob/main/") + " and " + CHANGELOGS.code.replace("raw.githubusercontent.com", "github.com").replace("/main/", "/blob/main/"));
  const reasons = [
    ...(from.boundary === next.boundary ? [] : ["the SDK's system prompt boundary changed"]),
    ...(gone.length > 0 ? ["the SDK dropped built-in tools: " + gone.join(", ")] : []),
    ...(sharp.length > 0 ? [sharp.length + " SDK changelog entries on the env vars we set or the system prompt"] : []),
  ];
  return { lines: out, available: true, reasons };
}

async function check(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { src: { type: "string" }, base: { type: "string" }, upstream: { type: "string" }, sdk: { type: "string" }, all: { type: "boolean" } } });
  const src = source(values.src);
  const base = values.base ?? "main";
  const track = values.upstream ?? REMOTE + "/main";
  const fetched = git(src, "fetch", "--quiet", REMOTE);
  const up = fetched.ok ? upstream_lines(src, base, track) : { lines: ["  could not fetch " + REMOTE + ": " + cut(fetched.err, 150)], available: false, reasons: ["upstream could not be fetched"] };
  const pre = REMOTE + "/rc";
  const pre_ahead = fetched.ok && git(src, "rev-parse", "--verify", "--quiet", pre).ok ? Number(git(src, "rev-list", "--count", track + ".." + pre).out) : 0;
  if (pre_ahead > 0) {
    up.lines.push("  pre-release: " + pre + " is " + pre_ahead + " commits ahead (Version " + version_in(src, pre) + "); it is not what apply takes, but `unii update check --upstream " + pre + "` shows how it would land");
  }
  const sdk = await sdk_lines(src, base, values.sdk, values.all === true).catch((err: unknown) => ({ lines: ["  could not check the SDK: " + err_why(err)], available: false, reasons: ["the SDK could not be checked"] }));
  const reasons = [...up.reasons, ...sdk.reasons];
  const verdict = reasons.length > 0 ? "NEEDS A LOOK on our side: " + reasons.join("; ") : up.available || sdk.available ? "update available, and nothing in it needs work on our side that these checks can see: `unii update apply --dry-run` tests it, `unii update apply` deploys it" : "up to date";
  console.log("unii update check: " + verdict + "\n\nUpstream (" + track + ")\n" + up.lines.join("\n") + "\n\nAgent SDK\n" + sdk.lines.join("\n"));
  return 0;
}

function snapshot(): string {
  const data = config.DIR;
  const dir = SNAPSHOTS + "/" + stamp();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const skip = (name: string) => name === "claude-sub" || /^claude-/.test(name) || name === "lock" || name === "server.pid" || /^unii\.db/.test(name);
  for (const name of fs.readdirSync(data).filter((n) => !skip(n))) {
    fs.cpSync(path.join(data, name), path.join(dir, name), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  }
  const db = path.join(data, "unii.db");
  if (fs.existsSync(db)) {
    const from = new Database(db, { readonly: true });
    from.run("VACUUM INTO '" + path.join(dir, "unii.db").replace(/'/g, "''") + "'");
    from.close();
    const copy = new Database(path.join(dir, "unii.db"), { readonly: true });
    const check = copy.query("pragma integrity_check").get();
    copy.close();
    if (get(check, "integrity_check") !== "ok") {
      throw new Stop("the backup of unii.db failed its integrity check: " + JSON.stringify(check));
    }
  }
  for (const old of fs.readdirSync(SNAPSHOTS).sort().slice(0, -KEPT)) {
    fs.rmSync(path.join(SNAPSHOTS, old), { recursive: true, force: true });
  }
  return dir;
}

function logged(file: string, title: string, cmd: string[], cwd: string, env: Record<string, string> = {}): void {
  console.log("==> " + title);
  const fd = fs.openSync(file, "a");
  fs.writeSync(fd, "\n$ " + cmd.join(" ") + "\n");
  const p = child.spawnSync(cmd[0], cmd.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  if (p.status !== 0) {
    const tail = fs.readFileSync(file, "utf8").trim().split("\n").slice(-30).join("\n");
    throw new Stop(title + " failed (" + (p.error ? err_why(p.error) : "exit " + p.status) + "); the end of " + file + ":\n" + tail);
  }
}

function engine(): string {
  const bin = Bun.which("podman") ?? Bun.which("docker");
  if (bin === null) {
    throw new Stop("the test rig needs podman or docker");
  }
  return bin;
}

function rig(log: string, work: string): void {
  const docker = engine();
  const stop = () => sh([docker, "rm", "-f", RIG]);
  const context = fs.mkdtempSync(path.join(os.tmpdir(), "unii-rig-"));
  for (const f of ["package.json", "bun.lock"]) {
    fs.copyFileSync(path.join(work, f), path.join(context, f));
  }
  try {
    logged(log, "test rig: build the image", [docker, "build", "-t", RIG, "-f", "testing/Containerfile", context], work);
  } finally {
    fs.rmSync(context, { recursive: true, force: true });
  }
  stop();
  try {
    logged(log, "test rig: start", [docker, "run", "-d", "--name", RIG, "--network", "none", "-v", work + ":/src:ro,z", RIG], work);
    for (const end = Date.now() + 240e3; !sh([docker, "logs", RIG]).out.concat(sh([docker, "logs", RIG]).err).includes("rig up"); Bun.sleepSync(1000)) {
      if (Date.now() > end || sh([docker, "inspect", "-f", "{{.State.Running}}", RIG]).out !== "true") {
        throw new Stop("the test rig did not come up: " + sh([docker, "logs", RIG]).err.split("\n").slice(-15).join("\n"));
      }
    }
    for (const f of fs.readdirSync(work + "/testing").filter((n) => n.endsWith(".sh") && n !== "start.sh").sort()) {
      logged(log, "test rig: " + f, [docker, "exec", RIG, "bash", "/app/testing/" + f], work);
    }
  } finally {
    stop();
  }
}

function gate(dir: string, src: () => string): number {
  const d = path.resolve(dir);
  if (!fs.existsSync(d + "/AskAI.ts") || !fs.existsSync(d + "/node_modules")) {
    throw new Stop(d + " is no uniichat checkout with its dependencies installed (bun install)");
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "unii-gate-"));
  try {
    const env = { ...process.env, UNII_DIR: tmp, UNII_CLAUDE_SUB: config.CLAUDE_SUB, UNII_CLAUDE: "", UNII_GATE: d };
    const compiled = /^(\/\$bunfs|B:\\~BUN)/.test(Bun.main);
    const bun = compiled ? Bun.which("bun") : process.execPath;
    if (bun === null) {
      throw new Stop("the cache gate imports the candidate's code: it needs bun");
    }
    const cli = compiled ? src() + "/Cli.ts" : Bun.main;
    if (!fs.existsSync(path.dirname(cli) + "/Probe.ts")) {
      throw new Stop(path.dirname(cli) + " has no Probe.ts: merge the update tooling into the clone first");
    }
    return child.spawnSync(bun, [cli, "update", "gate"], { env, stdio: "inherit", timeout: 600e3 }).status ?? 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function units_of(bin: string): string[] {
  if (process.platform !== "linux" || Bun.which("systemctl") === null) {
    return [];
  }
  return UNITS.filter((u) => /\bpath=(.+?) ; argv/.exec(sh(["systemctl", "--user", "show", "-p", "ExecStart", u]).out)?.[1] === bin);
}

function local_site(): string {
  const port = /\bargv\[\]=\S+ serve (\d+)/.exec(sh(["systemctl", "--user", "show", "-p", "ExecStart", "unii-serve"]).out)?.[1] ?? "8788";
  return "http://127.0.0.1:" + port;
}

async function serving(): Promise<string> {
  const site = local_site();
  const end = Date.now() + WAIT;
  for (;;) {
    const page = await fetch(site, { signal: AbortSignal.timeout(5e3) }).then((r) => r.text()).catch(() => "");
    const build = /data-build="([^"]+)"/.exec(page)?.[1];
    if (build !== undefined) {
      return build;
    }
    if (Date.now() > end) {
      throw new Stop("the server at " + site + " did not answer in " + WAIT / 1000 + " s");
    }
    await Bun.sleep(1000);
  }
}

async function restart(units: string[]): Promise<void> {
  for (const u of units) {
    console.log("==> restart " + u);
    const r = sh(["systemctl", "--user", "restart", u]);
    if (!r.ok) {
      throw new Stop("systemctl restart " + u + ": " + r.err);
    }
    if (u === "unii-serve") {
      await serving();
    }
  }
  await Bun.sleep(8e3);
  for (const u of units) {
    const state = sh(["systemctl", "--user", "is-active", u]).out;
    if (state !== "active") {
      throw new Stop(u + " is " + state + " after the restart: `journalctl --user -u " + u + " -n 30`");
    }
  }
}

function install(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to + ".new");
  fs.chmodSync(to + ".new", 0o755);
  fs.renameSync(to + ".new", to);
}

function keep_previous(bin: string, snap: string, commit: string): void {
  fs.mkdirSync(PREVIOUS, { recursive: true, mode: 0o700 });
  const now = UPDATES + "/current.json";
  if (fs.existsSync(bin)) {
    const kept = PREVIOUS + "/unii";
    fs.rmSync(kept + ".new", { force: true });
    try {
      fs.linkSync(bin, kept + ".new");
    } catch {
      fs.copyFileSync(bin, kept + ".new");
    }
    fs.renameSync(kept + ".new", kept);
    fs.writeFileSync(PREVIOUS + "/info.json", JSON.stringify({ ...(fs.existsSync(now) ? (JSON.parse(fs.readFileSync(now, "utf8")) as object) : {}), snapshot: snap }));
  }
  fs.writeFileSync(now, JSON.stringify({ commit, at: new Date().toISOString() }));
}

function bin_path(flag: string | undefined): string {
  return path.resolve(flag ?? process.env.UNII_INSTALL ?? path.join(os.homedir(), ".local/bin/unii"));
}

async function rollback(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { bin: { type: "string" } } });
  const bin = bin_path(values.bin);
  if (!fs.existsSync(PREVIOUS + "/unii")) {
    throw new Stop("no previous binary kept yet (" + PREVIOUS + "/unii): nothing was deployed with `unii update apply`");
  }
  const info = fs.existsSync(PREVIOUS + "/info.json") ? (JSON.parse(fs.readFileSync(PREVIOUS + "/info.json", "utf8")) as Record<string, unknown>) : {};
  install(PREVIOUS + "/unii", bin);
  fs.writeFileSync(UPDATES + "/current.json", JSON.stringify({ commit: info.commit, at: info.at }));
  console.log("put back " + bin + " from " + PREVIOUS + "/unii" + (info.commit === undefined ? "" : " (commit " + text_of(info.commit).slice(0, 9) + ", deployed " + text_of(info.at) + ")"));
  const units = units_of(bin);
  await restart(units);
  if (units.length === 0) {
    console.log("no systemd service runs " + bin + ": restart yours");
  }
  console.log("data: a snapshot from before the update is in " + text_of(info.snapshot, SNAPSHOTS) + " (unii.db is a consistent backup); the rollback leaves ~/.unii as it is");
  return 0;
}

async function bump_sdk(log: string, word: string): Promise<string> {
  const meta = await json(REGISTRY);
  const explicit = word.includes("=");
  const to = explicit ? word.split("=")[1] : text_of(get(get(meta, "dist-tags"), "latest"));
  const pinned = text_of(get(get(JSON.parse(fs.readFileSync(WORK + "/package.json", "utf8")), "dependencies"), SDK));
  if (explicit ? compare(to, pinned) === 0 : compare(to, pinned) <= 0) {
    return "";
  }
  logged(log, "bump the Agent SDK " + pinned + " -> " + to, ["bun", "add", "--exact", SDK + "@" + to], WORK);
  git(WORK, "add", "package.json", "bun.lock");
  git(WORK, "commit", "-m", "Update the Agent SDK to " + to);
  return "SDK " + pinned + " -> " + to + "; ";
}

function unfinished(): boolean {
  return fs.existsSync(WORK) && (git(WORK, "status", "--porcelain", "--untracked-files=no").out !== "" || git(WORK, "rev-parse", "-q", "--verify", "MERGE_HEAD").ok);
}

async function apply(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { src: { type: "string" }, bin: { type: "string" }, base: { type: "string" }, "dry-run": { type: "boolean" }, resume: { type: "boolean" }, discard: { type: "boolean" } } });
  const src = source(values.src);
  const base = values.base ?? "main";
  const bin = bin_path(values.bin);
  const resumed = values.resume === true;
  const asked: { wants: string[] } = resumed && fs.existsSync(PENDING) ? (JSON.parse(fs.readFileSync(PENDING, "utf8")) as { wants: string[] }) : { wants: positionals.length === 0 ? ["upstream", "sdk"] : positionals };
  const sdk_word = asked.wants.find((w) => w === "sdk" || w.startsWith("sdk="));
  if (asked.wants.some((w) => w !== "upstream" && w !== "current" && w !== sdk_word)) {
    throw new Stop("apply takes upstream, sdk[=VERSION] or current, not " + asked.wants.join(" "));
  }
  if (!resumed && unfinished() && values.discard !== true) {
    throw new Stop("an earlier attempt waits in " + WORK + " with unfinished work: `unii update apply --resume` goes on with it, --discard drops it");
  }
  fs.mkdirSync(LOGS, { recursive: true, mode: 0o700 });
  const log = LOGS + "/" + stamp() + ".log";
  for (const old of fs.readdirSync(LOGS).sort().slice(0, -KEPT)) {
    fs.rmSync(path.join(LOGS, old), { force: true });
  }
  console.log("log: " + log);
  const units = units_of(bin);
  if (values.bin === undefined && units.length === 0 && values["dry-run"] !== true && process.platform === "linux") {
    throw new Stop("no systemd user service runs " + bin + " (unii serve -d, unii device -d), so nothing could be restarted onto the new build: nothing was changed. --bin FILE installs somewhere else.");
  }

  console.log("==> snapshot ~/.unii (claude-sub, the plan's sign-in, left out)");
  const snap = snapshot();
  console.log("    " + snap);

  const track = REMOTE + "/main";
  let note = "";
  if (resumed) {
    if (!fs.existsSync(WORK)) {
      throw new Stop("nothing to resume: no " + WORK);
    }
    if (git(WORK, "rev-parse", "-q", "--verify", "MERGE_HEAD").ok) {
      if (git(WORK, "diff", "--name-only", "--diff-filter=U").out !== "") {
        throw new Stop("conflicts are still open in " + WORK + ": " + lines(git(WORK, "diff", "--name-only", "--diff-filter=U").out).join(", "));
      }
      const done = git(WORK, "commit", "--no-edit");
      if (!done.ok) {
        throw new Stop("could not commit the merge in " + WORK + ": " + done.err);
      }
      note += "merged " + track + "; ";
    }
    if (git(WORK, "status", "--porcelain", "--untracked-files=no").out !== "") {
      throw new Stop(WORK + " has uncommitted changes: commit them, or discard them, then --resume");
    }
  } else {
    const fetched = git(src, "fetch", "--quiet", REMOTE);
    if (!fetched.ok) {
      throw new Stop("could not fetch " + REMOTE + ": " + fetched.err);
    }
    if (fs.existsSync(WORK)) {
      const earlier = git(WORK, "rev-parse", "--abbrev-ref", "HEAD").out;
      console.log("    removing the earlier attempt in " + WORK + (earlier.startsWith("update/") ? " (its branch " + earlier + " stays unless it is in " + base + ")" : ""));
      git(src, "worktree", "remove", "--force", WORK);
      fs.rmSync(WORK, { recursive: true, force: true });
      git(src, "worktree", "prune");
      git(src, "branch", "-d", earlier);
    }
    fs.writeFileSync(PENDING, JSON.stringify(asked));
    const made = git(src, "worktree", "add", "-b", "update/" + stamp(), WORK, base);
    if (!made.ok) {
      throw new Stop("git worktree add: " + made.err);
    }
    if (asked.wants.includes("upstream") && Number(git(WORK, "rev-list", "--count", "HEAD.." + track).out) > 0) {
      console.log("==> merge " + track);
      const merged = git(WORK, "merge", "--no-edit", track);
      if (!merged.ok) {
        const files = lines(git(WORK, "diff", "--name-only", "--diff-filter=U").out);
        throw new Stop("merging " + track + " conflicts in " + (files.join(", ") || "?") + ".\nNothing was deployed. Resolve them in " + WORK + " (git add, no commit needed), then `unii update apply --resume`" + (sdk_word === undefined ? "" : ": the SDK bump follows") + ".\n" + (files.length === 0 ? merged.err : ""));
      }
      note += "merged " + track + "; ";
    }
  }
  if (sdk_word !== undefined) {
    note += await bump_sdk(log, sdk_word);
  }
  if (!resumed && note === "" && !asked.wants.includes("current")) {
    git(src, "worktree", "remove", "--force", WORK);
    console.log("nothing to update (`unii update apply current` rebuilds and deploys " + base + " as it is)");
    return 0;
  }
  const commit = git(WORK, "rev-parse", "HEAD").out;

  logged(log, "bun install", ["bun", "install", "--frozen-lockfile"], WORK);
  logged(log, "bun run check", ["bun", "run", "check"], WORK);
  rig(log, WORK);
  logged(log, "bun run build", ["bun", "run", "build"], WORK);
  console.log("==> cache gate (real claude-sub turns on the plan, in no chat)");
  const gated = gate(WORK, () => src);
  if (gated !== 0) {
    throw new Stop("the cache gate failed: nothing was deployed. The candidate is in " + WORK + " (commit " + commit.slice(0, 9) + ").");
  }
  if (values["dry-run"] === true) {
    console.log("dry run: all passed, nothing deployed. Candidate: " + WORK + " (commit " + commit.slice(0, 9) + ")");
    return 0;
  }

  const was = fs.existsSync(bin);
  keep_previous(bin, snap, commit);
  install(WORK + "/unii", bin);
  console.log("==> installed " + bin + " (commit " + commit.slice(0, 9) + ")");
  try {
    await restart(units);
    console.log("==> smoke: a real turn on a scratch server of the installed binary");
    await smoke(bin);
  } catch (err) {
    console.error("unii update: the deployed build failed: " + err_why(err));
    if (was) {
      console.error("rolling back");
      await rollback(["--bin", bin]).catch((e: unknown) => console.error("rollback failed: " + err_why(e) + "\nby hand: cp " + PREVIOUS + "/unii " + bin + " && systemctl --user restart unii-serve unii-device"));
    }
    return 1;
  }
  const main = git(src, "rev-parse", "--abbrev-ref", "HEAD").out === base && git(src, "status", "--porcelain", "--untracked-files=no").out === "";
  const merged = main && commit !== git(src, "rev-parse", base).out ? git(src, "merge", "--ff-only", commit).ok : commit === git(src, "rev-parse", base).out;
  console.log("deployed " + (note || base + " as it is; ") + "commit " + commit.slice(0, 9) + ". " + (merged ? base + " has it." : "Merge it into " + base + ": git merge --ff-only " + commit.slice(0, 9)));
  console.log("Back out: `unii update rollback` (if unii won't start: " + PREVIOUS + "/unii update rollback). Data snapshot: " + snap);
  return 0;
}

export async function update(args: string[]): Promise<number> {
  const [sub = "check", ...rest] = args;
  try {
    switch (sub) {
      case "check":
        return await check(rest);
      case "apply":
        return await apply(rest);
      case "rollback":
        return await rollback(rest);
      case "gate":
        return process.env.UNII_GATE === undefined ? gate(rest[0] ?? source(undefined), () => source(undefined)) : await gate_turns(process.env.UNII_GATE);
      default:
        console.log(HELP);
        return sub === "help" || sub === "--help" ? 0 : 2;
    }
  } catch (err) {
    console.error("unii update: " + (err instanceof Stop ? err.message : err_why(err)));
    return 1;
  }
}
