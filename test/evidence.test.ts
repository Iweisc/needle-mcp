import { describe, it, expect } from "vitest";
import {
  deriveQueries,
  scorePath,
  isCodeHit,
  countCodeHits,
} from "../src/evidence.js";
import type { ApiSurface } from "../src/discover.js";
import type { EvidenceHit } from "../src/types.js";

// ── deriveQueries ─────────────────────────────────────────────────────────────

describe("deriveQueries", () => {
  it("uses discovered symbols as primary queries", () => {
    const surface: ApiSurface = {
      symbols: ["createServer", "ServerConfig", "useQuery"],
      entrypoints: ["dist/index.d.ts"],
    };
    const queries = deriveQueries(
      "How do I use this library in a React app?",
      surface,
    );
    expect(queries).toContain("createServer");
    expect(queries).toContain("ServerConfig");
    expect(queries).toContain("useQuery");
  });

  it("generates case variants for symbols", () => {
    const surface: ApiSurface = {
      symbols: ["createServer"],
      entrypoints: [],
    };
    const queries = deriveQueries("setup", surface);
    expect(queries).toContain("createServer");
    expect(queries).toContain("create_server");
  });

  it("filters out generic English words from question", () => {
    const queries = deriveQueries(
      "How do I use the app and show data in a way that works?",
    );
    // These noise words should be filtered
    expect(queries).not.toContain("use");
    expect(queries).not.toContain("app");
    expect(queries).not.toContain("show");
    expect(queries).not.toContain("way");
    expect(queries).not.toContain("works");
    expect(queries).not.toContain("data");
  });

  it("keeps code-like tokens from question (camelCase, underscores)", () => {
    const queries = deriveQueries(
      "How do I configure createSanityInstance with my_token?",
    );
    expect(queries).toContain("createSanityInstance");
    expect(queries).toContain("my_token");
  });

  it("generates export-pattern queries for top symbols", () => {
    const surface: ApiSurface = {
      symbols: ["SanityApp", "useQuery"],
      entrypoints: [],
    };
    const queries = deriveQueries("setup", surface);
    expect(queries.some((q) => q.includes("export") && q.includes("SanityApp"))).toBe(true);
  });

  it("falls back to intent patterns when no symbols and no code tokens", () => {
    const queries = deriveQueries("how do I set up this library?");
    // Should have some structural patterns
    expect(queries.some((q) => q.includes("export"))).toBe(true);
  });

  it("caps at 25 queries", () => {
    const surface: ApiSurface = {
      symbols: Array.from({ length: 50 }, (_, i) => `symbol${i}`),
      entrypoints: [],
    };
    const queries = deriveQueries("test", surface);
    expect(queries.length).toBeLessThanOrEqual(25);
  });
});

// ── scorePath ─────────────────────────────────────────────────────────────────

describe("scorePath", () => {
  it("ranks src/ .ts files above README.md", () => {
    const srcScore = scorePath("src/index.ts");
    const readmeScore = scorePath("README.md");
    expect(srcScore).toBeGreaterThan(readmeScore);
  });

  it("ranks .d.ts highest", () => {
    const dtsScore = scorePath("dist/index.d.ts");
    const srcScore = scorePath("src/main.ts");
    const mdScore = scorePath("README.md");
    expect(dtsScore).toBeGreaterThan(srcScore);
    expect(dtsScore).toBeGreaterThan(mdScore);
  });

  it("ranks packages/** above docs", () => {
    const pkgScore = scorePath("packages/core/src/client.ts");
    const docsScore = scorePath("docs/guide.md");
    expect(pkgScore).toBeGreaterThan(docsScore);
  });

  it("ranks examples/ above generic docs", () => {
    const exampleScore = scorePath("examples/basic/index.ts");
    const readmeScore = scorePath("README.md");
    expect(exampleScore).toBeGreaterThan(readmeScore);
  });

  it("penalizes node_modules heavily", () => {
    const nmScore = scorePath("node_modules/foo/index.ts");
    expect(nmScore).toBeLessThan(0);
  });

  it("penalizes dist/ non-.d.ts files", () => {
    const distJsScore = scorePath("dist/index.js");
    const srcScore = scorePath("src/index.ts");
    expect(distJsScore).toBeLessThan(srcScore);
  });

  it("penalizes minified files", () => {
    const minScore = scorePath("dist/bundle.min.js");
    expect(minScore).toBeLessThan(0);
  });

  it("boosts index files", () => {
    const indexScore = scorePath("src/index.ts");
    const otherScore = scorePath("src/utils.ts");
    expect(indexScore).toBeGreaterThan(otherScore);
  });
});

