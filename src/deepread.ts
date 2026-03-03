import { readFile, access } from "node:fs/promises";
import { relative, resolve, dirname, join } from "node:path";
import type { EvidenceHit, DeepReadFile } from "./types.js";
import { isCodeHit } from "./evidence.js";
import { logger } from "./util/log.js";
import {
  DEEP_READ_MAX_FILES,
  DEEP_READ_MAX_FILE_SIZE,
  DEEP_READ_MAX_TOTAL_SIZE,
  DEEP_READ_SNIPPET_CAP,
  IMPORT_FOLLOW_MAX_FILES,
  IMPORT_SCORE_DECAY,
  CHUNK_CONTEXT_LINES,
  CHUNK_MERGE_GAP,
  CHUNK_MAX_SIZE_PER_FILE,
} from "./util/limits.js";

// ── File selection ───────────────────────────────────────────────────────────

/**
 * Select the top unique file paths from reranked evidence for deep reading.
 * Groups hits by file path, takes the highest score per file, filters to
 * code files only, and returns the top N ordered by descending score.
 */
export function selectFilesForDeepRead(
  hits: EvidenceHit[],
  maxFiles: number = DEEP_READ_MAX_FILES,
): { path: string; topScore: number }[] {
  const fileScores = new Map<string, number>();

  for (const hit of hits) {
    const current = fileScores.get(hit.path) ?? -Infinity;
    if (hit.score > current) {
      fileScores.set(hit.path, hit.score);
    }
  }

  return [...fileScores.entries()]
    .filter(([path]) => isCodeHit({ path } as EvidenceHit))
    .sort(([, a], [, b]) => b - a)
    .slice(0, maxFiles)
    .map(([path, topScore]) => ({ path, topScore }));
}

// ── Binary detection ─────────────────────────────────────────────────────────

/**
 * Heuristic binary detection: check for null bytes in first 8KB.
 * Same heuristic used by git, ripgrep, and most editors.
 */
