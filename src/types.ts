import { z } from "zod";

// ── Tool input schema ────────────────────────────────────────────────────────

export const ResourceSchema = z.object({
  type: z.enum(["local", "npm", "git"]),
  spec: z.string().describe("Path, npm spec, or git URL"),
});

export const NeedleAskInputSchema = z.object({
  resource: ResourceSchema,
  question: z.string().describe("Natural-language question about the resource"),
  options: z
    .object({
      language: z
        .enum(["ts", "js", "any"])
        .default("any")
        .describe("Restrict evidence to file extensions"),
      maxHits: z
        .number()
        .int()
        .positive()
        .default(60)
        .describe("Max evidence hits to feed into synthesis"),
      contextLines: z
        .number()
        .int()
        .nonnegative()
        .default(3)
        .describe("Context lines around each rg match"),
      enableWeb: z
        .boolean()
        .default(false)
        .describe("Include SearXNG web results in evidence"),
      verify: z
        .boolean()
        .default(false)
        .describe("Attempt to verify generated code snippets"),
    })
    .default({}),
});

export type NeedleAskInput = z.infer<typeof NeedleAskInputSchema>;
export type Resource = z.infer<typeof ResourceSchema>;

// ── Tool output ──────────────────────────────────────────────────────────────

export interface Citation {
  file: string;
  lines: string;
  snippet: string;
}

export interface EvidenceHit {
  path: string;
  lineNumber: number;
  text: string;
  score: number;
  submatches: string[];
}

export interface NeedleAskOutput {
  answer: string;
  code: string;
  confidence: number;
  citations: Citation[];
  evidence: {
    resourceDir?: string;
    hits: EvidenceHit[];
  };
  nextQueries: string[];
  notes: string;
}

export interface DeepReadFile {
  /** Path relative to the resource directory (for display) */
  path: string;
  /** Full UTF-8 file content */
  content: string;
  /** File size in bytes (original buffer size) */
  sizeBytes: number;
  /** Highest reranked evidence score among hits from this file */
  topScore: number;
}

// ── Internal types ───────────────────────────────────────────────────────────

export interface ResolvedResource {
  dir: string;
  cleanup: () => Promise<void>;
}

export interface RgMatch {
  path: string;
  lineNumber: number;
  text: string;
  submatches: string[];
}

export interface WebEvidence {
  title: string;
  url: string;
  snippet: string;
}
