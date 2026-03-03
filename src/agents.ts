import type { EvidenceHit, DeepReadFile } from "./types.js";
import { converseWithBedrock } from "./bedrock.js";
import { logger } from "./util/log.js";
import {
  LITE_TIMEOUT,
  LITE_MAX_TOKENS,
  RERANK_BATCH_SIZE,
  RELEVANCE_WEIGHT,
  MAX_EXPANDED_QUERIES,
  GAP_MAX_QUERIES,
  GAP_ANALYSIS_TIMEOUT,
} from "./util/limits.js";

// ── Query expansion agent ────────────────────────────────────────────────────

const EXPAND_SYSTEM_PROMPT = `You are a code search query generator. Given a natural-language question about a codebase, produce ripgrep search patterns that find relevant source code.

Focus on SEMANTIC connections the question implies but does NOT literally state:
- If the question asks "how does X work", include patterns for internal helpers, config parsing, state transitions
- If the question mentions a feature, include patterns for related lifecycle hooks, error paths, edge cases
- Think about what a developer would grep for when debugging or understanding the feature

Return a JSON array of strings. Each string is a valid ripgrep pattern.
Example: ["handleRequest","routeMatch","paramExtract","wildcard.*path"]

RULES:
- Return ONLY the JSON array, no markdown fences, no explanation
- 5-10 patterns, each under 60 characters
- Prefer specific identifiers over generic words
- Include regex patterns where useful (e.g. "on[A-Z]\\w+" for event handlers)`;

/**
 * Ask Nova Lite to generate semantic ripgrep patterns that complement keyword queries.
 * Returns [] on any failure (graceful degradation).
 */
export async function expandQueriesWithLite(
  question: string,
  surface?: { symbols: string[] },
): Promise<string[]> {
  try {
    const symbolHint = surface?.symbols?.length
      ? `\nKnown API symbols: ${surface.symbols.slice(0, 20).join(", ")}`
      : "";

    const userMessage = `Question: ${question}${symbolHint}\n\nGenerate 5-10 ripgrep search patterns.`;

    const raw = await converseWithBedrock(EXPAND_SYSTEM_PROMPT, userMessage, {
      model: "nova-lite",
      timeout: LITE_TIMEOUT,
      maxTokens: LITE_MAX_TOKENS,
      temperature: 0.3,
    });

    // Strip markdown fences if present
    const cleaned = raw.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "").trim();

    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];

    // Filter and cap
    const queries = parsed
      .filter((q): q is string => typeof q === "string" && q.length > 0)
      .slice(0, MAX_EXPANDED_QUERIES);

    logger.info("Nova Lite expanded queries", { count: queries.length, queries });
    return queries;
  } catch (err) {
    logger.warn("Query expansion with Nova Lite failed, skipping", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// ── Evidence reranking agent ─────────────────────────────────────────────────

const RERANK_SYSTEM_PROMPT = `You are a code relevance scorer. Given a question and a batch of code evidence snippets, rate each snippet's relevance to answering the question.

Return a JSON array of numbers (0.0 to 1.0), one per snippet, in the SAME order as the input.
- 1.0 = directly answers the question
- 0.7 = highly relevant supporting code
- 0.4 = somewhat relevant
- 0.1 = barely relevant
- 0.0 = not relevant at all

RULES:
- Return ONLY the JSON array of numbers, no markdown, no explanation
- Array length MUST match the number of input snippets exactly`;

/**
 * Use Nova Lite to rerank evidence hits by relevance to the question.
 * Splits hits into batches and runs all batches in parallel.
 * Combined score: pathScore + (relevanceScore * RELEVANCE_WEIGHT)
 * Falls back to neutral 0.5 score per hit if a batch fails.
 */
export async function rerankEvidenceWithLite(
  question: string,
  hits: EvidenceHit[],
): Promise<EvidenceHit[]> {
  if (hits.length === 0) return [];

  // Split into batches
  const batches: EvidenceHit[][] = [];
  for (let i = 0; i < hits.length; i += RERANK_BATCH_SIZE) {
    batches.push(hits.slice(i, i + RERANK_BATCH_SIZE));
  }

  // Run all batches in parallel
  const batchResults = await Promise.all(
    batches.map((batch, batchIdx) => rerankBatch(question, batch, batchIdx)),
  );

  // Flatten scores and apply to hits
  const allScores = batchResults.flat();
  return hits.map((hit, i) => ({
    ...hit,
    score: hit.score + (allScores[i] ?? 0.5) * RELEVANCE_WEIGHT,
  }));
}

async function rerankBatch(
  question: string,
  batch: EvidenceHit[],
  batchIdx: number,
): Promise<number[]> {
  try {
    const snippets = batch
      .map((h, i) => `[${i}] ${h.path}:${h.lineNumber}\n${h.text}`)
      .join("\n\n");

    const userMessage = `Question: ${question}\n\n## Evidence Snippets (${batch.length} total)\n\n${snippets}`;

    const raw = await converseWithBedrock(RERANK_SYSTEM_PROMPT, userMessage, {
      model: "nova-lite",
      timeout: LITE_TIMEOUT,
      maxTokens: LITE_MAX_TOKENS,
      temperature: 0.1,
    });

    const cleaned = raw.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);

    if (!Array.isArray(parsed) || parsed.length !== batch.length) {
      logger.warn("Rerank batch returned wrong length", {
        batchIdx,
        expected: batch.length,
        got: Array.isArray(parsed) ? parsed.length : "not-array",
      });
      return batch.map(() => 0.5);
    }

    const scores = parsed.map((v) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
    });

    logger.info("Rerank batch completed", { batchIdx, scores });
    return scores;
  } catch (err) {
    logger.warn("Rerank batch failed, using neutral scores", {
      batchIdx,
      error: err instanceof Error ? err.message : String(err),
    });
    return batch.map(() => 0.5);
  }
}