function isBinaryBuffer(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

// ── File reading ─────────────────────────────────────────────────────────────

/**
 * Read full contents of selected files with safety checks.
 *
 * Guards:
 * - Per-file size limit (skip file, try next)
 * - Total cumulative size limit (stop reading)
 * - Binary detection (skip file, try next)
 * - Graceful skip on read errors
 */
export async function deepReadFiles(
  dir: string,
  candidates: { path: string; topScore: number }[],
  options: {
    maxFileSize?: number;
    maxTotalSize?: number;
    /** Evidence hits for smart chunking of oversized files */
    evidenceHits?: EvidenceHit[];
  } = {},
): Promise<DeepReadFile[]> {
  const maxFileSize = options.maxFileSize ?? DEEP_READ_MAX_FILE_SIZE;
  const maxTotalSize = options.maxTotalSize ?? DEEP_READ_MAX_TOTAL_SIZE;

  const results: DeepReadFile[] = [];
  let totalSize = 0;

  for (const candidate of candidates) {
    try {
      const buffer = await readFile(candidate.path);

      if (buffer.length > maxFileSize) {
        // Smart chunking: extract relevant regions from oversized files
        if (options.evidenceHits) {
          const hitLines = options.evidenceHits
            .filter((h) => h.path === candidate.path)
            .map((h) => h.lineNumber);

          if (hitLines.length > 0) {
            const content = buffer.toString("utf-8");
            const chunked = extractRelevantChunks(content, hitLines);

            if (chunked) {
              const chunkBytes = Buffer.byteLength(chunked, "utf-8");
              if (chunkBytes <= CHUNK_MAX_SIZE_PER_FILE && totalSize + chunkBytes <= maxTotalSize) {
                totalSize += chunkBytes;
                results.push({
                  path: relative(dir, candidate.path),
                  content: chunked,
                  sizeBytes: chunkBytes,
                  topScore: candidate.topScore,
                });
                logger.info("Deep read: chunked oversized file", {
                  path: candidate.path,
                  originalSize: buffer.length,
                  chunkedSize: chunkBytes,
                });
                continue;
              }
            }
          }
        }

        logger.info("Deep read: skipping oversized file", {
          path: candidate.path,
          size: buffer.length,
          limit: maxFileSize,
        });
        continue;
      }

      if (totalSize + buffer.length > maxTotalSize) {
        logger.info("Deep read: total size budget reached", {
          path: candidate.path,
          totalSoFar: totalSize,
          fileSize: buffer.length,
          limit: maxTotalSize,
        });
        break;
      }

      if (isBinaryBuffer(buffer)) {
        logger.info("Deep read: skipping binary file", {
          path: candidate.path,
        });
        continue;
      }

      const content = buffer.toString("utf-8");
      totalSize += buffer.length;

      results.push({
        path: relative(dir, candidate.path),
        content,
        sizeBytes: buffer.length,
        topScore: candidate.topScore,
      });
    } catch (err) {
      logger.warn("Deep read: failed to read file", {
        path: candidate.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info("Deep read completed", {
    filesRead: results.length,
    totalBytes: totalSize,
    files: results.map((f) => f.path),
  });

  return results;
}

// ── Snippet filtering ────────────────────────────────────────────────────────

/**
 * Remove snippet hits from files already deep-read (to avoid duplication)
 * and cap the remaining snippet count.
 */
export function filterSnippetsForDeepRead(
  hits: EvidenceHit[],
  deepReadAbsPaths: Set<string>,
  maxSnippets: number = DEEP_READ_SNIPPET_CAP,
): EvidenceHit[] {
  return hits
    .filter((h) => !deepReadAbsPaths.has(h.path))
    .slice(0, maxSnippets);
}

// ── Smart chunking ──────────────────────────────────────────────────────────

/**
 * Extract relevant regions from a large file based on evidence hit line numbers.
 * Groups nearby hits into clusters, extracts ±CHUNK_CONTEXT_LINES around each
 * cluster, and joins them with separator comments.
 */
export function extractRelevantChunks(
  content: string,
  hitLines: number[],
  contextLines: number = CHUNK_CONTEXT_LINES,
): string | null {
  if (hitLines.length === 0) return null;

  const lines = content.split("\n");
  const sorted = [...new Set(hitLines)].sort((a, b) => a - b);

  // Build clusters: merge hits within CHUNK_MERGE_GAP of each other
  const clusters: { start: number; end: number }[] = [];
  let clusterStart = sorted[0];
  let clusterEnd = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - clusterEnd <= CHUNK_MERGE_GAP) {
      clusterEnd = sorted[i];
    } else {
      clusters.push({ start: clusterStart, end: clusterEnd });
      clusterStart = sorted[i];
      clusterEnd = sorted[i];
    }
  }
  clusters.push({ start: clusterStart, end: clusterEnd });

  // Expand clusters with context and extract
  const chunks: string[] = [];
  for (const cluster of clusters) {
    // Convert to 0-indexed and clamp
    const rangeStart = Math.max(0, cluster.start - 1 - contextLines);
    const rangeEnd = Math.min(lines.length - 1, cluster.end - 1 + contextLines);

    chunks.push(`// lines ${rangeStart + 1}-${rangeEnd + 1}`);
    chunks.push(lines.slice(rangeStart, rangeEnd + 1).join("\n"));
  }

  return chunks.join("\n// ... (lines omitted) ...\n");
}

// ── Import following ────────────────────────────────────────────────────────

/** Regex patterns that capture module specifiers from import/require statements */
const IMPORT_PATTERNS: RegExp[] = [
  /import\s+(?:[\w{}\s*,]+)\s+from\s+["']([^"']+)["']/g,
  /export\s+(?:[\w{}\s*,]+)\s+from\s+["']([^"']+)["']/g,
  /import\s*\(\s*["']([^"']+)["']\s*\)/g,
  /require\s*\(\s*["']([^"']+)["']\s*\)/g,
];

/** Extract all import/require specifiers from file content */
function extractImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    // Reset lastIndex for each call since patterns have /g flag
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/** Extension fallbacks for resolving bare module specifiers */
const EXTENSION_FALLBACKS = [
  "",          // exact match
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  "/index.ts",
  "/index.js",
];

/**
 * TypeScript often imports with .js extensions that map to .ts files on disk.
 * Strip known JS extensions and re-try with TS equivalents.
 */
const JS_TO_TS_MAP: [string, string][] = [
  [".js", ".ts"],
  [".jsx", ".tsx"],
  [".mjs", ".mts"],
];

/** Try to resolve a relative module specifier to an absolute file path */
async function resolveModulePath(
  specifier: string,
  fromFileAbsPath: string,
): Promise<string | null> {
  const baseDir = dirname(fromFileAbsPath);
  const base = resolve(baseDir, specifier);

  // Try exact + extension fallbacks first
  for (const ext of EXTENSION_FALLBACKS) {
    const candidate = base + ext;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Not found, try next
    }
  }

  // Try .js → .ts mapping (TypeScript projects import with .js extensions)
  for (const [jsExt, tsExt] of JS_TO_TS_MAP) {
    if (specifier.endsWith(jsExt)) {
      const stripped = resolve(baseDir, specifier.slice(0, -jsExt.length) + tsExt);
      try {
        await access(stripped);
        return stripped;
      } catch {
        // Not found
      }
    }
  }

  return null;
}

/**
 * Parse import/require statements from deep-read files, resolve relative
 * paths, and return candidate files for additional deep reading.
 *
 * Only follows RELATIVE imports (starting with "./" or "../").
 * Skips already-read files and non-existent files.
 * Returns candidates sorted by frequency (most-imported first).
 */
export async function resolveImportsFromDeepReads(
  dir: string,
  deepReads: DeepReadFile[],
  alreadyRead: Set<string>,
): Promise<{ path: string; topScore: number }[]> {
  const importCounts = new Map<string, number>();
  const importScores = new Map<string, number>();

  for (const dr of deepReads) {
    const absPath = join(dir, dr.path);
    const specifiers = extractImportSpecifiers(dr.content);

    for (const spec of specifiers) {
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue;

      const resolved = await resolveModulePath(spec, absPath);
      if (!resolved || alreadyRead.has(resolved)) continue;

      importCounts.set(resolved, (importCounts.get(resolved) ?? 0) + 1);
      const currentScore = importScores.get(resolved) ?? 0;
      const decayedScore = dr.topScore * IMPORT_SCORE_DECAY;
      if (decayedScore > currentScore) {
        importScores.set(resolved, decayedScore);
      }
    }
  }

  const candidates = [...importCounts.entries()]
    .sort(([, countA], [, countB]) => countB - countA)
    .slice(0, IMPORT_FOLLOW_MAX_FILES)
    .map(([path]) => ({
      path,
      topScore: importScores.get(path) ?? 0,
    }));

  if (candidates.length > 0) {
    logger.info("Import following: resolved candidates", {
      count: candidates.length,
      files: candidates.map((c) => relative(dir, c.path)),
    });
  }

  return candidates;
}
