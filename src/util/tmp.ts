import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SAFE_PREFIX = join(tmpdir(), "needle-");

export interface TempDir {
  dir: string;
  cleanup: () => Promise<void>;
}

export async function createTempDir(): Promise<TempDir> {
  const dir = await mkdtemp(SAFE_PREFIX);

  const cleanup = async () => {
    if (!dir.startsWith(SAFE_PREFIX)) {
      throw new Error(
        `Refusing to remove directory outside safe prefix: ${dir}`,
      );
    }
    await rm(dir, { recursive: true, force: true });
  };

  return { dir, cleanup };
}
