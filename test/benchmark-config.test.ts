import { describe, expect, it } from "vitest";
import { readCodexBaselineModel } from "../src/benchmark/config.js";

describe("readCodexBaselineModel", () => {
  it("defaults to gpt-5.4", () => {
    expect(readCodexBaselineModel({})).toBe("gpt-5.4");
  });

  it("respects NEEDLE_BENCH_CODEX_MODEL overrides", () => {
    expect(
      readCodexBaselineModel({
        NEEDLE_BENCH_CODEX_MODEL: "gpt-5.3-codex",
      }),
    ).toBe("gpt-5.3-codex");
  });
});
