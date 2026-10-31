import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyReplies,
  classifierConfig,
  runProcess,
  subprocessEnvironment,
  type ReplyContext,
} from "../src/reply-classifier.js";

const message = {
  id: "candidate",
  revision: 7,
  sender: "client",
  sender_id: "person",
  sent_at: "2026-01-01T00:00:00Z",
  text: "done",
  reply_to: null,
  attachment: null,
};
const context: ReplyContext = {
  waiting_for: "DNS update",
  original_messages: [{ ...message, id: "original", text: "add both records" }],
  recent_messages: [],
  earlier_relevant_messages: [],
  candidates: [message],
  omitted_context_messages: 0,
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
const data=JSON.parse(input.includes('INPUT DATA:\\n')?input.split('INPUT DATA:\\n').at(-1):input);
writeFileSync(${JSON.stringify(audit)},JSON.stringify({args,cwd:process.cwd(),env:{hasPostbag:!!process.env.POSTBAG_SERVICE_TOKEN,hasThread:!!process.env.CODEX_THREAD_ID,claudeMemory:process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS}}));
const result={results:data.candidates.map(m=>({message_id:m.id,revision:m.revision,label:'relevant',reason:'DNS confirmation'}))};
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
      const result = await classifyReplies(
        classifierConfig.parse({
          runner,
          model: "synthetic-model",
          executable: esm,
        }),
        context,
        AbortSignal.timeout(5000),
      );
      assert.equal(result.results[0]?.message_id, "candidate");
      const record = JSON.parse(await readFile(audit, "utf8"));
      assert.ok(record.cwd.includes("wa-reply-classifier-"));
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
    await writeFile(
      esm,
      `#!${process.execPath}\nconsole.log(JSON.stringify({structured_output:{results:[{message_id:'invented',revision:7,label:'relevant',reason:'wrong'}]}}));`,
      { mode: 0o700 },
    );
    await chmod(esm, 0o700);
    await assert.rejects(
      classifyReplies(
        classifierConfig.parse({
          runner: "claude-code",
          model: "test",
          executable: esm,
        }),
        context,
        AbortSignal.timeout(5000),
      ),
      /invalid candidate identities/,
    );
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

test("Postbag receipts distinguish permanent refusals, transient failures and unknown submissions", async () => {
  const { PostbagNotifier } = await import("../src/reply-notifier.js");
  const dir = await mkdtemp(join(tmpdir(), "wa-notifier-test-"));
  const command = join(dir, "postbag.mjs");
  const destination = {
    bag: "fixture",
    peer: "agent",
    service: "whatsapp",
    service_token: "synthetic-token-not-a-live-grant",
  };
  const notice = {
    watch_id: "watch-fixture",
    notice_id: 1,
    kind: "reply_candidates",
  };
  try {
    for (const [receipt, expected] of [
      [{ ok: true, submission_state: "submitted" }, "submitted"],
      [
        {
          ok: false,
          submission_state: "not_submitted",
          error_code: "service_not_permitted",
        },
        "failed",
      ],
      [
        {
          ok: false,
          submission_state: "not_submitted",
          error_code: "transport_unavailable",
        },
        "unavailable",
      ],
      [{ ok: false, submission_state: "unknown" }, "unknown"],
    ] as const) {
      await writeFile(
        command,
        `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(receipt))});process.exit(${receipt.ok ? 0 : 2});`,
        { mode: 0o700 },
      );
      assert.equal(
        await new PostbagNotifier(command).send(
          destination,
          notice,
          AbortSignal.timeout(5000),
        ),
        expected,
      );
    }
    await writeFile(
      command,
      `#!${process.execPath}\nconsole.log('unexpected traceback');process.exit(1);`,
      { mode: 0o700 },
    );
    assert.equal(
      await new PostbagNotifier(command).send(
        destination,
        notice,
        AbortSignal.timeout(5000),
      ),
      "unknown",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
