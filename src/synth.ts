import { z } from "zod";
import type {
  EvidenceHit,
  WebEvidence,
  NeedleAskOutput,
  DeepReadFile,
} from "./types.js";
import { converseWithBedrock } from "./bedrock.js";
import { logger } from "./util/log.js";
import { LOW_CONFIDENCE_THRESHOLD } from "./util/limits.js";
import { countCodeHits } from "./evidence.js";
import { parseJsonLenient, normalizeKeys } from "./util/json.js";

// ── Zod schema for synthesis output validation ────────────────────────────────

const CitationSchema = z.object({
  file: z.string().default(""),
  lines: z.string().default(""),
  snippet: z.string().default(""),
});

export const SynthesisResponseSchema = z.object({
  answer: z.string(),
  code: z.string().default(""),
  confidence: z.number().min(0).max(1).default(0),
  citations: z.array(CitationSchema).default([]),
  nextQueries: z.array(z.string()).default([]),
  notes: z.string().default(""),
});

type SynthesisResponse = z.infer<typeof SynthesisResponseSchema>;

// ── Quality gating thresholds ─────────────────────────────────────────────────

const MIN_CODE_HITS_FOR_SYNTHESIS = 5;

// ── Prompts ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert code analyst. You answer questions about libraries and codebases by studying source code evidence.

RULES:
- Ground your answer ONLY in the provided source files and evidence snippets.
- Full source files are the PRIMARY context — study them thoroughly before the snippets.
- Cite evidence using [file:lines] format.
- If evidence is insufficient, say so honestly and set confidence low.
- Return ONLY a valid JSON object with this exact shape (no markdown fences, no extra text):
{
  "answer": "detailed answer with [file:lines] citations",
  "code": "example code snippet if applicable, otherwise empty string",
  "confidence": 0.0-1.0,
  "citations": [{"file": "path", "lines": "1-5", "snippet": "relevant code"}],
  "nextQueries": ["follow-up question 1", "follow-up question 2"]
}

CRITICAL: Output must be ONLY the JSON object. No prose before or after. No markdown fences.`;

const REPAIR_SYSTEM_PROMPT = `You are a JSON repair bot. You receive malformed or partially valid JSON and output ONLY valid JSON matching the requested schema. No markdown fences. No extra keys. No explanation.`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatEvidence(
  hits: EvidenceHit[],
  webHits: WebEvidence[],
  deepReads: DeepReadFile[] = [],
): string {
  const parts: string[] = [];

  if (deepReads.length > 0) {
    parts.push("## Full Source Files (most relevant)\n");
    for (const f of deepReads) {
      parts.push(`### ${f.path}`);
      parts.push("```");
      parts.push(f.content);
      parts.push("```");
      parts.push("");
    }
  }

  if (hits.length > 0) {
    parts.push("## Supporting Evidence Snippets\n");
    for (const h of hits) {
      parts.push(`[${h.path}:${h.lineNumber}] (score: ${h.score.toFixed(1)})`);
      parts.push(h.text);
      parts.push("");
    }
  }

  if (webHits.length > 0) {
    parts.push("## Web Evidence\n");
    for (const w of webHits) {
      parts.push(`[${w.title}](${w.url})`);
      parts.push(w.snippet);
      parts.push("");
    }
  }

  return parts.join("\n");
}

/** Truncate a string, appending "…" if it exceeds maxLen. */
function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + "…";
}

// ── Robust JSON pipeline ────────────────────────────────────────────────────

/**
 * Parse and validate synthesis response through the robust pipeline:
 * 1. Extract + lenient parse (with jsonrepair)
 * 2. Normalize corrupted keys
 * 3. Validate through Zod schema
 *
 * Returns the parsed response or throws with a descriptive error.
 */
export function parseSynthesisResponse(raw: string): SynthesisResponse {
  const result = parseJsonLenient(raw);
  if (!result.ok) {
    throw new Error(`JSON parse failed: ${result.error}`);
  }

  const normalized = normalizeKeys(result.value);
  return SynthesisResponseSchema.parse(normalized);
}

// ── LLM repair fallback ─────────────────────────────────────────────────────

/**
 * Ask the LLM to repair a malformed JSON response.
 * Returns a parsed SynthesisResponse or null if repair also fails.
 */
