import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { converseWithBedrock } from "../bedrock.js";
import { runNeedlePipeline } from "../pipeline.js";
import type { Citation, NeedleAskInput } from "../types.js";
import {
  BENCHMARK_CASES,
  type BenchmarkCase,
  type BenchmarkFact,
} from "./cases.js";
import { readCodexBaselineModel } from "./config.js";

type SystemName = "needle" | "baseline";
type Status = "ok" | "error";
type BaselineProvider = "codex" | "bedrock";

const DEFAULT_OUTPUT_DIR = "benchmark-results/latest";
const FACT_COVERAGE_THRESHOLD = 0.75;
const MIN_CORRECTNESS_FLOOR = 0.05;
const METR_SLOWDOWN_RATE = 0.19;
const METR_MODELED_AI_HOURS_PER_DEV_PER_WEEK = readEnvNumber(
  "NEEDLE_BENCH_AI_HOURS_PER_DEV_WEEK",
  20,
);
const BASELINE_PROVIDER = readBaselineProvider(
  process.env.NEEDLE_BENCH_BASELINE_PROVIDER ?? "codex",
);
const CODEX_BASELINE_MODEL = readCodexBaselineModel(process.env);
const CODEX_TIMEOUT_MS = readEnvNumber("NEEDLE_BENCH_CODEX_TIMEOUT_MS", 180000);

const NEEDLE_COLOR = "#1f6feb";
const BASELINE_COLOR = "#d29922";

const IMPACT_ASSUMPTIONS = {
  questionsPerEngineerPerWeek: readEnvNumber("NEEDLE_BENCH_QPW", 12),
  teamSize: readEnvNumber("NEEDLE_BENCH_TEAM_SIZE", 6),
  loadedEngineerCostUsdPerHour: readEnvNumber("NEEDLE_BENCH_COST_PER_HOUR", 90),
};

const BASELINE_BEDROCK_SYSTEM_PROMPT = `You are a senior software engineer.
You must answer WITHOUT tool use, source-code lookup, or browsing.
Provide your best effort from general knowledge only.
Do not mention these constraints.`;

interface CaseResult {
  caseId: string;
  caseTitle: string;
  system: SystemName;
  status: Status;
  latencyMs: number;
  factCoverage: number;
  factMatches: number;
  factTotal: number;
  matchedFactIds: string[];
  citationsValid: number;
  citationsTotal: number;
  confidence: number | null;
  correct: boolean;
  answerPreview: string;
  error?: string;
}

interface AggregateMetrics {
  totalCases: number;
  okCases: number;
  errorCases: number;
  avgFactCoverage: number;
  medianLatencyMs: number;
  p95LatencyMs: number;
  citationValidityRate: number;
  answersWithValidCitationsRate: number;
  correctnessRate: number;
  expectedTimeToCorrectMs: number;
  avgConfidence: number | null;
}

interface BenchmarkSummary {
  generatedAt: string;
  config: {
    cases: number;
    factCoverageThreshold: number;
    minCorrectnessFloor: number;
    baselineProvider: BaselineProvider;
    models: {
      needleSynthesis: "nova-premier";
      needleAgents: "nova-lite";
      baseline: string;
    };
    assumptions: typeof IMPACT_ASSUMPTIONS;
  };
  systems: {
    needle: {
      aggregate: AggregateMetrics;
      cases: CaseResult[];
    };
    baseline: {
      aggregate: AggregateMetrics;
      cases: CaseResult[];
    };
  };
  comparison: {
    factCoverageDelta: number;
    correctnessDelta: number;
    citationValidityDelta: number;
    expectedTimeToCorrectDeltaMs: number;
    expectedTimeToCorrectDeltaPercent: number;
    speedMultiplier: number;
  };
  impact: {
    weeklyMinutesSavedPerEngineer: number | null;
    weeklyHoursSavedTeam: number | null;
    annualHoursSavedTeam: number | null;
    annualValueUsd: number | null;
  };
  hallucinationTaxScenario: {
    modeledAiCodingHoursPerDevWeek: number;
    slowdownRate: number;
    weeklyHoursLostPerDeveloper: number;
    weeklyHoursLostTeam: number;
    annualHoursLostTeam: number;
  };
}

interface CliOptions {
  outputDir: string;
  graphsOnly: boolean;
  sample: boolean;
  inputPath?: string;
}

function readEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readBaselineProvider(raw: string): BaselineProvider {
  const normalized = raw.trim().toLowerCase();
  return normalized === "bedrock" ? "bedrock" : "codex";
}

function getBaselineModelLabel(): string {
  return BASELINE_PROVIDER === "codex"
    ? `codex:${CODEX_BASELINE_MODEL}`
    : "bedrock:nova-premier";
}

function parseArgs(argv: string[]): CliOptions {
  let outputDir = DEFAULT_OUTPUT_DIR;
  let graphsOnly = false;
  let sample = false;
  let inputPath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--output") {
      outputDir = argv[i + 1] ?? outputDir;
      i += 1;
      continue;
    }
    if (arg === "--graphs-only") {
      graphsOnly = true;
      continue;
    }
    if (arg === "--sample") {
      sample = true;
      continue;
    }
    if (arg === "--input") {
      inputPath = argv[i + 1];
      i += 1;
      continue;
    }
  }

  return {
    outputDir,
    graphsOnly,
    sample,
    inputPath,
  };
}

