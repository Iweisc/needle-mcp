import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock bedrock before importing agents
vi.mock("../src/bedrock.js", () => ({
  converseWithBedrock: vi.fn(),
  NOVA_MODELS: {
    "nova-premier": "us.amazon.nova-premier-v1:0",
    "nova-lite": "us.amazon.nova-lite-v1:0",
  },
}));

import { expandQueriesWithLite, rerankEvidenceWithLite, identifyGapsWithLite } from "../src/agents.js";
import { converseWithBedrock } from "../src/bedrock.js";
import type { EvidenceHit, DeepReadFile } from "../src/types.js";

const mockConverse = vi.mocked(converseWithBedrock);

function makeHit(overrides: Partial<EvidenceHit> = {}): EvidenceHit {
  return {
    path: "src/index.ts",
    lineNumber: 1,
    text: "export function foo() {}",
    score: 5,
    submatches: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── expandQueriesWithLite ────────────────────────────────────────────────────

describe("expandQueriesWithLite", () => {
  it("parses valid query array from Nova Lite", async () => {
    mockConverse.mockResolvedValueOnce(
      JSON.stringify(["handleRoute", "wildcardPath", "paramExtract"]),
    );

    const result = await expandQueriesWithLite("How does routing work?");
    expect(result).toEqual(["handleRoute", "wildcardPath", "paramExtract"]);
    expect(mockConverse).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("How does routing work?"),
      expect.objectContaining({ model: "nova-lite" }),
    );
  });

  it("returns [] on JSON parse failure", async () => {
    mockConverse.mockResolvedValueOnce("This is not JSON at all");

    const result = await expandQueriesWithLite("test question");
    expect(result).toEqual([]);
  });

  it("returns [] on network error", async () => {
    mockConverse.mockRejectedValueOnce(new Error("Connection timeout"));

    const result = await expandQueriesWithLite("test question");
    expect(result).toEqual([]);
  });

  it("strips markdown fences from response", async () => {
    mockConverse.mockResolvedValueOnce(
      '```json\n["fencedQuery", "anotherOne"]\n```',
    );

    const result = await expandQueriesWithLite("test question");
    expect(result).toEqual(["fencedQuery", "anotherOne"]);
  });

  it("caps output at MAX_EXPANDED_QUERIES (10)", async () => {
    const tooMany = Array.from({ length: 20 }, (_, i) => `query${i}`);
    mockConverse.mockResolvedValueOnce(JSON.stringify(tooMany));

    const result = await expandQueriesWithLite("test question");
    expect(result).toHaveLength(10);
    expect(result[0]).toBe("query0");
    expect(result[9]).toBe("query9");
  });

  it("filters out non-string entries", async () => {
    mockConverse.mockResolvedValueOnce(
      JSON.stringify(["valid", 42, null, "alsoValid", "", true]),
    );

    const result = await expandQueriesWithLite("test question");
    expect(result).toEqual(["valid", "alsoValid"]);
  });

  it("passes symbol hints when surface is provided", async () => {
    mockConverse.mockResolvedValueOnce(JSON.stringify(["expanded"]));

    await expandQueriesWithLite("test", { symbols: ["createRouter", "addRoute"] });
    expect(mockConverse).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("createRouter"),
      expect.any(Object),
    );
  });
});

// ── rerankEvidenceWithLite ───────────────────────────────────────────────────

