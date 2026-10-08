/**
 * npm run eval                         -> scripted model (sanity check of the harness itself)
 * ANTHROPIC_API_KEY=sk-... npm run eval -> the real model: this is the number that matters
 *
 * Exit code 1 if any scenario fails, so it can gate CI or a prompt change.
 */
import { anthropicLlm, scriptedLlm } from "../core/llm";
import { runEval } from "../core/eval";

const key = process.env.ANTHROPIC_API_KEY;
const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";
const rows = await runEval(key ? anthropicLlm(key, { model }) : scriptedLlm());

console.log(`\nModel: ${key ? model : "scripted (no ANTHROPIC_API_KEY set)"}\n`);
for (const r of rows) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id.padEnd(16)} ${r.tools.join(" → ")}`);
  for (const f of r.failures) console.log(`        - ${f}`);
}
const passed = rows.filter((r) => r.pass).length;
const tokens = rows.reduce((n, r) => ({ i: n.i + r.inputTokens, o: n.o + r.outputTokens }), { i: 0, o: 0 });
console.log(`\n${passed}/${rows.length} passed` + (key ? ` · ${tokens.i} input / ${tokens.o} output tokens` : ""));
process.exit(passed === rows.length ? 0 : 1);
