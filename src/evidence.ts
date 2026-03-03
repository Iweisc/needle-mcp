import type { EvidenceHit, RgMatch } from "./types.js";
import type { ApiSurface } from "./discover.js";
import { rgSearch, type RgSearchOptions } from "./ripgrep.js";
import { logger } from "./util/log.js";
import { DEFAULT_MAX_HITS } from "./util/limits.js";

// ── Noise filter ──────────────────────────────────────────────────────────────

/** Words that are too generic to ever use as standalone rg queries */
const NOISE_WORDS = new Set([
  // English stop words
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "as", "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "both",
  "each", "few", "more", "most", "other", "some", "such", "no", "nor",
  "not", "only", "own", "same", "so", "than", "too", "very", "just",
  "don", "now", "and", "but", "or", "if", "this", "that", "these",
  "those", "what", "which", "who", "whom", "it", "its", "i", "me",
  "my", "we", "our", "you", "your", "he", "him", "his", "she", "her",
  "they", "them", "their",
  // Generic programming words that match everything
  "use", "using", "app", "application", "way", "show", "get", "set",
  "new", "create", "make", "call", "run", "start", "stop", "add",
  "remove", "update", "delete", "read", "write", "open", "close",
  "file", "data", "code", "work", "works", "working", "help",
  "want", "like", "try", "thing", "example", "need", "please",
]);

/** Language to extension globs mapping */
const LANG_GLOBS: Record<string, string[]> = {
  ts: ["*.ts", "*.tsx", "*.d.ts", "*.md", "*.mdx", "*.json"],
  js: ["*.js", "*.jsx", "*.mjs", "*.cjs", "*.md", "*.mdx", "*.json"],
  any: ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs", "*.d.ts", "*.md", "*.mdx", "*.json"],
};

// ── Code-shaped intent patterns ───────────────────────────────────────────────

/**
 * Intent patterns that pair with discovered symbols to form targeted queries.
 * These represent common "how do I use X" code patterns.
 */
const INTENT_PATTERNS = [
  "export function",
  "export class",
  "export default",
  "export const",
  "export interface",
  "export type",
  "new \\w+\\(",       // constructor calls
  "import.*from",
  "module\\.exports",
  "createInstance",
  "initialize",
  "configure",
  "Provider",
  "Context",
  "config",
  "options",
  "hook",
];

// ── Scoring ───────────────────────────────────────────────────────────────────

/** Score a match path for relevance — code-first, docs-secondary */
export function scorePath(filePath: string): number {
  let score = 0;
  const lower = filePath.toLowerCase();

  // ── Strong positive: source code and types ──
  if (lower.endsWith(".d.ts")) score += 5;
  if (lower.includes("/src/") || lower.startsWith("src/")) score += 4;
  if (lower.includes("/packages/")) score += 3.5;
  if (lower.includes("/lib/") || lower.startsWith("lib/")) score += 3;
  if (lower.includes("/examples/") || lower.includes("/example/")) score += 3;

  // Source file extensions
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) score += 1;
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs")) score += 0.5;

  // ── Moderate positive: test files (useful for usage examples) ──
  if (lower.includes("/test/") || lower.includes("/__tests__/") || lower.includes(".test.") || lower.includes(".spec.")) {
    score += 1.5;
  }

  // ── Low positive: docs (never dominate over code) ──
  if (lower.includes("readme")) score += 0.5;
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) score += 0.25;

  // ── Strong negative: junk ──
  if (lower.includes("node_modules/")) score -= 10;
  if (lower.includes("/dist/") && !lower.endsWith(".d.ts")) score -= 4;
  if (lower.includes(".min.js")) score -= 5;
  if (lower.includes("/coverage/")) score -= 5;
  if (lower.includes("changelog") || lower.includes("license")) score -= 3;
  if (lower.includes("package-lock") || lower.includes("pnpm-lock") || lower.includes("yarn.lock")) score -= 5;

  // ── Index/barrel files are extra useful ──
  const base = lower.split("/").pop() ?? "";
  if (base.startsWith("index.")) score += 2;

  return score;
}