describe("rerankEvidenceWithLite", () => {
  it("applies relevance scores from Nova Lite", async () => {
    const hits = [
      makeHit({ path: "src/a.ts", score: 5 }),
      makeHit({ path: "src/b.ts", score: 3 }),
    ];

    mockConverse.mockResolvedValueOnce(JSON.stringify([0.8, 0.2]));

    const result = await rerankEvidenceWithLite("test question", hits);
    // score = pathScore + relevanceScore * RELEVANCE_WEIGHT(5)
    expect(result[0].score).toBeCloseTo(5 + 0.8 * 5); // 9
    expect(result[1].score).toBeCloseTo(3 + 0.2 * 5); // 4
  });

  it("preserves original scores on batch failure (neutral 0.5)", async () => {
    const hits = [
      makeHit({ path: "src/a.ts", score: 5 }),
      makeHit({ path: "src/b.ts", score: 3 }),
    ];

    mockConverse.mockRejectedValueOnce(new Error("timeout"));

    const result = await rerankEvidenceWithLite("test question", hits);
    // score = pathScore + 0.5 * 5
    expect(result[0].score).toBeCloseTo(5 + 0.5 * 5); // 7.5
    expect(result[1].score).toBeCloseTo(3 + 0.5 * 5); // 5.5
  });

  it("handles empty input", async () => {
    const result = await rerankEvidenceWithLite("test question", []);
    expect(result).toEqual([]);
    expect(mockConverse).not.toHaveBeenCalled();
  });

  it("batches large sets into groups of 20", async () => {
    const hits = Array.from({ length: 45 }, (_, i) =>
      makeHit({ path: `src/file${i}.ts`, score: 1, lineNumber: i }),
    );

    // 3 batches: 20, 20, 5
    mockConverse
      .mockResolvedValueOnce(JSON.stringify(Array(20).fill(0.7)))
      .mockResolvedValueOnce(JSON.stringify(Array(20).fill(0.5)))
      .mockResolvedValueOnce(JSON.stringify(Array(5).fill(0.3)));

    const result = await rerankEvidenceWithLite("test question", hits);
    expect(result).toHaveLength(45);
    expect(mockConverse).toHaveBeenCalledTimes(3);

    // Check scores from each batch
    expect(result[0].score).toBeCloseTo(1 + 0.7 * 5);   // batch 1
    expect(result[20].score).toBeCloseTo(1 + 0.5 * 5);  // batch 2
    expect(result[40].score).toBeCloseTo(1 + 0.3 * 5);  // batch 3
  });

  it("falls back to 0.5 when response has wrong length", async () => {
    const hits = [
      makeHit({ path: "src/a.ts", score: 5 }),
      makeHit({ path: "src/b.ts", score: 3 }),
      makeHit({ path: "src/c.ts", score: 2 }),
    ];

    // Return only 2 scores for 3 hits
    mockConverse.mockResolvedValueOnce(JSON.stringify([0.9, 0.1]));

    const result = await rerankEvidenceWithLite("test question", hits);
    // Wrong length → all get neutral 0.5
    expect(result[0].score).toBeCloseTo(5 + 0.5 * 5);
    expect(result[1].score).toBeCloseTo(3 + 0.5 * 5);
    expect(result[2].score).toBeCloseTo(2 + 0.5 * 5);
  });

  it("clamps out-of-range scores to [0, 1]", async () => {
    const hits = [
      makeHit({ path: "src/a.ts", score: 5 }),
      makeHit({ path: "src/b.ts", score: 3 }),
    ];

    mockConverse.mockResolvedValueOnce(JSON.stringify([1.5, -0.3]));

    const result = await rerankEvidenceWithLite("test question", hits);
    expect(result[0].score).toBeCloseTo(5 + 1.0 * 5); // clamped to 1.0
    expect(result[1].score).toBeCloseTo(3 + 0.0 * 5); // clamped to 0.0
  });
});

// ── identifyGapsWithLite ─────────────────────────────────────────────────────

function makeDeepRead(overrides: Partial<DeepReadFile> = {}): DeepReadFile {
  return {
    path: "src/index.ts",
    content: "export function foo() {}",
    sizeBytes: 24,
    topScore: 10,
    ...overrides,
  };
}

describe("identifyGapsWithLite", () => {
  it("parses valid gap analysis response", async () => {
    mockConverse.mockResolvedValueOnce(
      JSON.stringify({
        gaps: ["missing error handling"],
        queries: ["handleError", "ErrorBoundary"],
      }),
    );

    const result = await identifyGapsWithLite(
      "How does error handling work?",
      [makeHit()],
      [makeDeepRead()],
    );
    expect(result).toEqual(["handleError", "ErrorBoundary"]);
  });

  it("returns [] on JSON parse failure", async () => {
    mockConverse.mockResolvedValueOnce("not json at all");
    const result = await identifyGapsWithLite("test", [makeHit()], []);
    expect(result).toEqual([]);
  });

  it("returns [] on network error", async () => {
    mockConverse.mockRejectedValueOnce(new Error("timeout"));
    const result = await identifyGapsWithLite("test", [makeHit()], []);
    expect(result).toEqual([]);
  });

  it("caps at GAP_MAX_QUERIES (8)", async () => {
    const tooMany = Array.from({ length: 20 }, (_, i) => `query${i}`);
    mockConverse.mockResolvedValueOnce(
      JSON.stringify({ gaps: [], queries: tooMany }),
    );

    const result = await identifyGapsWithLite("test", [makeHit()], []);
    expect(result).toHaveLength(8);
  });

  it("strips markdown fences", async () => {
    mockConverse.mockResolvedValueOnce(
      '```json\n{"gaps":[],"queries":["fenced"]}\n```',
    );
    const result = await identifyGapsWithLite("test", [makeHit()], []);
    expect(result).toEqual(["fenced"]);
  });

  it("includes evidence file paths in the prompt", async () => {
    mockConverse.mockResolvedValueOnce(JSON.stringify({ gaps: [], queries: [] }));

    await identifyGapsWithLite(
      "test",
      [makeHit({ path: "/repo/src/router.ts" })],
      [makeDeepRead({ path: "src/context.ts" })],
    );

    expect(mockConverse).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("src/context.ts"),
      expect.any(Object),
    );
  });
});
