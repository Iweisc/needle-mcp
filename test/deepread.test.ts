import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  selectFilesForDeepRead,
  deepReadFiles,
  filterSnippetsForDeepRead,
  extractRelevantChunks,
  resolveImportsFromDeepReads,
} from "../src/deepread.js";
import type { EvidenceHit, DeepReadFile } from "../src/types.js";

function makeHit(overrides: Partial<EvidenceHit> = {}): EvidenceHit {
  return {
    path: "/tmp/test/src/index.ts",
    lineNumber: 1,
    text: "export function foo() {}",
    score: 5,
    submatches: [],
    ...overrides,
  };
}

// ── selectFilesForDeepRead ───────────────────────────────────────────────────

describe("selectFilesForDeepRead", () => {
  it("picks unique files sorted by highest score", () => {
    const hits = [
      makeHit({ path: "/repo/src/a.ts", score: 10 }),
      makeHit({ path: "/repo/src/b.ts", score: 8 }),
      makeHit({ path: "/repo/src/c.ts", score: 6 }),
    ];

    const result = selectFilesForDeepRead(hits);
    expect(result).toEqual([
      { path: "/repo/src/a.ts", topScore: 10 },
      { path: "/repo/src/b.ts", topScore: 8 },
      { path: "/repo/src/c.ts", topScore: 6 },
    ]);
  });

  it("deduplicates files keeping highest score", () => {
    const hits = [
      makeHit({ path: "/repo/src/a.ts", score: 3, lineNumber: 10 }),
      makeHit({ path: "/repo/src/a.ts", score: 8, lineNumber: 50 }),
      makeHit({ path: "/repo/src/a.ts", score: 5, lineNumber: 30 }),
    ];

    const result = selectFilesForDeepRead(hits);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ path: "/repo/src/a.ts", topScore: 8 });
  });

  it("filters out non-code files (.md, .json)", () => {
    const hits = [
      makeHit({ path: "/repo/README.md", score: 10 }),
      makeHit({ path: "/repo/package.json", score: 9 }),
      makeHit({ path: "/repo/src/index.ts", score: 5 }),
    ];

    const result = selectFilesForDeepRead(hits);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("/repo/src/index.ts");
  });

  it("respects maxFiles parameter", () => {
    const hits = Array.from({ length: 20 }, (_, i) =>
      makeHit({ path: `/repo/src/file${i}.ts`, score: 20 - i }),
    );

    const result = selectFilesForDeepRead(hits, 3);
    expect(result).toHaveLength(3);
    expect(result[0].topScore).toBe(20);
    expect(result[2].topScore).toBe(18);
  });

  it("returns [] for empty input", () => {
    expect(selectFilesForDeepRead([])).toEqual([]);
  });

  it("returns [] when all hits are from markdown files", () => {
    const hits = [
      makeHit({ path: "/repo/README.md", score: 10 }),
      makeHit({ path: "/repo/docs/guide.md", score: 8 }),
      makeHit({ path: "/repo/CHANGELOG.md", score: 6 }),
    ];

    expect(selectFilesForDeepRead(hits)).toEqual([]);
  });
});

// ── deepReadFiles ────────────────────────────────────────────────────────────