// ── Gap analysis agent ───────────────────────────────────────────────────────

const GAP_ANALYSIS_SYSTEM_PROMPT = `You are a code evidence gap analyzer. Given a question about a codebase and the evidence already collected (file snippets and full file reads), identify what is MISSING to fully answer the question.

Think about:
- Are there referenced functions/classes/types whose definitions we haven't found?
- Are there config objects, option interfaces, or error handling paths not yet covered?
- Are there imported modules we haven't seen the source of?
- Are there test files that would show usage patterns?

Return a JSON object:
{
  "gaps": ["brief description of each gap"],
  "queries": ["ripgrep_pattern_1", "ripgrep_pattern_2"]
}

RULES:
- Return ONLY the JSON object, no markdown fences, no explanation
- 3-8 queries, each under 60 characters
- Focus on SPECIFIC identifiers and patterns, not generic words
- Do NOT repeat patterns that would match already-collected evidence`;

/**
 * Ask Nova Lite to identify gaps in collected evidence and suggest
 * targeted ripgrep queries to fill them.
 * Returns [] on any failure (graceful degradation).
 */
export async function identifyGapsWithLite(
  question: string,
  evidence: EvidenceHit[],
  deepReads: DeepReadFile[],
): Promise<string[]> {
  try {
    const deepReadSummary = deepReads.length > 0
      ? `\nFull files already read:\n${deepReads.map((f) => `  - ${f.path}`).join("\n")}`
      : "";

    const snippetSummary = evidence.slice(0, 15)
      .map((h) => `  - ${h.path}:${h.lineNumber} (${h.submatches.join(", ")})`)
      .join("\n");

    const userMessage = `Question: ${question}
${deepReadSummary}

Evidence snippets collected (top 15):
${snippetSummary}

What specific code patterns or symbols should we search for to find the MISSING information needed to fully answer the question?`;

    const raw = await converseWithBedrock(GAP_ANALYSIS_SYSTEM_PROMPT, userMessage, {
      model: "nova-lite",
      timeout: GAP_ANALYSIS_TIMEOUT,
      maxTokens: LITE_MAX_TOKENS,
      temperature: 0.2,
    });

    const cleaned = raw.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);

    // Accept either {queries: [...]} or a plain array
    const queries: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.queries)
        ? parsed.queries
        : [];

    const result = queries
      .filter((q): q is string => typeof q === "string" && q.length > 0)
      .slice(0, GAP_MAX_QUERIES);

    logger.info("Gap analysis completed", { count: result.length, queries: result });
    return result;
  } catch (err) {
    logger.warn("Gap analysis with Nova Lite failed, skipping", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
