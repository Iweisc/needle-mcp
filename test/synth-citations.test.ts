import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeepReadFile } from "../src/types.js";

vi.mock("../src/bedrock.js", () => ({
  converseWithBedrock: vi.fn(),
  NOVA_MODELS: {
    "nova-premier": "us.amazon.nova-premier-v1:0",
    "nova-lite": "us.amazon.nova-lite-v1:0",
  },
}));

import { synthesizeAnswer } from "../src/synth.js";
import { converseWithBedrock } from "../src/bedrock.js";

const mockConverse = vi.mocked(converseWithBedrock);

beforeEach(() => {
  vi.clearAllMocks();
});

async function makeTempResource(
  relPath: string,
  content: string,
): Promise<{
  dir: string;
  deepReads: DeepReadFile[];
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "needle-synth-citations-"));
  const abs = join(dir, relPath);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content);

  return {
    dir,
    deepReads: [
      {
        path: relPath.replace(/\\/g, "/"),
        content,
        sizeBytes: Buffer.byteLength(content),
        topScore: 10,
      },
    ],
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("synthesizeAnswer citation validation", () => {
  it("fails synthesis when all citations are invalid", async () => {
    const resource = await makeTempResource(
      "src/index.js",
      "export const x = 1;\n",
    );

    try {
      const invalidCitationResponse = JSON.stringify({
        answer: "Here is an answer with invalid citations.",
        code: "",
        confidence: 0.9,
        citations: [
          { file: "src/index.js", lines: "50-60", snippet: "out of range" },
          { file: "src/missing.js", lines: "1-2", snippet: "missing file" },
        ],
        nextQueries: [],
        notes: "",
      });

      mockConverse.mockResolvedValue(invalidCitationResponse);

      const result = await synthesizeAnswer(
        "test question",
        [],
        [],
        resource.deepReads,
        resource.dir,
      );

      expect(result.confidence).toBe(0);
      expect(result.citations).toEqual([]);
      expect(result.answer).toContain("Synthesis failed");
      expect(result.notes).toContain("Citation validation failed");
      expect(mockConverse).toHaveBeenCalledTimes(3);
    } finally {
      await resource.cleanup();
    }
  });

  it("keeps valid citations and downgrades confidence when some are invalid", async () => {
    const resource = await makeTempResource(
      "src/index.js",
      "line1\nline2\nline3\n",
    );

    try {
      mockConverse.mockResolvedValueOnce(
        JSON.stringify({
          answer: "Mixed citations.",
          code: "",
          confidence: 0.92,
          citations: [
            { file: "src/index.js", lines: "2-3", snippet: "valid range" },
            { file: "src/index.js", lines: "9-12", snippet: "bad range" },
          ],
          nextQueries: [],
          notes: "",
        }),
      );

      const result = await synthesizeAnswer(
        "test question",
        [],
        [],
        resource.deepReads,
        resource.dir,
      );

      expect(result.confidence).toBe(0.35);
      expect(result.citations).toHaveLength(1);
      expect(result.citations[0]).toMatchObject({
        file: "src/index.js",
        lines: "2-3",
      });
      expect(result.notes).toContain("Citation validation downgraded confidence");
      expect(mockConverse).toHaveBeenCalledTimes(1);
    } finally {
      await resource.cleanup();
    }
  });
});