async function repairWithLlm(rawOutput: string): Promise<SynthesisResponse | null> {
  const truncatedInput = truncate(rawOutput, 4000);

  const repairPrompt = `The following text was supposed to be a JSON object but is malformed. Output ONLY valid JSON matching this exact schema. No markdown. No extra keys. Keep meaning as close as possible. If a field is missing, use these defaults: code="", confidence=0, citations=[], nextQueries=[], notes="".

Schema:
{
  "answer": "string",
  "code": "string",
  "confidence": 0.0-1.0,
  "citations": [{"file": "string", "lines": "string", "snippet": "string"}],
  "nextQueries": ["string"],
  "notes": "string"
}

Malformed input:
${truncatedInput}`;

  try {
    const repairResponse = await converseWithBedrock(
      REPAIR_SYSTEM_PROMPT,
      repairPrompt,
      { maxTokens: 4096, model: "nova-premier" },
    );

    const result = parseJsonLenient(repairResponse);
    if (!result.ok) return null;

    const normalized = normalizeKeys(result.value);
    return SynthesisResponseSchema.parse(normalized);
  } catch (err) {
    logger.warn("LLM repair failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── Main synthesis ────────────────────────────────────────────────────────────

export async function synthesizeAnswer(
  question: string,
  codeEvidence: EvidenceHit[],
  webEvidence: WebEvidence[],
  deepReads: DeepReadFile[] = [],
): Promise<NeedleAskOutput> {
  // Quality gate: check if we have enough code evidence
  // Deep reads count as strong evidence — skip gate if we have them
  const codeHitCount = countCodeHits(codeEvidence);
  if (deepReads.length === 0 && codeHitCount < MIN_CODE_HITS_FOR_SYNTHESIS && webEvidence.length === 0) {
    logger.warn("Evidence quality gate: insufficient code hits", {
      codeHits: codeHitCount,
      threshold: MIN_CODE_HITS_FOR_SYNTHESIS,
      totalHits: codeEvidence.length,
    });
    return gatedOutput(question, codeEvidence);
  }

  const evidenceText = formatEvidence(codeEvidence, webEvidence, deepReads);
  const userMessage = `Question: ${question}\n\n${evidenceText}`;

  // Try synthesis with one automatic retry on parse failure
  let lastRaw = "";
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const rawResponse = await converseWithBedrock(SYSTEM_PROMPT, userMessage, {
        model: "nova-premier",
      });
      lastRaw = rawResponse;

      const parsed = parseSynthesisResponse(rawResponse);

      const output: NeedleAskOutput = {
        answer: parsed.answer,
        code: parsed.code,
        confidence: parsed.confidence,
        citations: parsed.citations,
        evidence: { hits: codeEvidence },
        nextQueries: parsed.nextQueries,
        notes: "",
      };

      if (output.confidence < LOW_CONFIDENCE_THRESHOLD) {
        output.notes =
          "Low confidence — evidence may be insufficient. Consider refining your question or providing more context.";
      }

      logger.info("Synthesis succeeded", { attempt, confidence: output.confidence });
      return output;
    } catch (err) {
      lastError = err;
      if (attempt === 0) {
        logger.warn("Synthesis attempt failed, retrying", {
          attempt,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Both attempts failed — try LLM repair as last resort
  logger.warn("Attempting LLM repair fallback", {
    rawLength: lastRaw.length,
    rawPreview: truncate(lastRaw, 200),
  });

  const repaired = await repairWithLlm(lastRaw);
  if (repaired) {
    logger.info("LLM repair succeeded", { confidence: repaired.confidence });
    return {
      answer: repaired.answer,
      code: repaired.code,
      confidence: repaired.confidence,
      citations: repaired.citations,
      evidence: { hits: codeEvidence },
      nextQueries: repaired.nextQueries,
      notes: "Response was repaired by LLM fallback; original output was malformed.",
    };
  }

  // Everything failed — safe failure object
  const errMsg = lastError instanceof Error ? lastError.message : String(lastError);
  logger.error("Synthesis failed after all repair attempts", { error: errMsg });
  return safeFailureOutput(codeEvidence, question, errMsg, lastRaw);
}

/** Output when evidence quality gate blocks synthesis */
function gatedOutput(
  question: string,
  hits: EvidenceHit[],
): NeedleAskOutput {
  const suggestedQueries = [
    `What functions/classes does this library export?`,
    `What are the main entry points of this library?`,
    question,
  ];

  return {
    answer:
      "Insufficient code evidence to provide a grounded answer. " +
      `Only ${countCodeHits(hits)} code hits found in the top results (minimum ${MIN_CODE_HITS_FOR_SYNTHESIS} required). ` +
      "The evidence was mostly documentation/markdown rather than actual source code. " +
      "Try a more specific question targeting known API symbols, or check the suggested follow-up queries.",
    code: "",
    confidence: 0.1,
    citations: [],
    evidence: { hits },
    nextQueries: suggestedQueries,
    notes: "Evidence quality gate: too few code hits to synthesize reliably.",
  };
}

/** Safe failure object that always returns valid output with confidence=0. */
function safeFailureOutput(
  hits: EvidenceHit[],
  question: string,
  errorMsg: string,
  rawOutput: string,
): NeedleAskOutput {
  return {
    answer: "Synthesis failed: could not produce valid JSON",
    code: "",
    confidence: 0,
    citations: [],
    evidence: { hits },
    nextQueries: [question],
    notes: truncate(
      `Parse error: ${errorMsg}. Raw output preview: ${rawOutput}`,
      2000,
    ),
  };
}
