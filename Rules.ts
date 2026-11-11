// Rules
// =====
// Which tool calls ask the owner first (Gate): a rule names tools by glob
// and, if any, a regular expression their arguments must match. Free of
// the server's modules, so Settings in the browser reads them too.

import { rec } from "./Json.ts";

export type Rule = { what: string; tools: string; args: string };

export const SCRATCH = "<scratch>";

const RULES = 50;
const TEXT  = 2000;

const BROWSER = "*__*browser*, *__*navigate*, *__*click*, *__*fill*, *__*type*, *__*press*, *__*submit*, *__*form*";
const ACTS    = BROWSER + ", !*__*navigate*, !*__*snapshot*, !*__*screenshot*";
const READS   = "!*__get*, !*__*_get*, !*__list*, !*__*_list*, !*__read*, !*__*_read*, !*__search*, !*__*_search*, !*__fetch*, !*__*_fetch*";

export const ASK: Rule[] = [
  { what: "Send a message or email as you", tools: "*__*send*, *__*reply*, *__*forward*, *__*post_message*, !*__*create*draft*, !*__*update*draft*, " + READS, args: "" },
  { what: "Send a message or email as you", tools: ACTS, args: String.raw`(^|\n)\s*(send|send now|reply|reply all|forward)\s*(\n|$)` },
  { what: "Send a message or email as you", tools: "shell", args: String.raw`\b(sendmail|mutt|msmtp|swaks|mailx?\s+-s)\b` },
  { what: "Pay or buy something", tools: "*__pay*, *__*_pay*, *__*payment*, *__*purchase*, *__*checkout*, *__buy*, *__*_buy*, *__order*, *__*_order*, *__*charge*, *__*transfer*, " + READS, args: "" },
  { what: "Pay or buy something", tools: ACTS, args: String.raw`checkout|place (your )?order|buy now|pay now|purchase|payment|card ?number|\bcvc\b|\bcvv\b` },
  { what: "Delete files or data outside the scratch folder", tools: "shell", args: String.raw`\b(rm|rmdir|unlink|shred|trash-put|Remove-Item|del)\b[^;&|\n]*\s["']?(?!<scratch>)(/|~|\.\.|\$HOME|\$env:|[A-Za-z]:[\\/])` },
  { what: "Delete files or data outside the scratch folder", tools: "shell", args: String.raw`\b(cd|pushd|Set-Location)\s+["']?(?!<scratch>)(/|~|\.\.|\$HOME|\$env:|[A-Za-z]:[\\/])[^\n]*\b(rm|rmdir|unlink|shred|Remove-Item|del)\s` },
  { what: "Delete files or data outside the scratch folder", tools: "shell", args: String.raw`\bfind\s+["']?(?!<scratch>)(/|~|\.\.|\$HOME)[^\n]*\s-delete\b|\bgit\s+(clean\s+-\w*f|reset\s+--hard|branch\s+-D|push\s[^\n]*(--force|\s-f\b))|\b(drop\s+(table|database|schema)|truncate\s+table|delete\s+from)\b` },
  { what: "Delete files or data outside the scratch folder", tools: "*__*delete*, *__*remove*, *__*trash*, *__*destroy*, *__*drop*, *__*purge*, *__*erase*, *__*wipe*, " + READS, args: String.raw`(^|\n)(?!<scratch>)` },
  { what: "Log in to a site", tools: "*__*login*, *__*log_in*, *__*signin*, *__*sign_in*, *__*authenticate*", args: "" },
  { what: "Log in to a site", tools: ACTS, args: String.raw`password|passwd|passcode|\b(sign|log)[ _-]?in\b|/auth\b|oauth|\b2fa\b|one[ -]time code|\botp\b` },
  { what: "Log in to a site", tools: "shell", args: String.raw`\b(gh|npm|yarn|pnpm|docker|podman|gcloud|az|aws|firebase|vercel|netlify|heroku|wrangler|flyctl|fly|supabase|doctl)\b[^;&|\n]*\b(login|signin)\b` },
  { what: "Post or publish something", tools: "*__*post*, *__*publish*, *__*tweet*, *__*comment*, *__*share*, *__*release*, *__*deploy*, *__*upload*, " + READS, args: "" },
  { what: "Post or publish something", tools: "shell", args: String.raw`\bgh\s+(pr|issue|release|gist|repo)\s+(create|comment|merge|edit|close|review|delete)\b|\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\b(docker|podman)\s+push\b` },
];

