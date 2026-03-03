import { describe, it, expect, vi } from "vitest";
import { resolveResource } from "../src/resource.js";
import { existsSync } from "node:fs";

describe("resolveResource", () => {
  it("local: validates that the path exists", async () => {
    const result = await resolveResource({ type: "local", spec: "/tmp" });
    expect(result.dir).toBe("/tmp");
    // Cleanup should be a no-op
    await result.cleanup();
  });

  it("local: throws for non-existent path", async () => {
    await expect(
      resolveResource({
        type: "local",
        spec: "/nonexistent-path-abc123",
      }),
    ).rejects.toThrow();
  });

  it("npm: extracts package to temp dir and cleans up", async () => {
    // Use a tiny real package for integration test
    const result = await resolveResource({
      type: "npm",
      spec: "is-number@7.0.0",
    });

    expect(result.dir).toContain("needle-");
    expect(existsSync(result.dir)).toBe(true);

    await result.cleanup();
    expect(existsSync(result.dir)).toBe(false);
  }, 30_000);
});