/** Is this hit from actual source code (not just markdown/docs)? */
export function isCodeHit(hit: EvidenceHit): boolean {
  const lower = hit.path.toLowerCase();
  return (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs") ||
    lower.endsWith(".d.ts")
  );
}

// ── Case variants ─────────────────────────────────────────────────────────────

function caseVariants(word: string): string[] {
  const variants: string[] = [word];

  // camelCase → snake_case
  const snake = word.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  if (snake !== word.toLowerCase()) variants.push(snake);

  // snake_case → camelCase
  const camel = word.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  if (camel !== word) variants.push(camel);

  return [...new Set(variants)];
}

// ── Two-pass query generation ─────────────────────────────────────────────────

/** Rank symbols by likely relevance: functions > classes > types */
function rankSymbols(symbols: string[]): string[] {
  const buckets = {
    create: [] as string[],   // create*, init*, configure*
    get: [] as string[],      // get*, resolve*, fetch*
    func: [] as string[],     // other lowercase (functions)
    cls: [] as string[],      // PascalCase non-suffix (classes/core types)
    types: [] as string[],    // *Options, *Result, *State, *Type, *Config
  };

  for (const sym of symbols) {
    const lower = sym.toLowerCase();
    if (/^(create|init|configure|setup)/.test(lower)) {
      buckets.create.push(sym);
    } else if (/^(get|resolve|fetch|query|find|load)/.test(lower)) {
      buckets.get.push(sym);
    } else if (/^[a-z]/.test(sym)) {
      buckets.func.push(sym);
    } else if (/(Options|Result|State|Type|Event|Error|Handle)$/.test(sym)) {
      buckets.types.push(sym);
    } else {
      buckets.cls.push(sym);
    }
  }

  return [
    ...buckets.create,
    ...buckets.get,
    ...buckets.func,
    ...buckets.cls,
    ...buckets.types,
  ];
}

/**
 * Pass 1: Generate queries from discovered API surface symbols.
 * These are the exact exported names we found in the codebase.
 * Prioritized: create/init > get/resolve > other funcs > classes > types.
 */
function symbolQueries(surface: ApiSurface): string[] {
  const ranked = rankSymbols(surface.symbols);
  const queries: string[] = [];
  for (const sym of ranked) {
    if (sym.length < 3) continue;
    if (NOISE_WORDS.has(sym.toLowerCase())) continue;

    for (const v of caseVariants(sym)) {
      if (!queries.includes(v)) queries.push(v);
    }
  }
  return queries;
}

/**
 * Pass 2: Generate queries from the question text, but only keep
 * words that look like code tokens (contain uppercase, underscores,
 * or are in the symbol list). Generic English words are dropped.
 */
