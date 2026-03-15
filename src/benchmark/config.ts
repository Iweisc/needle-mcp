export function readCodexBaselineModel(
  env: Partial<Pick<NodeJS.ProcessEnv, "NEEDLE_BENCH_CODEX_MODEL">>,
): string {
  return env.NEEDLE_BENCH_CODEX_MODEL?.trim() || "gpt-5.4";
}