describe("deepReadFiles", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "deepread-test-"));
    await mkdir(join(tempDir, "src"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("reads files within size limit", async () => {
    const filePath = join(tempDir, "src/index.ts");
    await writeFile(filePath, 'export function hello() { return "world"; }');

    const result = await deepReadFiles(tempDir, [
      { path: filePath, topScore: 10 },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/index.ts");
    expect(result[0].content).toContain("hello");
    expect(result[0].topScore).toBe(10);
    expect(result[0].sizeBytes).toBeGreaterThan(0);
  });

  it("skips oversized files and tries next", async () => {
    const bigFile = join(tempDir, "src/big.ts");
    const smallFile = join(tempDir, "src/small.ts");
    await writeFile(bigFile, "x".repeat(1000));
    await writeFile(smallFile, "export const y = 1;");

    const result = await deepReadFiles(
      tempDir,
      [
        { path: bigFile, topScore: 10 },
        { path: smallFile, topScore: 5 },
      ],
      { maxFileSize: 500 },
    );

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/small.ts");
  });

  it("stops when total size budget is exhausted", async () => {
    const file1 = join(tempDir, "src/a.ts");
    const file2 = join(tempDir, "src/b.ts");
    const file3 = join(tempDir, "src/c.ts");
    await writeFile(file1, "a".repeat(100));
    await writeFile(file2, "b".repeat(100));
    await writeFile(file3, "c".repeat(100));

    const result = await deepReadFiles(
      tempDir,
      [
        { path: file1, topScore: 10 },
        { path: file2, topScore: 8 },
        { path: file3, topScore: 6 },
      ],
      { maxTotalSize: 180 },
    );

    // Only first file fits within budget (100 < 180), second would push to 200 > 180
    // Actually: first file (100) → total=100, second file (100) → 100+100=200 > 180, stop
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/a.ts");
  });

  it("skips binary files (null bytes)", async () => {
    const binaryFile = join(tempDir, "src/binary.ts");
    const textFile = join(tempDir, "src/text.ts");
    await writeFile(binaryFile, Buffer.from([0x65, 0x78, 0x00, 0x70]));
    await writeFile(textFile, "export const x = 1;");

    const result = await deepReadFiles(tempDir, [
      { path: binaryFile, topScore: 10 },
      { path: textFile, topScore: 5 },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/text.ts");
  });

  it("gracefully skips unreadable files", async () => {
    const missingFile = join(tempDir, "src/missing.ts");
    const existingFile = join(tempDir, "src/exists.ts");
    await writeFile(existingFile, "export const x = 1;");

    const result = await deepReadFiles(tempDir, [
      { path: missingFile, topScore: 10 },
      { path: existingFile, topScore: 5 },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/exists.ts");
  });

  it("returns relative paths in output", async () => {
    const filePath = join(tempDir, "src/nested/deep.ts");
    await mkdir(join(tempDir, "src/nested"), { recursive: true });
    await writeFile(filePath, "export const x = 1;");

    const result = await deepReadFiles(tempDir, [
      { path: filePath, topScore: 10 },
    ]);

    expect(result[0].path).toBe("src/nested/deep.ts");
  });

  it("returns [] when all candidates fail", async () => {
    const result = await deepReadFiles(tempDir, [
      { path: join(tempDir, "src/gone1.ts"), topScore: 10 },
      { path: join(tempDir, "src/gone2.ts"), topScore: 8 },
    ]);

    expect(result).toEqual([]);
  });
});

// ── filterSnippetsForDeepRead ────────────────────────────────────────────────

describe("filterSnippetsForDeepRead", () => {
  it("removes hits from deep-read files", () => {
    const hits = [
      makeHit({ path: "/repo/src/a.ts", score: 10 }),
      makeHit({ path: "/repo/src/b.ts", score: 8 }),
      makeHit({ path: "/repo/src/c.ts", score: 6 }),
    ];

    const deepReadPaths = new Set(["/repo/src/a.ts"]);
    const result = filterSnippetsForDeepRead(hits, deepReadPaths);

    expect(result).toHaveLength(2);
    expect(result[0].path).toBe("/repo/src/b.ts");
    expect(result[1].path).toBe("/repo/src/c.ts");
  });

  it("keeps all hits when deepReadPaths is empty", () => {
    const hits = [
      makeHit({ path: "/repo/src/a.ts", score: 10 }),
      makeHit({ path: "/repo/src/b.ts", score: 8 }),
    ];

    const result = filterSnippetsForDeepRead(hits, new Set());
    expect(result).toHaveLength(2);
  });

  it("respects maxSnippets cap", () => {
    const hits = Array.from({ length: 50 }, (_, i) =>
      makeHit({ path: `/repo/src/file${i}.ts`, score: 50 - i }),
    );

    const result = filterSnippetsForDeepRead(hits, new Set(), 10);
    expect(result).toHaveLength(10);
    expect(result[0].score).toBe(50);
  });

  it("returns empty array when all hits are from deep-read files", () => {
    const hits = [
      makeHit({ path: "/repo/src/a.ts", score: 10 }),
      makeHit({ path: "/repo/src/b.ts", score: 8 }),
    ];

    const deepReadPaths = new Set(["/repo/src/a.ts", "/repo/src/b.ts"]);
    const result = filterSnippetsForDeepRead(hits, deepReadPaths);
    expect(result).toEqual([]);
  });
});

// ── extractRelevantChunks ────────────────────────────────────────────────────

describe("extractRelevantChunks", () => {
  const bigContent = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");

  it("extracts region around a single hit", () => {
    const result = extractRelevantChunks(bigContent, [50], 10);
    expect(result).not.toBeNull();
    expect(result).toContain("line 40");
    expect(result).toContain("line 50");
    expect(result).toContain("line 60");
  });

  it("merges nearby hits into one cluster", () => {
    const result = extractRelevantChunks(bigContent, [50, 55, 60], 10);
    expect(result).not.toBeNull();
    // Should be one continuous range — only one "// lines" header
    const headers = result!.match(/^\/\/ lines \d+-\d+$/gm) ?? [];
    expect(headers).toHaveLength(1);
  });

  it("creates separate clusters for distant hits", () => {
    const result = extractRelevantChunks(bigContent, [20, 180], 10);
    expect(result).not.toBeNull();
    // Should have two chunks — two "// lines" headers
    const headers = result!.match(/^\/\/ lines \d+-\d+$/gm) ?? [];
    expect(headers).toHaveLength(2);
    expect(result).toContain("line 20");
    expect(result).toContain("line 180");
  });

  it("clamps to file boundaries", () => {
    const result = extractRelevantChunks(bigContent, [2, 199], 10);
    expect(result).not.toBeNull();
    expect(result).toContain("line 1"); // clamped to start
    expect(result).toContain("line 200"); // clamped to end
  });

  it("returns null for empty hitLines", () => {
    expect(extractRelevantChunks(bigContent, [])).toBeNull();
  });

  it("deduplicates hit lines", () => {
    const result = extractRelevantChunks(bigContent, [50, 50, 50], 10);
    expect(result).not.toBeNull();
    expect(result).toContain("line 50");
  });
});

// ── Smart chunking in deepReadFiles ──────────────────────────────────────────

describe("deepReadFiles smart chunking", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chunk-test-"));
    await mkdir(join(tempDir, "src"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("chunks oversized files when evidenceHits are provided", async () => {
    const filePath = join(tempDir, "src/big.ts");
    const lines = Array.from({ length: 500 }, (_, i) => `function fn${i}() { return ${i}; }`);
    await writeFile(filePath, lines.join("\n"));

    const result = await deepReadFiles(
      tempDir,
      [{ path: filePath, topScore: 10 }],
      {
        maxFileSize: 100, // Force file to be "oversized"
        evidenceHits: [makeHit({ path: filePath, lineNumber: 250 })],
      },
    );

    expect(result).toHaveLength(1);
    expect(result[0].content).toContain("fn250");
    expect(result[0].sizeBytes).toBeLessThan(lines.join("\n").length);
  });

  it("skips oversized files without evidenceHits option", async () => {
    const filePath = join(tempDir, "src/big.ts");
    await writeFile(filePath, "x".repeat(1000));

    const result = await deepReadFiles(
      tempDir,
      [{ path: filePath, topScore: 10 }],
      { maxFileSize: 100 },
    );

    expect(result).toHaveLength(0);
  });
});

// ── resolveImportsFromDeepReads ──────────────────────────────────────────────

describe("resolveImportsFromDeepReads", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "import-test-"));
    await mkdir(join(tempDir, "src"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("extracts and resolves relative ES imports", async () => {
    await writeFile(join(tempDir, "src/foo.ts"), "export const x = 1;");

    const deepReads: DeepReadFile[] = [{
      path: "src/index.ts",
      content: 'import { x } from "./foo.js";',
      sizeBytes: 30,
      topScore: 10,
    }];

    const result = await resolveImportsFromDeepReads(tempDir, deepReads, new Set());
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].path).toContain("foo.ts");
  });

  it("ignores bare/package imports", async () => {
    const deepReads: DeepReadFile[] = [{
      path: "src/index.ts",
      content: 'import React from "react";\nimport { z } from "zod";',
      sizeBytes: 50,
      topScore: 10,
    }];

    const result = await resolveImportsFromDeepReads(tempDir, deepReads, new Set());
    expect(result).toEqual([]);
  });

  it("skips already-read files", async () => {
    const fooPath = join(tempDir, "src/foo.ts");
    await writeFile(fooPath, "export const x = 1;");

    const deepReads: DeepReadFile[] = [{
      path: "src/index.ts",
      content: 'import { x } from "./foo.js";',
      sizeBytes: 30,
      topScore: 10,
    }];

    const result = await resolveImportsFromDeepReads(
      tempDir,
      deepReads,
      new Set([fooPath]),
    );
    expect(result).toEqual([]);
  });

  it("resolves .ts extension fallback", async () => {
    await writeFile(join(tempDir, "src/bar.ts"), "export const y = 2;");

    const deepReads: DeepReadFile[] = [{
      path: "src/index.ts",
      content: 'import { y } from "./bar";',
      sizeBytes: 25,
      topScore: 10,
    }];

    const result = await resolveImportsFromDeepReads(tempDir, deepReads, new Set());
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].path).toContain("bar.ts");
  });

  it("resolves index.ts for directory imports", async () => {
    await mkdir(join(tempDir, "src/utils"), { recursive: true });
    await writeFile(join(tempDir, "src/utils/index.ts"), "export const z = 3;");

    const deepReads: DeepReadFile[] = [{
      path: "src/index.ts",
      content: 'import { z } from "./utils";',
      sizeBytes: 28,
      topScore: 10,
    }];

    const result = await resolveImportsFromDeepReads(tempDir, deepReads, new Set());
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].path).toContain("utils");
  });

  it("applies score decay", async () => {
    await writeFile(join(tempDir, "src/dep.ts"), "export const w = 4;");

    const deepReads: DeepReadFile[] = [{
      path: "src/index.ts",
      content: 'import { w } from "./dep";',
      sizeBytes: 25,
      topScore: 10,
    }];

    const result = await resolveImportsFromDeepReads(tempDir, deepReads, new Set());
    expect(result[0].topScore).toBe(8); // 10 * 0.8
  });

  it("handles re-exports", async () => {
    await writeFile(join(tempDir, "src/thing.ts"), "export const t = 5;");

    const deepReads: DeepReadFile[] = [{
      path: "src/index.ts",
      content: 'export { t } from "./thing";',
      sizeBytes: 28,
      topScore: 10,
    }];

    const result = await resolveImportsFromDeepReads(tempDir, deepReads, new Set());
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].path).toContain("thing.ts");
  });
});
