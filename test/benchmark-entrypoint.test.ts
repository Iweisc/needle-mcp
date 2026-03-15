import { describe, it, expect } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const benchmarkEntrypoint = join(repoRoot, "benchmark");

function runEntrypoint(args: string[], env: NodeJS.ProcessEnv): Promise<{
  code: number | null;
  error: Error | null;
  stderr: string;
}> {
  return new Promise((resolvePromise) => {
    const child = spawn(benchmarkEntrypoint, args, {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    let error: Error | null = null;

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      error = err;
    });

    child.on("close", (code) => {
      resolvePromise({
        code,
        error,
        stderr,
      });
    });
  });
}

async function writeStub(path: string, name: string): Promise<void> {
  await writeFile(
    path,
    `#!/usr/bin/env bash
printf '${name} %s\n' "$*" >> "$BENCH_LOG"
`,
  );
  await chmod(path, 0o755);
}

describe("benchmark entrypoint", () => {
  it("routes sample mode to the sample benchmark runner", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "needle-benchmark-entrypoint-"));

    try {
      const binDir = join(tempDir, "bin");
      const logPath = join(tempDir, "calls.log");
      await mkdir(binDir, { recursive: true });
      await writeStub(join(binDir, "npm"), "npm");
      await writeStub(join(binDir, "node"), "node");

      const result = await runEntrypoint(["sample", "--output", "tmp/out"], {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        BENCH_LOG: logPath,
      });

      expect(result.error).toBeNull();
      expect(result.code).toBe(0);
      const calls = (await readFile(logPath, "utf8")).trim().split("\n");
      expect(calls).toEqual([
        "npm run build --silent",
        "node dist/benchmark/run.js --sample --output tmp/out",
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("passes live-run flags through when no subcommand is used", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "needle-benchmark-entrypoint-"));

    try {
      const binDir = join(tempDir, "bin");
      const logPath = join(tempDir, "calls.log");
      await mkdir(binDir, { recursive: true });
      await writeStub(join(binDir, "npm"), "npm");
      await writeStub(join(binDir, "node"), "node");

      const result = await runEntrypoint(["--output", "tmp/live"], {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        BENCH_LOG: logPath,
      });

      expect(result.error).toBeNull();
      expect(result.code).toBe(0);
      const calls = (await readFile(logPath, "utf8")).trim().split("\n");
      expect(calls).toEqual([
        "npm run build --silent",
        "node dist/benchmark/run.js --output tmp/live",
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
