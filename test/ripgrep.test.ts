import { describe, it, expect } from "vitest";
import { parseRgJsonLines } from "../src/ripgrep.js";

const SAMPLE_RG_OUTPUT = `{"type":"begin","data":{"path":{"text":"src/index.ts"}}}
{"type":"context","data":{"path":{"text":"src/index.ts"},"lines":{"text":"import { foo } from './foo';"},"line_number":1}}
{"type":"match","data":{"path":{"text":"src/index.ts"},"lines":{"text":"export function hello() {"},"line_number":3,"submatches":[{"match":{"text":"hello"},"start":16,"end":21}]}}
{"type":"context","data":{"path":{"text":"src/index.ts"},"lines":{"text":"  return 'world';"},"line_number":4}}
{"type":"match","data":{"path":{"text":"src/utils.ts"},"lines":{"text":"function helloWorld() {"},"line_number":10,"submatches":[{"match":{"text":"hello"},"start":9,"end":14}]}}
{"type":"end","data":{"path":{"text":"src/index.ts"},"stats":{"elapsed":{"secs":0,"nanos":1234},"searches":1}}}
{"type":"summary","data":{"elapsed_total":{"secs":0,"nanos":5678},"stats":{"elapsed":{"secs":0,"nanos":1234},"searches":1,"searches_with_match":1,"bytes_searched":100,"bytes_printed":200,"matched_lines":2,"matches":2}}}`;

describe("parseRgJsonLines", () => {
  it("extracts only match type entries", () => {
    const matches = parseRgJsonLines(SAMPLE_RG_OUTPUT);
    expect(matches).toHaveLength(2);
  });

  it("parses path, lineNumber, text, and submatches correctly", () => {
    const matches = parseRgJsonLines(SAMPLE_RG_OUTPUT);
    expect(matches[0]).toEqual({
      path: "src/index.ts",
      lineNumber: 3,
      text: "export function hello() {",
      submatches: ["hello"],
    });
    expect(matches[1]).toEqual({
      path: "src/utils.ts",
      lineNumber: 10,
      text: "function helloWorld() {",
      submatches: ["hello"],
    });
  });

  it("skips malformed lines gracefully", () => {
    const output = `not json at all
{"type":"match","data":{"path":{"text":"a.ts"},"lines":{"text":"ok"},"line_number":1,"submatches":[]}}
{broken json
`;
    const matches = parseRgJsonLines(output);
    expect(matches).toHaveLength(1);
    expect(matches[0].path).toBe("a.ts");
  });

  it("returns empty array for empty input", () => {
    expect(parseRgJsonLines("")).toEqual([]);
    expect(parseRgJsonLines("\n\n")).toEqual([]);
  });
});
