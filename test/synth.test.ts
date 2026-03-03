import { describe, it, expect } from "vitest";
import { parseSynthesisResponse, SynthesisResponseSchema } from "../src/synth.js";

describe("parseSynthesisResponse", () => {
  it("parses valid JSON response", () => {
    const raw = JSON.stringify({
      answer: "The library uses X to do Y.",
      code: "const x = new X();",
      confidence: 0.85,
      citations: [{ file: "src/index.ts", lines: "1-5", snippet: "code" }],
      nextQueries: ["How does X handle errors?"],
    });

    const result = parseSynthesisResponse(raw);
    expect(result.answer).toBe("The library uses X to do Y.");
    expect(result.confidence).toBe(0.85);
    expect(result.citations).toHaveLength(1);
    expect(result.nextQueries).toHaveLength(1);
  });

  it("extracts JSON from markdown fences", () => {
    const raw = `Here is the analysis:\n\`\`\`json\n${JSON.stringify({
      answer: "test",
      code: "",
      confidence: 0.5,
      citations: [],
      nextQueries: [],
    })}\n\`\`\`\nSome trailing text.`;

    const result = parseSynthesisResponse(raw);
    expect(result.answer).toBe("test");
    expect(result.confidence).toBe(0.5);
  });

  it("extracts JSON embedded in prose", () => {
    const raw = `Some preamble text. {"answer":"extracted","code":"","confidence":0.7,"citations":[],"nextQueries":[]} and more text`;

    const result = parseSynthesisResponse(raw);
    expect(result.answer).toBe("extracted");
    expect(result.confidence).toBe(0.7);
  });

  it("applies defaults for missing optional fields", () => {
    const raw = JSON.stringify({
      answer: "minimal",
      confidence: 0.6,
    });

    const result = parseSynthesisResponse(raw);
    expect(result.answer).toBe("minimal");
    expect(result.code).toBe("");
    expect(result.citations).toEqual([]);
    expect(result.nextQueries).toEqual([]);
  });

  it("throws on completely invalid JSON", () => {
    expect(() => parseSynthesisResponse("not json at all")).toThrow();
  });

  it("throws on valid JSON missing required fields", () => {
    // Missing 'answer' — the one truly required field
    expect(() =>
      parseSynthesisResponse(JSON.stringify({ code: "hello" })),
    ).toThrow();
  });

  it("clamps confidence to 0-1 range", () => {
    expect(() =>
      parseSynthesisResponse(
        JSON.stringify({ answer: "test", confidence: 1.5 }),
      ),
    ).toThrow();
    expect(() =>
      parseSynthesisResponse(
        JSON.stringify({ answer: "test", confidence: -0.1 }),
      ),
    ).toThrow();
  });

  it("handles malformed key 'co de' via key normalization", () => {
    const raw = JSON.stringify({
      answer: "has malformed key",
      "co de": "const x = 1;",
      confidence: 0.8,
    });
    // The JSON itself is valid, but key is wrong. normalizeKeys fixes it.
    const result = parseSynthesisResponse(raw);
    expect(result.answer).toBe("has malformed key");
    expect(result.code).toBe("const x = 1;");
  });

  it("handles JSON with trailing commas via jsonrepair", () => {
    const raw = '{"answer":"trailing comma","confidence":0.6,"code":"",}';
    const result = parseSynthesisResponse(raw);
    expect(result.answer).toBe("trailing comma");
  });

  it("extracts largest JSON when multiple objects are present", () => {
    const small = '{"x":1}';
    const large = '{"answer":"the real one","code":"","confidence":0.5}';
    const raw = `Fragment: ${small}\nActual response: ${large}`;
    const result = parseSynthesisResponse(raw);
    expect(result.answer).toBe("the real one");
  });

  it("defaults confidence to 0 when missing", () => {
    const raw = JSON.stringify({ answer: "no confidence field" });
    const result = parseSynthesisResponse(raw);
    expect(result.confidence).toBe(0);
  });

  it("includes notes field with default", () => {
    const raw = JSON.stringify({ answer: "test", confidence: 0.5 });
    const result = parseSynthesisResponse(raw);
    expect(result.notes).toBe("");
  });
});

describe("SynthesisResponseSchema", () => {
  it("validates a complete response", () => {
    const input = {
      answer: "test",
      code: "x()",
      confidence: 0.8,
      citations: [{ file: "a.ts", lines: "1-5", snippet: "code" }],
      nextQueries: ["q"],
      notes: "",
    };
    const result = SynthesisResponseSchema.parse(input);
    expect(result.answer).toBe("test");
  });

  it("applies defaults for optional fields", () => {
    const result = SynthesisResponseSchema.parse({ answer: "minimal" });
    expect(result.code).toBe("");
    expect(result.confidence).toBe(0);
    expect(result.citations).toEqual([]);
    expect(result.nextQueries).toEqual([]);
    expect(result.notes).toBe("");
  });
});