// ── isCodeHit / countCodeHits ─────────────────────────────────────────────────

describe("isCodeHit", () => {
  const makeHit = (path: string): EvidenceHit => ({
    path,
    lineNumber: 1,
    text: "test",
    score: 0,
    submatches: [],
  });

  it("returns true for .ts, .js, .d.ts files", () => {
    expect(isCodeHit(makeHit("src/index.ts"))).toBe(true);
    expect(isCodeHit(makeHit("lib/main.js"))).toBe(true);
    expect(isCodeHit(makeHit("dist/types.d.ts"))).toBe(true);
    expect(isCodeHit(makeHit("src/app.tsx"))).toBe(true);
    expect(isCodeHit(makeHit("lib/util.mjs"))).toBe(true);
  });

  it("returns false for .md, .json, .mdx files", () => {
    expect(isCodeHit(makeHit("README.md"))).toBe(false);
    expect(isCodeHit(makeHit("package.json"))).toBe(false);
    expect(isCodeHit(makeHit("docs/guide.mdx"))).toBe(false);
  });
});

describe("countCodeHits", () => {
  const makeHit = (path: string): EvidenceHit => ({
    path,
    lineNumber: 1,
    text: "test",
    score: 0,
    submatches: [],
  });

  it("counts code files in top N hits", () => {
    const hits: EvidenceHit[] = [
      makeHit("src/index.ts"),
      makeHit("README.md"),
      makeHit("src/client.ts"),
      makeHit("docs/api.md"),
      makeHit("lib/util.js"),
    ];
    expect(countCodeHits(hits, 5)).toBe(3);
    expect(countCodeHits(hits, 2)).toBe(1);
  });

  it("returns 0 for all-markdown hits", () => {
    const hits: EvidenceHit[] = [
      makeHit("README.md"),
      makeHit("CHANGELOG.md"),
      makeHit("docs/guide.md"),
    ];
    expect(countCodeHits(hits)).toBe(0);
  });
});

// ── Regression: broad question should not produce only README hits ─────────

describe("regression: broad question handling", () => {
  it("broad question with symbols should produce symbol-based queries, not generic words", () => {
    const surface: ApiSurface = {
      symbols: [
        "createSanityInstance",
        "getClient",
        "SanityApp",
        "useQuery",
        "useDocuments",
        "resolveQuery",
      ],
      entrypoints: ["dist/index.d.ts"],
      packageName: "@sanity/sdk",
    };

    const queries = deriveQueries(
      "How do I use @sanity/sdk in a React app? How to create a client, authenticate, and fetch documents?",
      surface,
    );

    // Should contain actual API symbols
    expect(queries).toContain("createSanityInstance");
    expect(queries).toContain("getClient");
    expect(queries).toContain("SanityApp");
    expect(queries).toContain("useQuery");

    // Should NOT contain generic English noise
    expect(queries).not.toContain("use");
    expect(queries).not.toContain("app");
    expect(queries).not.toContain("create");
    expect(queries).not.toContain("fetch");
  });

  it("scoring ensures src/ files rank above README for the same match", () => {
    const srcHit: EvidenceHit = {
      path: "packages/core/src/createSanityInstance.ts",
      lineNumber: 15,
      text: "export function createSanityInstance(config: SanityConfig) {",
      score: scorePath("packages/core/src/createSanityInstance.ts"),
      submatches: ["createSanityInstance"],
    };

    const readmeHit: EvidenceHit = {
      path: "README.md",
      lineNumber: 22,
      text: "The Sanity App SDK exposes these platform capabilities",
      score: scorePath("README.md"),
      submatches: ["Sanity"],
    };

    expect(srcHit.score).toBeGreaterThan(readmeHit.score);
  });
});
