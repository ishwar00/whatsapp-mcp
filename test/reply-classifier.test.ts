import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relevantIds, classifierConfig } from "../src/reply-classifier.js";

import { runProcess, subprocessEnvironment } from "../src/process.js";
const context = {
  waiting_for: "DNS update",
  outgoing: "add both records",
  messages: [
    {
      id: "candidate",
      sender_name: "Client",
      sent_at: "2026-01-01T00:00:00Z",
      text: "done",
    },
  ],
};
test("both runner adapters use ephemeral isolated executions, stdin context and validated candidate IDs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wa-classifier-test-"));
  const command = join(dir, "cli"),
    audit = join(dir, "audit.json");
  await writeFile(
    command,
    `#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2), input=readFileSync(0,'utf8');
const data=JSON.parse(input.includes('UNTRUSTED INPUT:\\n')?input.split('UNTRUSTED INPUT:\\n').at(-1):input);
writeFileSync(${JSON.stringify(audit)},JSON.stringify({args,cwd:process.cwd(),env:{hasPostbag:!!process.env.POSTBAG_SERVICE_TOKEN,hasThread:!!process.env.CODEX_THREAD_ID,claudeMemory:process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS}}));
const result={relevant_ids:[...data.messages.map(m=>m.id),'invented']};
if(args[0]==='exec')writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(result));
else console.log(JSON.stringify({structured_output:result}));
`,
    { mode: 0o700 },
  );
  // An extension makes the fixture an ES module without inheriting a package.json.
  const esm = command + ".mjs";
  await writeFile(esm, await readFile(command), { mode: 0o700 });
  try {
    for (const runner of ["claude-code", "codex"] as const) {
      const result = await relevantIds(
        classifierConfig.parse({
          runner,
          model: "synthetic-model",
          executable: esm,
        }),
        context,
        AbortSignal.timeout(5000),
      );
      assert.equal(result[0], "candidate");
      const record = JSON.parse(await readFile(audit, "utf8"));
      assert.ok(record.cwd.includes("wa-relevance-"));
      assert.equal(record.env.hasPostbag, false);
      assert.equal(record.env.hasThread, false);
      if (runner === "claude-code") {
        assert.ok(record.args.includes("--no-session-persistence"));
        assert.equal(record.args[record.args.indexOf("--tools") + 1], "");
        assert.ok(record.args.includes("--strict-mcp-config"));
        assert.equal(record.env.claudeMemory, "1");
      } else {
        assert.ok(record.args.includes("--ephemeral"));
        assert.ok(record.args.includes("--ignore-user-config"));
        assert.ok(record.args.includes("features.shell_tool=false"));
        assert.ok(record.args.includes("features.plugins=false"));
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("subprocess execution is bounded, rejects before launch on cancellation, and strips agent credentials", async () => {
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      signal: AbortSignal.timeout(50),
    }),
    /cancelled|timed out/,
  );
  await assert.rejects(
    runProcess(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(10000))"],
      { signal: AbortSignal.timeout(5000), maxBytes: 100 },
    ),
    /output limit/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(async () =>
    runProcess("/does-not-exist", [], { signal: controller.signal }),
  );
  const env = subprocessEnvironment();
  for (const key of Object.keys(env))
    assert.equal(
      /^(POSTBAG_|WHATSAPP_BRIDGE_|CODEX_THREAD_ID$|CLAUDE_CODE_MESSAGING_)/.test(
        key,
      ),
      false,
    );
});
