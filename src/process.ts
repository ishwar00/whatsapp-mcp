import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
export function executable(name: string, configured?: string) {
  if (configured) return configured;
  for (const dir of [
    ...(process.env.PATH ?? "").split(delimiter),
    join(homedir(), ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]) {
    const path = join(dir, name);
    if (!isAbsolute(path)) continue;
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {}
  }
  throw new Error(`${name} executable not found; configure its absolute path`);
}

export function subprocessEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      /^(CLAUDECODE$|CLAUDE_CODE_|CODEX_THREAD_ID$|CODEX_SESSION_ID$|POSTBAG_|WHATSAPP_BRIDGE_|BRIDGE_OWNER_)/.test(
        key,
      )
    )
      delete env[key];
  return env;
}

export function runProcess(
  command: string,
  args: string[],
  options: {
    input?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal: AbortSignal;
    maxBytes?: number;
    allowFailure?: boolean;
  },
): Promise<string> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? subprocessEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const output: Buffer[] = [];
    let size = 0,
      failed: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== "win32")
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {}
    };
    const stop = (error: Error) => {
      failed ??= error;
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 500);
    };
    const abort = () => stop(new Error("Execution cancelled or timed out"));
    options.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > (options.maxBytes ?? 1_000_000))
        stop(new Error("Execution output limit exceeded"));
      else output.push(chunk);
    });
    // Never log CLI stderr: it can contain prompt content or inherited credentials.
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
    child.on("error", (error) => {
      failed = error;
    });
    child.on("close", (code) => {
      options.signal.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
      if (failed) reject(failed);
      else if (code !== 0 && !options.allowFailure)
        reject(new Error(`Execution failed with exit code ${code}`));
      else resolve(Buffer.concat(output).toString("utf8"));
    });
    if (options.signal.aborted) abort();
  });
}