export namespace Rules {

  // the rules config.json gives, or why they can't be read; none given: ASK
  export function read(x: unknown): Rule[] | string {
    if (x === undefined || x === null) {
      return ASK;
    }
    if (!Array.isArray(x) || x.length > RULES) {
      return "Give a list of up to " + RULES + " rules";
    }
    const out: Rule[] = [];
    for (const [k, r] of x.entries()) {
      const [what, tools, args] = rec(r) ? [r.what, r.tools, r.args ?? ""] : [];
      const line = (t: unknown): t is string => typeof t === "string" && t.length <= TEXT && !/[\x00-\x1f\x7f]/.test(t);
      if (!line(what) || what.trim() === "" || !line(tools) || Rules.globs(tools).length === 0 || !line(args)) {
        return "Rule " + (k + 1) + " needs what it is, the tools it's for, and the arguments, if any, on one line each";
      }
      const bad = Rules.bad(args);
      if (bad !== null) {
        return "Rule " + (k + 1) + "'s arguments are no regular expression: " + bad;
      }
      out.push({ what: what.trim(), tools: tools.trim(), args: args.trim() });
    }
    return out;
  }

  export function bad(args: string): string | null {
    try {
      new RegExp(args, "i");
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  export function globs(tools: string): string[] {
    return tools.split(",").map((g) => g.trim()).filter((g) => g !== "" && g !== "!");
  }

  export function glob(pattern: string, name: string): boolean {
    const re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    return new RegExp("^" + re + "$", "i").test(name);
  }

  export function named(tools: string, name: string): boolean {
    const all = Rules.globs(tools);
    const [no, yes] = [all.filter((g) => g.startsWith("!")).map((g) => g.slice(1)), all.filter((g) => !g.startsWith("!"))];
    return yes.some((g) => Rules.glob(g, name)) && !no.some((g) => Rules.glob(g, name));
  }

  // the arguments as a rule's regular expression reads them: each string or
  // number on its own line, the device's scratch dir (also from ~) as
  // <scratch>, but not a dir that only starts like it, nor in a value that
  // climbs out of it with /..
  export function text(args: Record<string, unknown>, scratch: string | null): string {
    const values = (x: unknown): string[] => (Array.isArray(x) ? x.flatMap(values) : rec(x) ? Object.values(x).flatMap(values) : typeof x === "string" ? [x] : typeof x === "number" ? [String(x)] : []);
    const { device: _, ...rest } = args;
    const text = values(rest).join("\n");
    if (scratch === null || scratch === "") {
      return text;
    }
    const dir = scratch.replace(/[\\/]+$/, "");
    const home = dir.replace(/^(\/home\/[^/]+|\/Users\/[^/]+|\/root|[A-Za-z]:\\Users\\[^\\]+)(?=[\\/])/, "~");
    const inside = (d: string) => new RegExp(d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + String.raw`(?=$|\n|[\\/"']|\s*[;&|)]+(\s|$))(?![^\n]*[\\/]\.\.([\\/\s"']|$))`, "g");
    return [...new Set([dir, dir.replace(/\\/g, "/"), home, home.replace(/\\/g, "/")])].reduce((t, d) => t.replace(inside(d), SCRATCH), text);
  }

  export function match(rules: Rule[], tool: string, args: Record<string, unknown>, scratch: string | null): Rule | null {
    const text = Rules.text(args, scratch);
    return rules.find((r) => Rules.named(r.tools, tool) && (r.args === "" || new RegExp(r.args, "i").test(text))) ?? null;
  }

}
