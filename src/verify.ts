import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTempDir } from "./util/tmp.js";
import { VERIFY_TIMEOUT } from "./util/limits.js";
import { logger } from "./util/log.js";

const execFileAsync = promisify(execFile);

export interface VerifyResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

export async function verifySnippet(
  packageSpec: string,
  codeSnippet: string,
): Promise<VerifyResult> {
  const { dir, cleanup } = await createTempDir();

  try {
    // Create a minimal package.json
    const pkgJson = {
      name: "needle-verify",
      version: "0.0.0",
      type: "module",
      private: true,
    };
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify(pkgJson, null, 2),
    );

    // Write the test script
    await writeFile(join(dir, "test.mjs"), codeSnippet);

    // Install the package
    logger.info("Verify: installing package", { spec: packageSpec });
    await execFileAsync("npm", ["install", packageSpec], {
      cwd: dir,
      timeout: VERIFY_TIMEOUT,
    });

    // Run the test
    logger.info("Verify: running snippet");
    const { stdout, stderr } = await execFileAsync("node", ["test.mjs"], {
      cwd: dir,
      timeout: VERIFY_TIMEOUT,
    });

    return { success: true, stdout, stderr };
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    logger.warn("Verify: snippet execution failed", {
      error: error.message ?? String(err),
    });
    return {
      success: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? (err instanceof Error ? err.message : String(err)),
    };
  } finally {
    await cleanup();
  }
}
