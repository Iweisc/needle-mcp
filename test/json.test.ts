import { describe, it, expect } from "vitest";
import {
  extractJsonObject,
  parseJsonLenient,
  normalizeKeys,
} from "../src/util/json.js";

// ── extractJsonObject ───────────────────────────────────────────────────────

describe("extractJsonObject", () => {
  it("extracts a plain JSON object", () => {
    const result = extractJsonObject('{"a":1}');
    expect(result).toBe('{"a":1}');
  });

  it("extracts JSON from prose before and after", () => {
    const input = 'Here is the result:\n{"answer":"hello","confidence":0.8}\nHope that helps!';
    const result = extractJsonObject(input);
    expect(result).toBe('{"answer":"hello","confidence":0.8}');
  });

  it("extracts JSON from markdown fences with surrounding prose", () => {
    const input = 'Some preamble.\n```json\n{"answer":"test"}\n```\nTrailing.';
    // The extractor finds the balanced object inside the fences
    const result = extractJsonObject(input);
    expect(result).toBe('{"answer":"test"}');
  });

  it("chooses the largest balanced JSON object when multiple exist", () => {
    const small = '{"x":1}';
    const large = '{"answer":"detailed","code":"const x = 1;","confidence":0.9}';
    const input = `First: ${small}\nSecond: ${large}\nDone.`;
    const result = extractJsonObject(input);
    expect(result).toBe(large);
  });

  it("handles nested braces correctly", () => {
    const json = '{"a":{"b":{"c":1}},"d":2}';
    const result = extractJsonObject(`prefix ${json} suffix`);
    expect(result).toBe(json);
  });

  it("handles braces inside strings", () => {
    const json = '{"code":"function() { return {}; }","x":1}';
    const result = extractJsonObject(json);
    expect(result).toBe(json);
  });

  it("returns null when no braces exist", () => {
    expect(extractJsonObject("no json here")).toBeNull();
    expect(extractJsonObject("")).toBeNull();
  });

  it("skips unbalanced braces that don't form valid JSON", () => {
    // A lone opening brace that doesn't close
    const input = "broken { but here is real: {\"a\":1}";
    const result = extractJsonObject(input);
    expect(result).toBe('{"a":1}');
  });
});

// ── parseJsonLenient ────────────────────────────────────────────────────────

describe("parseJsonLenient", () => {
  it("parses valid JSON directly", () => {
    const result = parseJsonLenient('{"answer":"ok","confidence":0.5}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ answer: "ok", confidence: 0.5 });
    }
  });

  it("extracts and parses JSON from prose", () => {
    const input = 'Here is my analysis:\n{"answer":"found it","confidence":0.9}\nEnd.';
    const result = parseJsonLenient(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as Record<string, unknown>).answer).toBe("found it");
    }
  });

  it("repairs JSON with trailing commas", () => {
    const input = '{"answer":"test","confidence":0.5,}';
    const result = parseJsonLenient(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as Record<string, unknown>).answer).toBe("test");
    }
  });

  it("repairs JSON with single quotes", () => {
    const input = "{'answer':'hello','confidence':0.7}";
    const result = parseJsonLenient(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as Record<string, unknown>).answer).toBe("hello");
    }
  });

  it("repairs JSON with unquoted keys", () => {
    const input = '{answer:"hello",confidence:0.7}';
    const result = parseJsonLenient(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as Record<string, unknown>).answer).toBe("hello");
    }
  });

  it("returns error for completely non-JSON input", () => {
    const result = parseJsonLenient("This is just plain text with no JSON at all.");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Could not parse");
    }
  });

  it("handles empty string", () => {
    const result = parseJsonLenient("");
    expect(result.ok).toBe(false);
  });
});

// ── normalizeKeys ───────────────────────────────────────────────────────────

describe("normalizeKeys", () => {
  it("strips whitespace from keys", () => {
    const input = { "co de": "x = 1", "an swer": "hello" };
    const result = normalizeKeys(input) as Record<string, unknown>;
    expect(result).toHaveProperty("code", "x = 1");
    // "answer" maps via alias
    expect(result).toHaveProperty("answer", "hello");
  });

  it("normalizes 'co de' to 'code'", () => {
    const input = { "co de": "snippet", answer: "hello", confidence: 0.5 };
    const result = normalizeKeys(input) as Record<string, unknown>;
    expect(result.code).toBe("snippet");
  });

  it("normalizes 'co_de' to 'code'", () => {
    const input = { co_de: "snippet" };
    const result = normalizeKeys(input) as Record<string, unknown>;
    expect(result.code).toBe("snippet");
  });

  it("normalizes 'lineNu mber' to 'lineNumber'", () => {
    const input = { "lineNu mber": 42 };
    const result = normalizeKeys(input) as Record<string, unknown>;
    expect(result.lineNumber).toBe(42);
  });

  it("normalizes 'line_number' to 'lineNumber'", () => {
    const input = { line_number: 10 };
    const result = normalizeKeys(input) as Record<string, unknown>;
    expect(result.lineNumber).toBe(10);
  });

  it("normalizes 'nextQueries' variants", () => {
    const input = { "next Queries": ["q1"], next_queries: ["q2"] };
    const result = normalizeKeys(input) as Record<string, unknown>;
    // Both normalize to the same key; last write wins
    expect(result).toHaveProperty("nextQueries");
  });

  it("recursively normalizes nested objects", () => {
    const input = {
      citations: [
        { "fi le": "a.ts", "li nes": "1-5", snippet: "code" },
      ],
    };
    const result = normalizeKeys(input) as {
      citations: Array<Record<string, unknown>>;
    };
    expect(result.citations[0]).toHaveProperty("file", "a.ts");
    expect(result.citations[0]).toHaveProperty("lines", "1-5");
  });

  it("preserves unknown keys that don't collide", () => {
    const input = { answer: "hi", customField: 42 };
    const result = normalizeKeys(input) as Record<string, unknown>;
    expect(result.answer).toBe("hi");
    expect(result.customField).toBe(42);
  });

  it("handles non-object values (passthrough)", () => {
    expect(normalizeKeys("hello")).toBe("hello");
    expect(normalizeKeys(42)).toBe(42);
    expect(normalizeKeys(null)).toBeNull();
    expect(normalizeKeys(undefined)).toBeUndefined();
  });

  it("handles arrays", () => {
    const input = [{ "co de": "a" }, { "co de": "b" }];
    const result = normalizeKeys(input) as Array<Record<string, unknown>>;
    expect(result[0].code).toBe("a");
    expect(result[1].code).toBe("b");
  });
});
