#!/bin/bash
# Run inside the test rig: bash /app/testing/cache-view.sh
set -eu
cd /app
bun - <<'TS'
import assert from "node:assert/strict";
import { AskAI } from "./AskAI.ts";
import { CONTROL } from "./testing/fake/server.ts";

const control = "http://127.0.0.1:" + CONTROL;
const salt = String(Date.now());
for (const vendor of ["claude-api", "claude-sub"] as const) {
  for (const talk of [false, true]) {
    for (const [turn, size] of [60, 85, 110, 60, 0].entries()) {
      const prefix = turn < 3 ? "original" : "rewritten";
      const blocks = [
        { text: "<chat>\n", mark: size === 0 },
        ...Array.from({ length: size }, (_, k) => ({
          text: Array.from({ length: 4 }, (_, i) => `${prefix} ${k * 4 + i}|A remembered conversation item.\n`).join(""),
          mark: k === size - 1,
        })),
        { text: "</chat>\n", mark: false },
        { text: "A new message from user: Say ok.", mark: true },
      ];
      const end = await AskAI.ask({ vendor, model: "claude-sonnet-5-5", effort: "low", speed: "slow", system: `Reply ok. ${salt} ${vendor} ${talk}`, searches: 0, server: "", blocks, talk, steer: { pending: () => false, take: async () => [], taken: [{ text: "A message steered into this call.", imgs: [] }] } }, () => {}).done;
      assert.equal(end.ok, true, end.text);
      const { log } = await (await fetch(control + "/last")).json();
      const body = log[0].body;
      const content = body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []);
      const view = content.filter(b => b.type === "text" && /^(original|rewritten) /.test(b.text));
      const marked = view.flatMap((b, k) => b.cache_control ? [k + 1] : []);
      const expected = turn === 1 ? [60, 85] : turn === 2 ? [85, 110] : size === 0 ? [] : [60];
      assert.deepEqual(marked, expected, `${vendor} talk=${talk} turn=${turn}: view breakpoints`);
      const total = (body.system ?? []).filter(b => b.cache_control).length + content.filter(b => b.cache_control).length + Number(Boolean(body.cache_control));
      assert.ok(total <= 4, `${total} marks exceed the API limit`);
      if (size === 0) {
        assert.ok(content.some(b => b.text === "<chat>\n" && b.cache_control), "empty view caches its opening block");
      }
      console.log(`${vendor} talk=${talk} turn=${turn + 1}: marks=${marked}, total=${total}`);
    }
  }
}
TS
