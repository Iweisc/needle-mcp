import { jsonrepair } from "jsonrepair";

// ── JSON extraction ─────────────────────────────────────────────────────────

/**
 * Find the largest balanced JSON object in `text`.
 * Scans for every `{`, tracks balanced braces, and returns the longest
 * substring that either parses directly or can be repaired.
 */
export function extractJsonObject(text: string): string | null {
  let best: string | null = null;

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let j = i; j < text.length; j++) {
      const ch = text[j];

      if (escape) {
        escape = false;
        continue;
      }

      if (ch === "\\" && inString) {
        escape = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(i, j + 1);
          if (!best || candidate.length > best.length) {
            // Verify it's plausibly JSON (parses or can be repaired)
            if (canParse(candidate)) {
              best = candidate;
            }
          }
          break;
        }
      }
    }
  }

  return best;
}

/** Quick check: can this string be parsed (directly or via repair)? */
function canParse(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    try {
      JSON.parse(jsonrepair(s));
      return true;
    } catch {
      return false;
    }
  }
}

// ── Lenient parsing ─────────────────────────────────────────────────────────

export type ParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/**
 * Try every reasonable strategy to extract a valid JSON value from `text`:
 * 1. Extract the largest balanced JSON object.
 * 2. Try `JSON.parse` on the extraction.
 * 3. Try `jsonrepair` → `JSON.parse`.
 * 4. Return an error result (never throws).
 */
export function parseJsonLenient(text: string): ParseResult {
  // Step 1: try to extract a balanced object
  const extracted = extractJsonObject(text);
  const candidate = extracted ?? text;

  // Step 2: direct parse
  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch {
    // continue
  }

  // Step 3: repair then parse
  try {
    const repaired = jsonrepair(candidate);
    const value = JSON.parse(repaired);
    if (isObject(value)) return { ok: true, value };
  } catch {
    // continue
  }

  // If extraction found something, also try repair on the raw text as a last resort
  if (extracted) {
    try {
      const repaired = jsonrepair(text);
      const value = JSON.parse(repaired);
      if (isObject(value)) return { ok: true, value };
    } catch {
      // continue
    }
  }

  return { ok: false, error: "Could not parse JSON after extraction and repair" };
}

/** True if the value is a non-null, non-array object (i.e. a JSON object). */
function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ── Key normalization ───────────────────────────────────────────────────────

/** Map of common key corruptions → canonical schema key. */
const KEY_ALIASES: Record<string, string> = {
  code: "code",
  co_de: "code",
  linenumber: "lineNumber",
  line_number: "lineNumber",
  nextqueries: "nextQueries",
  next_queries: "nextQueries",
  confidence: "confidence",
  answer: "answer",
  citations: "citations",
  notes: "notes",
};

/**
 * Recursively normalize object keys:
 * - Strip internal whitespace: `"co de"` → `"code"`
 * - Map known aliases to canonical keys.
 */
export function normalizeKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(normalizeKeys);
  }

  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const stripped = key.replace(/\s+/g, "");
      const lower = stripped.toLowerCase();
      const canonical = KEY_ALIASES[lower] ?? stripped;
      result[canonical] = normalizeKeys(value);
    }
    return result;
  }

  return obj;
}
