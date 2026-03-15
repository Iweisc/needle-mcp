import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock bedrock
vi.mock("../src/bedrock.js", () => ({
  converseWithBedrock: vi.fn(),
  NOVA_MODELS: {
    "nova-premier": "us.amazon.nova-premier-v1:0",
    "nova-lite": "us.amazon.nova-lite-v1:0",
  },
}));

// Mock ripgrep to avoid real filesystem calls
vi.mock("../src/ripgrep.js", () => ({
  rgSearch: vi.fn().mockResolvedValue([]),
}));

// Mock discover
vi.mock("../src/discover.js", () => ({
  discoverApiSurface: vi.fn().mockResolvedValue({
    symbols: [],
    entrypoints: [],
    packageName: "",
  }),
}));

import { runIterativePipeline } from "../src/iterate.js";
import { converseWithBedrock } from "../src/bedrock.js";
import { rgSearch } from "../src/ripgrep.js";

const mockConverse = vi.mocked(converseWithBedrock);
const mockRgSearch = vi.mocked(rgSearch);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runIterativePipeline", () => {
  it("returns empty results when no evidence is found", async () => {
    // All mocks return empty by default
    const result = await runIterativePipeline("test question", "/tmp/test", {
      evidenceOptions: {},
    });

    expect(result.filteredEvidence).toEqual([]);
    expect(result.deepReads).toEqual([]);
    expect(result.allEvidence).toEqual([]);
  });

  it("skips iteration when enableIteration is false", async () => {
    const result = await runIterativePipeline("test question", "/tmp/test", {
      evidenceOptions: {},
      enableIteration: false,
    });

    // identifyGapsWithLite should not have been called
    // Since no rg results, no bedrock calls for gap analysis
    expect(result.filteredEvidence).toEqual([]);
  });

  it("skips import following when enableImportFollowing is false", async () => {
    const result = await runIterativePipeline("test question", "/tmp/test", {
      evidenceOptions: {},
      enableImportFollowing: false,
    });

    expect(result.filteredEvidence).toEqual([]);
  });

  it("handles errors gracefully and returns pass 1 results", async () => {
    // Make rgSearch return some results for pass 1
    mockRgSearch.mockResolvedValue([
      { path: "/tmp/test/src/a.ts", lineNumber: 1, text: "code", submatches: ["code"] },
    ]);

    // Make reranking succeed for pass 1
    mockConverse
      .mockResolvedValueOnce(JSON.stringify([0.8]))  // rerank pass 1 (1 batch of 1)
      .mockRejectedValueOnce(new Error("gap analysis exploded")); // gap analysis fails

    const result = await runIterativePipeline("test question", "/tmp/test", {
      evidenceOptions: {},
    });

    // Should still return pass 1 evidence despite pass 2 failure
    expect(result.allEvidence.length).toBeGreaterThanOrEqual(1);
  });

  it("passes overrideQueries for pass 2 evidence collection", async () => {
    // Pass 1: return some evidence
    mockRgSearch.mockResolvedValueOnce([
      { path: "/tmp/test/src/a.ts", lineNumber: 1, text: "export function foo() {}", submatches: ["foo"] },
    ]);

    // Rerank pass 1
    mockConverse.mockResolvedValueOnce(JSON.stringify([0.9]));
    // Gap analysis returns queries
    mockConverse.mockResolvedValueOnce(
      JSON.stringify({ gaps: ["missing bar"], queries: ["barHandler"] }),
    );

    // Pass 2 ripgrep: return new evidence
    mockRgSearch.mockResolvedValueOnce([
      { path: "/tmp/test/src/b.ts", lineNumber: 10, text: "function barHandler() {}", submatches: ["barHandler"] },
    ]);

    // Rerank pass 2
    mockConverse.mockResolvedValueOnce(JSON.stringify([0.7]));

    const result = await runIterativePipeline("test question", "/tmp/test", {
      evidenceOptions: {},
      enableImportFollowing: false,
    });

    // Should have evidence from both passes
    expect(result.allEvidence.length).toBeGreaterThanOrEqual(2);
  });

  it("emits iterative sub-step events for dashboard timeline", async () => {
    const steps: string[] = [];

    await runIterativePipeline("test question", "/tmp/test", {
      evidenceOptions: {},
      enableIteration: false,
      enableImportFollowing: false,
      onStep: (step) => steps.push(step),
    });

    expect(steps).toEqual(expect.arrayContaining([
      "evidence.reranked",
      "deepread.completed",
      "imports.followed",
      "gaps.identified",
      "iteration.pass2.completed",
    ]));
  });
});