function questionQueries(question: string, knownSymbols: Set<string>): string[] {
  const words = question
    .replace(/[^\w\s@/.-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3);

  const queries: string[] = [];

  for (const word of words) {
    // Skip noise
    if (NOISE_WORDS.has(word.toLowerCase())) continue;

    // Accept if: known symbol, has uppercase interior (camelCase), has underscore, or starts with @
    const isCodeLike =
      knownSymbols.has(word) ||
      /[a-z][A-Z]/.test(word) ||
      word.includes("_") ||
      word.startsWith("@");

    if (isCodeLike) {
      for (const v of caseVariants(word)) {
        if (!queries.includes(v)) queries.push(v);
      }
    }
  }

  return queries;
}

/**
 * Derive search queries using two-pass strategy:
 * 1. Symbol queries from API surface discovery
 * 2. Code-shaped tokens from the question
 * 3. Intent patterns (export, import, config, etc.)
 */
export function deriveQueries(
  question: string,
  surface?: ApiSurface,
): string[] {
  const allQueries: string[] = [];

  // Pass 1: symbol-based queries (highest priority)
  if (surface && surface.symbols.length > 0) {
    const symQ = symbolQueries(surface);
    // Take enough symbol queries to cover the important API surface
    const symLimit = Math.min(symQ.length, 16);
    for (const q of symQ.slice(0, symLimit)) {
      if (!allQueries.includes(q)) allQueries.push(q);
    }
  }

  // Pass 2: code-like tokens from question
  const knownSet = new Set(surface?.symbols ?? []);
  const qQ = questionQueries(question, knownSet);
  for (const q of qQ) {
    if (!allQueries.includes(q)) allQueries.push(q);
  }

  // Pass 3: if we have symbols, combine them with intent patterns
  if (surface && surface.symbols.length > 0) {
    // Pick a few key symbols for intent pairing
    const keySymbols = surface.symbols.slice(0, 5);
    for (const sym of keySymbols) {
      // "export.*SymbolName" catches definitions
      const defQuery = `export.*${sym}`;
      if (!allQueries.includes(defQuery)) allQueries.push(defQuery);
    }
  }

  // Pass 4: generic structural queries (only if we have few results)
  if (allQueries.length < 5) {
    for (const pattern of INTENT_PATTERNS.slice(0, 6)) {
      if (!allQueries.includes(pattern)) allQueries.push(pattern);
    }
  }

  // Cap total queries (rg calls are parallel and fast, so 25 is fine)
  return allQueries.slice(0, 25);
}

// ── Dedup ─────────────────────────────────────────────────────────────────────

function dedupKey(hit: EvidenceHit): string {
  const bucket = Math.floor(hit.lineNumber / 10);
  return `${hit.path}:${bucket}`;
}

// ── Main evidence collector ───────────────────────────────────────────────────

export interface CollectEvidenceOptions {
  language?: string;
  maxHits?: number;
  contextLines?: number;
  surface?: ApiSurface;
  expandWithLlm?: boolean;
  /** If set, skip query derivation and use these patterns directly */
  overrideQueries?: string[];
}

export async function collectEvidence(
  question: string,
  dir: string,
  options: CollectEvidenceOptions = {},
): Promise<EvidenceHit[]> {
  const {
    language = "any",
    maxHits = DEFAULT_MAX_HITS,
    contextLines = 3,
    surface,
    expandWithLlm = false,
  } = options;

  let queries = options.overrideQueries ?? deriveQueries(question, surface);

  // Merge LLM-expanded queries when enabled (skip when using override queries)
  if (expandWithLlm && !options.overrideQueries) {
    try {
      const { expandQueriesWithLite } = await import("./agents.js");
      const expanded = await expandQueriesWithLite(question, surface);
      if (expanded.length > 0) {
        const existingSet = new Set(queries);
        for (const q of expanded) {
          if (!existingSet.has(q)) {
            queries.push(q);
            existingSet.add(q);
          }
        }
        // Cap total queries
        queries = queries.slice(0, 35);
        logger.info("Merged LLM-expanded queries", { total: queries.length });
      }
    } catch (err) {
      logger.warn("LLM query expansion failed, continuing with keyword queries", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info("Derived search queries", { count: queries.length, queries });

  const globs = LANG_GLOBS[language] ?? LANG_GLOBS["any"];
  const rgOpts: RgSearchOptions = { contextLines, globs };

  // Run all queries in parallel
  const results = await Promise.all(
    queries.map((q) =>
      rgSearch(q, dir, rgOpts).catch((err) => {
        logger.warn("Query failed, skipping", {
          query: q,
          error: err instanceof Error ? err.message : String(err),
        });
        return [] as RgMatch[];
      }),
    ),
  );

  // Flatten, score, and convert to EvidenceHit
  const allHits: EvidenceHit[] = results.flat().map((m) => ({
    path: m.path,
    lineNumber: m.lineNumber,
    text: m.text,
    score: scorePath(m.path),
    submatches: m.submatches,
  }));

  // Dedup by (path, 10-line bucket) — keep highest score per bucket
  const seen = new Map<string, EvidenceHit>();
  for (const hit of allHits) {
    const key = dedupKey(hit);
    const existing = seen.get(key);
    if (!existing || hit.score > existing.score) {
      seen.set(key, hit);
    }
  }

  // Sort by score desc, take top maxHits
  return [...seen.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxHits);
}

/**
 * Count how many of the top hits are from actual code files (not .md/.json).
 * Used for quality gating — if too few code hits, evidence is weak.
 */
export function countCodeHits(hits: EvidenceHit[], topN = 20): number {
  return hits.slice(0, topN).filter(isCodeHit).length;
}