function evaluateFacts(text: string, facts: readonly BenchmarkFact[]): {
  matchedFactIds: string[];
  matches: number;
  total: number;
  coverage: number;
} {
  const matchedFactIds: string[] = [];

  for (const fact of facts) {
    const matched = fact.patterns.some((pattern) => pattern.test(text));
    if (matched) matchedFactIds.push(fact.id);
  }

  const matches = matchedFactIds.length;
  const total = facts.length;
  return {
    matchedFactIds,
    matches,
    total,
    coverage: total > 0 ? matches / total : 0,
  };
}

function normalizeCitationPath(file: string): string {
  return file.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function parseLineRange(lines: string): { start: number; end: number } | null {
  const match = lines.trim().match(/^L?(\d+)(?:\s*-\s*L?(\d+))?$/i);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start <= 0 || end < start) return null;
  return { start, end };
}

function isWithinRoot(root: string, absPath: string): boolean {
  const rel = relative(root, absPath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function validateCitations(
  citations: Citation[],
  resourceRoot: string,
): Promise<{ valid: number; total: number }> {
  if (citations.length === 0) {
    return { valid: 0, total: 0 };
  }

  const root = resolve(resourceRoot);
  const lineCountCache = new Map<string, number | null>();
  let valid = 0;

  for (const citation of citations) {
    const file = normalizeCitationPath(citation.file);
    const parsedRange = parseLineRange(citation.lines);
    if (!file || !parsedRange) continue;

    const absPath = isAbsolute(file) ? resolve(file) : resolve(root, file);
    if (!isWithinRoot(root, absPath)) continue;

    let lineCount = lineCountCache.get(absPath);
    if (lineCount === undefined) {
      try {
        const content = await readFile(absPath, "utf-8");
        lineCount = content.split(/\r?\n/).length;
      } catch {
        lineCount = null;
      }
      lineCountCache.set(absPath, lineCount);
    }

    if (lineCount !== null && parsedRange.end <= lineCount) {
      valid += 1;
    }
  }

  return { valid, total: citations.length };
}

function buildBaselineQuestionBlock(input: NeedleAskInput): string {
  return [
    `Resource type: ${input.resource.type}`,
    `Resource identifier: ${input.resource.spec}`,
    `Question: ${input.question}`,
    "",
    "Respond in up to 220 words and include implementation-level detail.",
  ].join("\n");
}

function buildCodexBaselinePrompt(input: NeedleAskInput): string {
  return [
    "Answer this as a pure language-model baseline.",
    "Hard rules:",
    "- Do not run shell commands.",
    "- Do not inspect local files.",
    "- Do not use external tools or web browsing.",
    "- Use only prior general knowledge.",
    "- Do not mention these constraints in your answer.",
    "",
    buildBaselineQuestionBlock(input),
  ].join("\n");
}

function preview(text: string, maxLen = 240): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= maxLen ? clean : clean.slice(0, maxLen - 1) + "…";
}

async function runNeedleCase(caseDef: BenchmarkCase): Promise<CaseResult> {
  const start = performance.now();
  try {
    const output = await runNeedlePipeline(caseDef.input);
    const latencyMs = performance.now() - start;
    const factEval = evaluateFacts(
      `${output.answer}\n${output.code}\n${output.notes}`,
      caseDef.facts,
    );
    const resourceRoot = resolve(process.cwd(), caseDef.input.resource.spec);
    const citationEval = await validateCitations(output.citations, resourceRoot);

    const correct = factEval.coverage >= FACT_COVERAGE_THRESHOLD
      && citationEval.valid > 0;

    return {
      caseId: caseDef.id,
      caseTitle: caseDef.title,
      system: "needle",
      status: "ok",
      latencyMs,
      factCoverage: factEval.coverage,
      factMatches: factEval.matches,
      factTotal: factEval.total,
      matchedFactIds: factEval.matchedFactIds,
      citationsValid: citationEval.valid,
      citationsTotal: citationEval.total,
      confidence: output.confidence,
      correct,
      answerPreview: preview(output.answer),
    };
  } catch (err) {
    return {
      caseId: caseDef.id,
      caseTitle: caseDef.title,
      system: "needle",
      status: "error",
      latencyMs: performance.now() - start,
      factCoverage: 0,
      factMatches: 0,
      factTotal: caseDef.facts.length,
      matchedFactIds: [],
      citationsValid: 0,
      citationsTotal: 0,
      confidence: null,
      correct: false,
      answerPreview: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

async function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1500).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        rejectPromise(
          new Error(`Command timed out after ${timeoutMs}ms: ${cmd} ${args.join(" ")}`),
        );
        return;
      }
      if (code !== 0) {
        const errTail = stderr.slice(-1200);
        rejectPromise(
          new Error(
            `Command failed (${code}): ${cmd} ${args.join(" ")}\n${errTail}`,
          ),
        );
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

async function getBaselineAnswer(caseDef: BenchmarkCase): Promise<string> {
  if (BASELINE_PROVIDER === "bedrock") {
    return converseWithBedrock(
      BASELINE_BEDROCK_SYSTEM_PROMPT,
      buildBaselineQuestionBlock(caseDef.input),
      {
        model: "nova-premier",
        temperature: 0.2,
        maxTokens: 1200,
      },
    );
  }

  const prompt = buildCodexBaselinePrompt(caseDef.input);
  const sandboxDir = await mkdtemp(join(tmpdir(), "needle-codex-baseline-"));
  const outputPath = join(sandboxDir, "last-message.txt");

  try {
    await runCommand(
      "codex",
      [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--color",
        "never",
        "-m",
        CODEX_BASELINE_MODEL,
        "-o",
        outputPath,
        "-C",
        sandboxDir,
        prompt,
      ],
      process.cwd(),
      CODEX_TIMEOUT_MS,
    );

    const answer = (await readFile(outputPath, "utf-8")).trim();
    if (!answer) {
      throw new Error("codex exec produced an empty baseline answer");
    }
    return answer;
  } finally {
    await rm(sandboxDir, { recursive: true, force: true });
  }
}

async function runBaselineCase(caseDef: BenchmarkCase): Promise<CaseResult> {
  const start = performance.now();
  try {
    const answer = await getBaselineAnswer(caseDef);
    const latencyMs = performance.now() - start;
    const factEval = evaluateFacts(answer, caseDef.facts);
    const correct = factEval.coverage >= FACT_COVERAGE_THRESHOLD;

    return {
      caseId: caseDef.id,
      caseTitle: caseDef.title,
      system: "baseline",
      status: "ok",
      latencyMs,
      factCoverage: factEval.coverage,
      factMatches: factEval.matches,
      factTotal: factEval.total,
      matchedFactIds: factEval.matchedFactIds,
      citationsValid: 0,
      citationsTotal: 0,
      confidence: null,
      correct,
      answerPreview: preview(answer),
    };
  } catch (err) {
    return {
      caseId: caseDef.id,
      caseTitle: caseDef.title,
      system: "baseline",
      status: "error",
      latencyMs: performance.now() - start,
      factCoverage: 0,
      factMatches: 0,
      factTotal: caseDef.facts.length,
      matchedFactIds: [],
      citationsValid: 0,
      citationsTotal: 0,
      confidence: null,
      correct: false,
      answerPreview: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

function safeDiv(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function aggregateCases(results: CaseResult[]): AggregateMetrics {
  const latencies = results.map((r) => r.latencyMs);
  const totalCitations = results.reduce((sum, r) => sum + r.citationsTotal, 0);
  const validCitations = results.reduce((sum, r) => sum + r.citationsValid, 0);
  const correctCount = results.filter((r) => r.correct).length;
  const answersWithValidCitations = results.filter((r) => r.citationsValid > 0).length;
  const confidences = results
    .map((r) => r.confidence)
    .filter((v): v is number => typeof v === "number");

  const correctnessRate = safeDiv(correctCount, results.length);
  const medianLatencyMs = percentile(latencies, 50);
  const effectiveCorrectness = Math.max(correctnessRate, MIN_CORRECTNESS_FLOOR);

  return {
    totalCases: results.length,
    okCases: results.filter((r) => r.status === "ok").length,
    errorCases: results.filter((r) => r.status === "error").length,
    avgFactCoverage: mean(results.map((r) => r.factCoverage)),
    medianLatencyMs,
    p95LatencyMs: percentile(latencies, 95),
    citationValidityRate: safeDiv(validCitations, totalCitations),
    answersWithValidCitationsRate: safeDiv(answersWithValidCitations, results.length),
    correctnessRate,
    expectedTimeToCorrectMs: medianLatencyMs / effectiveCorrectness,
    avgConfidence: confidences.length > 0 ? mean(confidences) : null,
  };
}

function round(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function computeImpact(summary: BenchmarkSummary): BenchmarkSummary["impact"] {
  const needleEta = summary.systems.needle.aggregate.expectedTimeToCorrectMs;
  const baselineEta = summary.systems.baseline.aggregate.expectedTimeToCorrectMs;
  const msSavedPerQuestion = baselineEta - needleEta;
  const weeklyMinutesSavedPerEngineer =
    (msSavedPerQuestion * IMPACT_ASSUMPTIONS.questionsPerEngineerPerWeek) / 60000;
  const weeklyHoursSavedTeam =
    (weeklyMinutesSavedPerEngineer / 60) * IMPACT_ASSUMPTIONS.teamSize;
  const annualHoursSavedTeam = weeklyHoursSavedTeam * 52;
  const annualValueUsd = annualHoursSavedTeam
    * IMPACT_ASSUMPTIONS.loadedEngineerCostUsdPerHour;

  return {
    weeklyMinutesSavedPerEngineer: round(weeklyMinutesSavedPerEngineer, 2),
    weeklyHoursSavedTeam: round(weeklyHoursSavedTeam, 2),
    annualHoursSavedTeam: round(annualHoursSavedTeam, 1),
    annualValueUsd: round(annualValueUsd, 0),
  };
}

function computeHallucinationTaxScenario(
  teamSize: number,
): BenchmarkSummary["hallucinationTaxScenario"] {
  const weeklyHoursLostPerDeveloper = METR_MODELED_AI_HOURS_PER_DEV_PER_WEEK
    * METR_SLOWDOWN_RATE;
  const weeklyHoursLostTeam = weeklyHoursLostPerDeveloper * teamSize;
  const annualHoursLostTeam = weeklyHoursLostTeam * 52;

  return {
    modeledAiCodingHoursPerDevWeek: METR_MODELED_AI_HOURS_PER_DEV_PER_WEEK,
    slowdownRate: METR_SLOWDOWN_RATE,
    weeklyHoursLostPerDeveloper: round(weeklyHoursLostPerDeveloper, 2),
    weeklyHoursLostTeam: round(weeklyHoursLostTeam, 2),
    annualHoursLostTeam: round(annualHoursLostTeam, 1),
  };
}

function escapeCsv(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, "\"\"")}"`;
  }
  return s;
}

function toCsv(summary: BenchmarkSummary): string {
  const rows: string[] = [];
  rows.push([
    "case_id",
    "case_title",
    "system",
    "status",
    "fact_coverage_pct",
    "fact_matches",
    "fact_total",
    "latency_ms",
    "citations_valid",
    "citations_total",
    "correct",
    "error",
  ].join(","));

  const all = [...summary.systems.needle.cases, ...summary.systems.baseline.cases];
  for (const row of all) {
    rows.push([
      escapeCsv(row.caseId),
      escapeCsv(row.caseTitle),
      escapeCsv(row.system),
      escapeCsv(row.status),
      escapeCsv(round(row.factCoverage * 100, 2)),
      escapeCsv(row.factMatches),
      escapeCsv(row.factTotal),
      escapeCsv(round(row.latencyMs, 2)),
      escapeCsv(row.citationsValid),
      escapeCsv(row.citationsTotal),
      escapeCsv(row.correct),
      escapeCsv(row.error ?? ""),
    ].join(","));
  }

  return rows.join("\n") + "\n";
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatMs(value: number | null): string {
  if (value === null) return "N/A";
  return `${Math.round(value)} ms`;
}

function formatUsd(value: number | null): string {
  if (value === null) return "N/A";
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function buildReport(summary: BenchmarkSummary): string {
  const needle = summary.systems.needle.aggregate;
  const baseline = summary.systems.baseline.aggregate;

  const deltaCoverage = summary.comparison.factCoverageDelta;
  const deltaCorrectness = summary.comparison.correctnessDelta;
  const deltaCitation = summary.comparison.citationValidityDelta;
  const deltaEta = summary.comparison.expectedTimeToCorrectDeltaMs;
  const deltaMedianLatencyMs = baseline.medianLatencyMs - needle.medianLatencyMs;
  const timeCutPercent = summary.comparison.expectedTimeToCorrectDeltaPercent * 100;
  const speedMultiplier = summary.comparison.speedMultiplier;

  const impact = summary.impact;
  const tax = summary.hallucinationTaxScenario;

  return [
    "# Needle Benchmark Report",
    "",
    `Generated: ${summary.generatedAt}`,
    `Baseline provider: ${summary.config.baselineProvider} (${summary.config.models.baseline})`,
    "",
    "## Aggregate Metrics",
    "",
    "| Metric | Needle | Baseline | Delta |",
    "|---|---:|---:|---:|",
    `| Avg fact coverage | ${formatPct(needle.avgFactCoverage)} | ${formatPct(baseline.avgFactCoverage)} | ${(deltaCoverage * 100).toFixed(1)} pp |`,
    `| Correctness rate | ${formatPct(needle.correctnessRate)} | ${formatPct(baseline.correctnessRate)} | ${(deltaCorrectness * 100).toFixed(1)} pp |`,
    `| Citation validity rate | ${formatPct(needle.citationValidityRate)} | ${formatPct(baseline.citationValidityRate)} | ${(deltaCitation * 100).toFixed(1)} pp |`,
    `| Median latency | ${formatMs(needle.medianLatencyMs)} | ${formatMs(baseline.medianLatencyMs)} | ${formatMs(deltaMedianLatencyMs)} |`,
    `| Expected time to correct | ${formatMs(needle.expectedTimeToCorrectMs)} | ${formatMs(baseline.expectedTimeToCorrectMs)} | ${formatMs(deltaEta)} |`,
    `| Time cut to first correct answer | — | — | ${timeCutPercent.toFixed(1)}% |`,
    `| Speed multiplier (baseline/needle) | — | — | ${speedMultiplier.toFixed(2)}x |`,
    "",
    "## Impact Estimate",
    "",
    `Assumptions: ${IMPACT_ASSUMPTIONS.questionsPerEngineerPerWeek} questions/engineer/week, team size ${IMPACT_ASSUMPTIONS.teamSize}, loaded cost $${IMPACT_ASSUMPTIONS.loadedEngineerCostUsdPerHour}/hour. Expected-time metric uses a ${Math.round(MIN_CORRECTNESS_FLOOR * 100)}% correctness floor.`,
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Weekly minutes saved per engineer | ${impact.weeklyMinutesSavedPerEngineer ?? "N/A"} |`,
    `| Weekly team hours saved | ${impact.weeklyHoursSavedTeam ?? "N/A"} |`,
    `| Annual team hours saved | ${impact.annualHoursSavedTeam ?? "N/A"} |`,
    `| Annual value | ${formatUsd(impact.annualValueUsd)} |`,
    "",
    "## External Hallucination Context",
    "",
    "- Stack Overflow 2025: 66% of developers report spending more time fixing almost-right AI output than writing it from scratch.",
    "- METR study (2025): experienced open-source developers were 19% slower with early-2025 AI tools in realistic repo tasks.",
    "- Package hallucination study (2024): code LLMs generated non-existent package references, with higher rates in open-source models.",
    "",
    `Modeled hallucination/verification tax scenario (based on METR 19% slowdown and ${tax.modeledAiCodingHoursPerDevWeek} AI-assisted coding hours/dev/week):`,
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Weekly hours lost per developer | ${tax.weeklyHoursLostPerDeveloper} |`,
    `| Weekly hours lost across team | ${tax.weeklyHoursLostTeam} |`,
    `| Annual hours lost across team | ${tax.annualHoursLostTeam} |`,
    "",
    "Sources:",
    "- https://stackoverflow.blog/2025/12/29/developers-remain-willing-but-reluctant-to-use-ai-the-2025-developer-survey-results-are-here/",
    "- https://arxiv.org/abs/2507.09089",
    "- https://arxiv.org/abs/2406.10279",
    "",
    "## Graphs",
    "",
    "- `graphs/fact-coverage.svg`",
    "- `graphs/correctness-rate.svg`",
    "- `graphs/expected-time-to-correct.svg`",
    "- `graphs/case-fact-coverage.svg`",
    "- `graphs/time-cut-percent.svg`",
    "- `graphs/weekly-time-saved.svg`",
    "- `graphs/hallucination-tax-scenario.svg`",
    "",
  ].join("\n");
}

function buildImpactReport(summary: BenchmarkSummary): string {
  const timeCutPercent = (summary.comparison.expectedTimeToCorrectDeltaPercent * 100).toFixed(1);
  const speedMultiplier = summary.comparison.speedMultiplier.toFixed(2);
  const tax = summary.hallucinationTaxScenario;

  return [
    "# Needle Impact Summary",
    "",
    `Generated: ${summary.generatedAt}`,
    "",
    "## Why this matters",
    "",
    "Needle is scored as a quality-and-speed system: higher correctness per answer and lower expected time to first correct answer. This directly maps to reduced debugging/research overhead for engineers working with undocumented or unstable libraries.",
    "",
    "## Headline Numbers",
    "",
    `- Time cut to first correct answer: ${timeCutPercent}%`,
    `- Speed multiplier vs baseline: ${speedMultiplier}x`,
    `- Weekly minutes saved per engineer: ${summary.impact.weeklyMinutesSavedPerEngineer ?? "N/A"}`,
    `- Weekly team hours saved: ${summary.impact.weeklyHoursSavedTeam ?? "N/A"}`,
    `- Annual team hours saved: ${summary.impact.annualHoursSavedTeam ?? "N/A"}`,
    `- Annual value: ${formatUsd(summary.impact.annualValueUsd)}`,
    "",
    "## Hallucination Tax Scenario",
    "",
    `- Modeled AI-assisted coding hours/dev/week: ${tax.modeledAiCodingHoursPerDevWeek}`,
    `- Slowdown assumption (METR): ${(tax.slowdownRate * 100).toFixed(1)}%`,
    `- Weekly hours lost per developer: ${tax.weeklyHoursLostPerDeveloper}`,
    `- Weekly hours lost team-wide: ${tax.weeklyHoursLostTeam}`,
    `- Annual hours lost team-wide: ${tax.annualHoursLostTeam}`,
    "",
    "## Benchmark Inputs",
    "",
    `- Cases: ${summary.config.cases}`,
    `- Baseline provider: ${summary.config.baselineProvider} (${summary.config.models.baseline})`,
    `- Fact coverage threshold for correctness: ${Math.round(summary.config.factCoverageThreshold * 100)}%`,
    `- Minimum correctness floor for expected-time metric: ${Math.round(summary.config.minCorrectnessFloor * 100)}%`,
    `- Questions per engineer per week: ${summary.config.assumptions.questionsPerEngineerPerWeek}`,
    `- Team size: ${summary.config.assumptions.teamSize}`,
    `- Loaded engineering cost per hour: $${summary.config.assumptions.loadedEngineerCostUsdPerHour}`,
    "",
    "## Re-run",
    "",
    "```bash",
    "NEEDLE_BEDROCK_BEARER_TOKEN=... ./benchmark",
    "```",
    "",
    "## Sources",
    "",
    "- https://stackoverflow.blog/2025/12/29/developers-remain-willing-but-reluctant-to-use-ai-the-2025-developer-survey-results-are-here/",
    "- https://arxiv.org/abs/2507.09089",
    "- https://arxiv.org/abs/2406.10279",
    "",
  ].join("\n");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function renderHorizontalBarChart(
  title: string,
  subtitle: string,
  items: Array<{ label: string; value: number; color: string }>,
  unit: string,
  maxValue?: number,
): string {
  const width = 900;
  const top = 92;
  const left = 220;
  const right = 80;
  const barHeight = 28;
  const rowGap = 24;
  const chartWidth = width - left - right;
  const rows = items.length;
  const height = top + rows * (barHeight + rowGap) + 60;
  const max = Math.max(
    maxValue ?? 0,
    ...items.map((item) => item.value),
    1,
  );
  const scaleMax = maxValue ?? max * 1.1;

  const lines: string[] = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  lines.push(`<rect width="100%" height="100%" fill="#0d1117" />`);
  lines.push(`<text x="30" y="40" fill="#e6edf3" font-size="24" font-family="IBM Plex Sans, sans-serif">${escapeXml(title)}</text>`);
  lines.push(`<text x="30" y="68" fill="#8b949e" font-size="14" font-family="IBM Plex Sans, sans-serif">${escapeXml(subtitle)}</text>`);

  lines.push(`<line x1="${left}" y1="${top - 16}" x2="${left}" y2="${height - 28}" stroke="#30363d" stroke-width="1" />`);
  lines.push(`<line x1="${left}" y1="${height - 28}" x2="${width - right}" y2="${height - 28}" stroke="#30363d" stroke-width="1" />`);

  for (let i = 0; i <= 4; i += 1) {
    const tickValue = (scaleMax / 4) * i;
    const x = left + (chartWidth * i) / 4;
    lines.push(`<line x1="${x}" y1="${top - 12}" x2="${x}" y2="${height - 28}" stroke="#21262d" stroke-width="1" />`);
    lines.push(`<text x="${x}" y="${height - 8}" fill="#6e7681" font-size="11" text-anchor="middle" font-family="JetBrains Mono, monospace">${tickValue.toFixed(0)}${escapeXml(unit)}</text>`);
  }

  items.forEach((item, idx) => {
    const y = top + idx * (barHeight + rowGap);
    const w = Math.max(2, (item.value / scaleMax) * chartWidth);

    lines.push(`<text x="${left - 16}" y="${y + 19}" fill="#c9d1d9" text-anchor="end" font-size="14" font-family="IBM Plex Sans, sans-serif">${escapeXml(item.label)}</text>`);
    lines.push(`<rect x="${left}" y="${y}" width="${chartWidth}" height="${barHeight}" rx="4" fill="#161b22" />`);
    lines.push(`<rect x="${left}" y="${y}" width="${w}" height="${barHeight}" rx="4" fill="${item.color}" />`);
    lines.push(`<text x="${left + w + 8}" y="${y + 19}" fill="#e6edf3" font-size="12" font-family="JetBrains Mono, monospace">${item.value.toFixed(1)}${escapeXml(unit)}</text>`);
  });

  lines.push("</svg>");
  return lines.join("\n");
}

function renderCaseCoverageChart(summary: BenchmarkSummary): string {
  const needleByCase = new Map(summary.systems.needle.cases.map((r) => [r.caseId, r]));
  const baselineByCase = new Map(summary.systems.baseline.cases.map((r) => [r.caseId, r]));

  const width = 1080;
  const left = 280;
  const right = 70;
  const top = 104;
  const barHeight = 12;
  const rowGap = 34;
  const chartWidth = width - left - right;
  const rows = BENCHMARK_CASES.length;
  const height = top + rows * rowGap + 60;

  const lines: string[] = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  lines.push(`<rect width="100%" height="100%" fill="#0d1117" />`);
  lines.push(`<text x="30" y="40" fill="#e6edf3" font-size="24" font-family="IBM Plex Sans, sans-serif">Per-Case Fact Coverage</text>`);
  lines.push(`<text x="30" y="68" fill="#8b949e" font-size="14" font-family="IBM Plex Sans, sans-serif">Needle (blue) vs Baseline (amber), percentage of benchmark facts matched</text>`);

  for (let i = 0; i <= 4; i += 1) {
    const x = left + (chartWidth * i) / 4;
    lines.push(`<line x1="${x}" y1="${top - 18}" x2="${x}" y2="${height - 36}" stroke="#21262d" stroke-width="1" />`);
    lines.push(`<text x="${x}" y="${height - 12}" fill="#6e7681" font-size="11" text-anchor="middle" font-family="JetBrains Mono, monospace">${i * 25}%</text>`);
  }

  BENCHMARK_CASES.forEach((benchCase, idx) => {
    const y = top + idx * rowGap;
    const needle = needleByCase.get(benchCase.id);
    const baseline = baselineByCase.get(benchCase.id);
    const needlePct = (needle?.factCoverage ?? 0) * 100;
    const baselinePct = (baseline?.factCoverage ?? 0) * 100;

    lines.push(`<text x="${left - 12}" y="${y + 8}" fill="#c9d1d9" text-anchor="end" font-size="12" font-family="IBM Plex Sans, sans-serif">${escapeXml(benchCase.id)}</text>`);

    const baselineY = y + 12;
    const needleY = y + 28;
    lines.push(`<rect x="${left}" y="${baselineY}" width="${chartWidth}" height="${barHeight}" rx="3" fill="#161b22" />`);
    lines.push(`<rect x="${left}" y="${baselineY}" width="${(baselinePct / 100) * chartWidth}" height="${barHeight}" rx="3" fill="${BASELINE_COLOR}" />`);
    lines.push(`<rect x="${left}" y="${needleY}" width="${chartWidth}" height="${barHeight}" rx="3" fill="#161b22" />`);
    lines.push(`<rect x="${left}" y="${needleY}" width="${(needlePct / 100) * chartWidth}" height="${barHeight}" rx="3" fill="${NEEDLE_COLOR}" />`);
  });

  lines.push("</svg>");
  return lines.join("\n");
}

async function writeArtifacts(summary: BenchmarkSummary, outputDir: string): Promise<void> {
  const absOutput = resolve(process.cwd(), outputDir);
  const graphDir = join(absOutput, "graphs");
  await mkdir(graphDir, { recursive: true });

  await writeFile(join(absOutput, "summary.json"), JSON.stringify(summary, null, 2));
  await writeFile(join(absOutput, "scores.csv"), toCsv(summary), "utf-8");
  await writeFile(join(absOutput, "report.md"), buildReport(summary), "utf-8");
  await writeFile(join(absOutput, "impact.md"), buildImpactReport(summary), "utf-8");

  const factChart = renderHorizontalBarChart(
    "Average Fact Coverage",
    "Higher is better",
    [
      {
        label: "Needle",
        value: summary.systems.needle.aggregate.avgFactCoverage * 100,
        color: NEEDLE_COLOR,
      },
      {
        label: "Baseline",
        value: summary.systems.baseline.aggregate.avgFactCoverage * 100,
        color: BASELINE_COLOR,
      },
    ],
    "%",
    100,
  );

  const correctnessChart = renderHorizontalBarChart(
    "Correctness Rate",
    `Correct if fact coverage >= ${Math.round(FACT_COVERAGE_THRESHOLD * 100)}%`,
    [
      {
        label: "Needle",
        value: summary.systems.needle.aggregate.correctnessRate * 100,
        color: NEEDLE_COLOR,
      },
      {
        label: "Baseline",
        value: summary.systems.baseline.aggregate.correctnessRate * 100,
        color: BASELINE_COLOR,
      },
    ],
    "%",
    100,
  );

  const needleEtaSec = (summary.systems.needle.aggregate.expectedTimeToCorrectMs ?? 0) / 1000;
  const baselineEtaSec = (summary.systems.baseline.aggregate.expectedTimeToCorrectMs ?? 0) / 1000;
  const etaMax = Math.max(needleEtaSec, baselineEtaSec, 1);
  const etaChart = renderHorizontalBarChart(
    "Expected Time To First Correct Answer",
    "Lower is better (median latency / correctness rate)",
    [
      {
        label: "Needle",
        value: needleEtaSec,
        color: NEEDLE_COLOR,
      },
      {
        label: "Baseline",
        value: baselineEtaSec,
        color: BASELINE_COLOR,
      },
    ],
    "s",
    etaMax * 1.1,
  );

  const timeCutChart = renderHorizontalBarChart(
    "Time Cut To First Correct Answer",
    "Relative reduction versus baseline expected time to correct",
    [
      {
        label: "Needle improvement",
        value: summary.comparison.expectedTimeToCorrectDeltaPercent * 100,
        color: "#3fb950",
      },
    ],
    "%",
    100,
  );

  const weeklyMinutesSavedPerEngineer = summary.impact.weeklyMinutesSavedPerEngineer ?? 0;
  const weeklyTeamMinutesSaved = (summary.impact.weeklyHoursSavedTeam ?? 0) * 60;
  const weeklySavingsMax = Math.max(weeklyMinutesSavedPerEngineer, weeklyTeamMinutesSaved, 1);
  const weeklySavingsChart = renderHorizontalBarChart(
    "Recovered Time Per Week",
    "Recovered time from reducing rework to first correct answer",
    [
      {
        label: "Per engineer",
        value: weeklyMinutesSavedPerEngineer,
        color: "#58a6ff",
      },
      {
        label: "Team total",
        value: weeklyTeamMinutesSaved,
        color: "#2ea043",
      },
    ],
    "m",
    weeklySavingsMax * 1.1,
  );

  const tax = summary.hallucinationTaxScenario;
  const hallucinationTaxMax = Math.max(tax.weeklyHoursLostPerDeveloper, tax.weeklyHoursLostTeam, 1);
  const hallucinationTaxChart = renderHorizontalBarChart(
    "Modeled Hallucination / Verification Tax",
    "Scenario from METR 19% slowdown context",
    [
      {
        label: "Lost hrs/dev/week",
        value: tax.weeklyHoursLostPerDeveloper,
        color: "#d29922",
      },
      {
        label: "Lost hrs/team/week",
        value: tax.weeklyHoursLostTeam,
        color: "#f85149",
      },
    ],
    "h",
    hallucinationTaxMax * 1.1,
  );

  const caseChart = renderCaseCoverageChart(summary);

  await writeFile(join(graphDir, "fact-coverage.svg"), factChart, "utf-8");
  await writeFile(join(graphDir, "correctness-rate.svg"), correctnessChart, "utf-8");
  await writeFile(join(graphDir, "expected-time-to-correct.svg"), etaChart, "utf-8");
  await writeFile(join(graphDir, "case-fact-coverage.svg"), caseChart, "utf-8");
  await writeFile(join(graphDir, "time-cut-percent.svg"), timeCutChart, "utf-8");
  await writeFile(join(graphDir, "weekly-time-saved.svg"), weeklySavingsChart, "utf-8");
  await writeFile(join(graphDir, "hallucination-tax-scenario.svg"), hallucinationTaxChart, "utf-8");
}

async function runBenchmark(): Promise<BenchmarkSummary> {
  const needleResults: CaseResult[] = [];
  const baselineResults: CaseResult[] = [];

  for (let i = 0; i < BENCHMARK_CASES.length; i += 1) {
    const testCase = BENCHMARK_CASES[i];
    console.log(`[benchmark] (${i + 1}/${BENCHMARK_CASES.length}) ${testCase.id} -> needle`);
    needleResults.push(await runNeedleCase(testCase));
    console.log(`[benchmark] (${i + 1}/${BENCHMARK_CASES.length}) ${testCase.id} -> baseline`);
    baselineResults.push(await runBaselineCase(testCase));
  }

  const needleAgg = aggregateCases(needleResults);
  const baselineAgg = aggregateCases(baselineResults);
  const etaDeltaMs = baselineAgg.expectedTimeToCorrectMs - needleAgg.expectedTimeToCorrectMs;
  const etaDeltaPct = baselineAgg.expectedTimeToCorrectMs > 0
    ? etaDeltaMs / baselineAgg.expectedTimeToCorrectMs
    : 0;
  const speedMultiplier = needleAgg.expectedTimeToCorrectMs > 0
    ? baselineAgg.expectedTimeToCorrectMs / needleAgg.expectedTimeToCorrectMs
    : 0;

  const summary: BenchmarkSummary = {
    generatedAt: new Date().toISOString(),
    config: {
      cases: BENCHMARK_CASES.length,
      factCoverageThreshold: FACT_COVERAGE_THRESHOLD,
      minCorrectnessFloor: MIN_CORRECTNESS_FLOOR,
      baselineProvider: BASELINE_PROVIDER,
      models: {
        needleSynthesis: "nova-premier",
        needleAgents: "nova-lite",
        baseline: getBaselineModelLabel(),
      },
      assumptions: IMPACT_ASSUMPTIONS,
    },
    systems: {
      needle: {
        aggregate: needleAgg,
        cases: needleResults,
      },
      baseline: {
        aggregate: baselineAgg,
        cases: baselineResults,
      },
    },
    comparison: {
      factCoverageDelta: round(needleAgg.avgFactCoverage - baselineAgg.avgFactCoverage),
      correctnessDelta: round(needleAgg.correctnessRate - baselineAgg.correctnessRate),
      citationValidityDelta: round(
        needleAgg.citationValidityRate - baselineAgg.citationValidityRate,
      ),
      expectedTimeToCorrectDeltaMs: round(etaDeltaMs, 2),
      expectedTimeToCorrectDeltaPercent: round(etaDeltaPct),
      speedMultiplier: round(speedMultiplier),
    },
    impact: {
      weeklyMinutesSavedPerEngineer: null,
      weeklyHoursSavedTeam: null,
      annualHoursSavedTeam: null,
      annualValueUsd: null,
    },
    hallucinationTaxScenario: {
      modeledAiCodingHoursPerDevWeek: 0,
      slowdownRate: 0,
      weeklyHoursLostPerDeveloper: 0,
      weeklyHoursLostTeam: 0,
      annualHoursLostTeam: 0,
    },
  };

  summary.impact = computeImpact(summary);
  summary.hallucinationTaxScenario = computeHallucinationTaxScenario(
    summary.config.assumptions.teamSize,
  );
  return summary;
}

function sampleSummary(): BenchmarkSummary {
  const needleCases: CaseResult[] = BENCHMARK_CASES.map((c, i) => ({
    caseId: c.id,
    caseTitle: c.title,
    system: "needle",
    status: "ok",
    latencyMs: 3200 + i * 110,
    factCoverage: 0.75 + (i % 3) * 0.08,
    factMatches: 3,
    factTotal: 4,
    matchedFactIds: c.facts.slice(0, 3).map((f) => f.id),
    citationsValid: 3,
    citationsTotal: 3,
    confidence: 0.78 + (i % 2) * 0.05,
    correct: true,
    answerPreview: "Sample Needle answer preview",
  }));

  const baselineCases: CaseResult[] = BENCHMARK_CASES.map((c, i) => ({
    caseId: c.id,
    caseTitle: c.title,
    system: "baseline",
    status: "ok",
    latencyMs: 1800 + i * 90,
    factCoverage: 0.2 + (i % 4) * 0.05,
    factMatches: 1,
    factTotal: 4,
    matchedFactIds: c.facts.slice(0, 1).map((f) => f.id),
    citationsValid: 0,
    citationsTotal: 0,
    confidence: null,
    correct: false,
    answerPreview: "Sample baseline answer preview",
  }));

  const needleAgg = aggregateCases(needleCases);
  const baselineAgg = aggregateCases(baselineCases);
  const etaDeltaMs = baselineAgg.expectedTimeToCorrectMs - needleAgg.expectedTimeToCorrectMs;
  const etaDeltaPct = baselineAgg.expectedTimeToCorrectMs > 0
    ? etaDeltaMs / baselineAgg.expectedTimeToCorrectMs
    : 0;
  const speedMultiplier = needleAgg.expectedTimeToCorrectMs > 0
    ? baselineAgg.expectedTimeToCorrectMs / needleAgg.expectedTimeToCorrectMs
    : 0;

  const summary: BenchmarkSummary = {
    generatedAt: new Date().toISOString(),
    config: {
      cases: BENCHMARK_CASES.length,
      factCoverageThreshold: FACT_COVERAGE_THRESHOLD,
      minCorrectnessFloor: MIN_CORRECTNESS_FLOOR,
      baselineProvider: BASELINE_PROVIDER,
      models: {
        needleSynthesis: "nova-premier",
        needleAgents: "nova-lite",
        baseline: getBaselineModelLabel(),
      },
      assumptions: IMPACT_ASSUMPTIONS,
    },
    systems: {
      needle: { aggregate: needleAgg, cases: needleCases },
      baseline: { aggregate: baselineAgg, cases: baselineCases },
    },
    comparison: {
      factCoverageDelta: round(needleAgg.avgFactCoverage - baselineAgg.avgFactCoverage),
      correctnessDelta: round(needleAgg.correctnessRate - baselineAgg.correctnessRate),
      citationValidityDelta: round(
        needleAgg.citationValidityRate - baselineAgg.citationValidityRate,
      ),
      expectedTimeToCorrectDeltaMs: round(etaDeltaMs, 2),
      expectedTimeToCorrectDeltaPercent: round(etaDeltaPct),
      speedMultiplier: round(speedMultiplier),
    },
    impact: {
      weeklyMinutesSavedPerEngineer: null,
      weeklyHoursSavedTeam: null,
      annualHoursSavedTeam: null,
      annualValueUsd: null,
    },
    hallucinationTaxScenario: {
      modeledAiCodingHoursPerDevWeek: 0,
      slowdownRate: 0,
      weeklyHoursLostPerDeveloper: 0,
      weeklyHoursLostTeam: 0,
      annualHoursLostTeam: 0,
    },
  };

  summary.impact = computeImpact(summary);
  summary.hallucinationTaxScenario = computeHallucinationTaxScenario(
    summary.config.assumptions.teamSize,
  );
  return summary;
}

async function loadSummary(pathInput: string): Promise<BenchmarkSummary> {
  const path = resolve(process.cwd(), pathInput);
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as BenchmarkSummary;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const outputDir = options.outputDir;

  if (options.graphsOnly) {
    const summaryPath = options.inputPath ?? join(outputDir, "summary.json");
    const summary = await loadSummary(summaryPath);
    await writeArtifacts(summary, outputDir);
    console.log(`[benchmark] graphs/report updated in ${outputDir}`);
    return;
  }

  if (options.sample) {
    const summary = sampleSummary();
    await writeArtifacts(summary, outputDir);
    console.log(`[benchmark] sample artifacts written to ${outputDir}`);
    return;
  }

  if (!process.env.NEEDLE_BEDROCK_BEARER_TOKEN) {
    throw new Error(
      "NEEDLE_BEDROCK_BEARER_TOKEN is required for live benchmark runs. Use --sample to generate demo artifacts without Bedrock.",
    );
  }

  const summary = await runBenchmark();
  await writeArtifacts(summary, outputDir);
  console.log(`[benchmark] completed. Artifacts written to ${outputDir}`);
}

await main();
