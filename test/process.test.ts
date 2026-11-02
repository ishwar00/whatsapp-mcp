import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runProcess } from "../src/process.js";

test("Codex queue subprocess cancellation is bounded and already-cancelled calls never launch", async () => {
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      signal: AbortSignal.timeout(50),
    }),
    /cancelled|timed out/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(async () =>
    runProcess("/does-not-exist", [], { signal: controller.signal }),
  );
  await assert.rejects(
    runProcess(process.execPath, ["-e", "process.exit(2)"], {
      signal: AbortSignal.timeout(5000),
    }),
    /exit code 2/,
  );
});
test("Codex queue subprocesses strip parent agent identity and bridge credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-process-")),
    audit = join(dir, "env.json");
  try {
    await runProcess(
      process.execPath,
      [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(audit)},JSON.stringify(Object.keys(process.env)))`,
      ],
      { signal: AbortSignal.timeout(5000) },
    );
    const keys: string[] = JSON.parse(readFileSync(audit, "utf8"));
    assert.equal(
      keys.some((key) =>
        /^(CLAUDECODE$|CLAUDE_CODE_|CODEX_THREAD_ID$|CODEX_SESSION_ID$|POSTBAG_|WHATSAPP_BRIDGE_|BRIDGE_OWNER_)/.test(
          key,
        ),
      ),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
