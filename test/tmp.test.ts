import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTempDir } from "../src/util/tmp.js";

describe("createTempDir", () => {
  it("returns a path under /tmp/needle-*", async () => {
    const { dir, cleanup } = await createTempDir();
    try {
      const prefix = join(tmpdir(), "needle-");
      expect(dir.startsWith(prefix)).toBe(true);
      expect(existsSync(dir)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("cleanup removes the directory", async () => {
    const { dir, cleanup } = await createTempDir();
    expect(existsSync(dir)).toBe(true);
    await cleanup();
    expect(existsSync(dir)).toBe(false);
  });

  it("cleanup rejects tampered paths", async () => {
    const { dir, cleanup } = await createTempDir();
    // Tamper with the internal state by creating a new object
    const tampered = {
      dir: "/home/should-not-delete",
      cleanup: async () => {
        if (!"/home/should-not-delete".startsWith(join(tmpdir(), "needle-"))) {
          throw new Error(
            "Refusing to remove directory outside safe prefix: /home/should-not-delete",
          );
        }
      },
    };
    await expect(tampered.cleanup()).rejects.toThrow(
      "Refusing to remove directory outside safe prefix",
    );
    // Clean up the real temp dir
    await cleanup();
  });
});
