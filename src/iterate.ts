import { relative } from "node:path";
import type { EvidenceHit, DeepReadFile } from "./types.js";
import type { CollectEvidenceOptions } from "./evidence.js";
import { collectEvidence } from "./evidence.js";
import { rerankEvidenceWithLite, identifyGapsWithLite } from "./agents.js";
import {
  selectFilesForDeepRead,
  deepReadFiles,
  filterSnippetsForDeepRead,
  resolveImportsFromDeepReads,
} from "./deepread.js";
import { logger } from "./util/log.js";
import {
  DEEP_READ_MAX_FILE_SIZE,
  DEEP_READ_MAX_TOTAL_SIZE,
  ITERATE_MAX_ADDITIONAL_HITS,
  ITERATE_EXTRA_DEEP_READ,
} from "./util/limits.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface IterativePipelineOptions {
  evidenceOptions: CollectEvidenceOptions;
  enableIteration?: boolean;
  enableImportFollowing?: boolean;
  onStep?: (
    step:
      | "evidence.reranked"
      | "deepread.completed"
      | "imports.followed"
      | "gaps.identified"
      | "iteration.pass2.completed",
    data: Record<string, unknown>,
  ) => void;
}

export interface IterativePipelineResult {
  filteredEvidence: EvidenceHit[];
  allEvidence: EvidenceHit[];
  deepReads: DeepReadFile[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a set of absolute paths for successfully deep-read files */
function buildAbsPathSet(
  dir: string,
  candidates: { path: string }[],
  deepReads: DeepReadFile[],
): Set<string> {
  const relPaths = new Set(deepReads.map((dr) => dr.path));
  return new Set(
    candidates
      .filter((c) => relPaths.has(relative(dir, c.path)))
      .map((c) => c.path),
  );
}

/** Dedup key for evidence hits (same as evidence.ts) */
function dedupKey(hit: EvidenceHit): string {
  return `${hit.path}:${Math.floor(hit.lineNumber / 10)}`;
}

// ── Main pipeline ────────────────────────────────────────────────────────────

/**
 * Run the full iterative evidence pipeline:
 *
 * Pass 1: collectEvidence → rerank → deep-read → follow imports
 * Pass 2: gap analysis → targeted ripgrep → merge → rerank new → deep-read new
 * Final:  filter snippets
 *
 * Every sub-step is fail-safe. If any enhancement fails, the pipeline
 * falls back to pass 1 results.
 */
export async function runIterativePipeline(
  question: string,
  dir: string,
  options: IterativePipelineOptions,
): Promise<IterativePipelineResult> {
  const {
    evidenceOptions,
    enableIteration = true,
    enableImportFollowing = true,
    onStep,
  } = options;

  const emitStep = onStep ?? (() => {});

  // ── Pass 1: Collect + rerank + deep-read ────────────────────────────────

  const codeEvidence = await collectEvidence(question, dir, evidenceOptions);
  logger.info("Pass 1: evidence collected", { hits: codeEvidence.length });

  const reranked = await rerankEvidenceWithLite(question, codeEvidence);
  reranked.sort((a, b) => b.score - a.score);
  logger.info("Pass 1: evidence re-ranked", { hits: reranked.length });
  emitStep("evidence.reranked", { hits: reranked.length });

  const pass1Candidates = selectFilesForDeepRead(reranked);
  const pass1DeepReads = await deepReadFiles(dir, pass1Candidates, {
    evidenceHits: reranked,
  });
  emitStep("deepread.completed", {
    filesRead: pass1DeepReads.length,
    deepReadFiles: pass1DeepReads.map((f) => ({
      path: f.path,
      sizeBytes: f.sizeBytes,
    })),
    totalBytes: pass1DeepReads.reduce((s, f) => s + f.sizeBytes, 0),
  });

  let totalDeepReadBytes = pass1DeepReads.reduce((s, f) => s + f.sizeBytes, 0);
  const deepReadAbsPaths = buildAbsPathSet(dir, pass1Candidates, pass1DeepReads);
  let allDeepReads = [...pass1DeepReads];

  // ── Import following ────────────────────────────────────────────────────

  if (enableImportFollowing) {
    try {
      const importCandidates = await resolveImportsFromDeepReads(
        dir,
        pass1DeepReads,
        deepReadAbsPaths,
      );

      if (importCandidates.length > 0) {
        const importReads = await deepReadFiles(dir, importCandidates, {
          maxFileSize: DEEP_READ_MAX_FILE_SIZE,
          maxTotalSize: DEEP_READ_MAX_TOTAL_SIZE - totalDeepReadBytes,
        });

        allDeepReads.push(...importReads);
        totalDeepReadBytes += importReads.reduce((s, f) => s + f.sizeBytes, 0);

        // Update the absolute path set with import-followed files
        const importAbsPaths = buildAbsPathSet(dir, importCandidates, importReads);
        for (const p of importAbsPaths) deepReadAbsPaths.add(p);

        logger.info("Import following completed", {
          filesRead: importReads.length,
          totalDeepReadBytes,
        });
        emitStep("imports.followed", {
          filesRead: importReads.length,
          totalDeepReadBytes,
        });
      } else {
        emitStep("imports.followed", {
          filesRead: 0,
          totalDeepReadBytes,
        });
      }
    } catch (err) {
      logger.warn("Import following failed, continuing with pass 1 results", {
        error: err instanceof Error ? err.message : String(err),
      });
      emitStep("imports.followed", {
        filesRead: 0,
        totalDeepReadBytes,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    emitStep("imports.followed", {
      filesRead: 0,
      totalDeepReadBytes,
      skipped: true,
    });
  }

  // ── Pass 2: Gap analysis + targeted search ──────────────────────────────

  let allReranked = reranked;

  if (enableIteration) {
    try {
      const gapQueries = await identifyGapsWithLite(question, reranked, allDeepReads);
      emitStep("gaps.identified", { count: gapQueries.length, queries: gapQueries });

      if (gapQueries.length > 0) {
        const pass2Evidence = await collectEvidence(question, dir, {
          ...evidenceOptions,
          overrideQueries: gapQueries,
          expandWithLlm: false,
          maxHits: ITERATE_MAX_ADDITIONAL_HITS,
        });

        // Dedup: only keep genuinely new hits
        const existingKeys = new Set(reranked.map(dedupKey));
        const newHits = pass2Evidence.filter((h) => !existingKeys.has(dedupKey(h)));

        logger.info("Pass 2: new evidence found", {
          searched: gapQueries.length,
          raw: pass2Evidence.length,
          new: newHits.length,
        });
        emitStep("iteration.pass2.completed", {
          searched: gapQueries.length,
          raw: pass2Evidence.length,
          newHits: newHits.length,
        });

        if (newHits.length > 0) {
          const rerankedNew = await rerankEvidenceWithLite(question, newHits);
          allReranked = [...reranked, ...rerankedNew];
          allReranked.sort((a, b) => b.score - a.score);

          // Deep-read new high-scoring files within remaining budget
          const pass2Candidates = selectFilesForDeepRead(rerankedNew, ITERATE_EXTRA_DEEP_READ)
            .filter((c) => !deepReadAbsPaths.has(c.path));

          if (pass2Candidates.length > 0) {
            const pass2DeepReads = await deepReadFiles(dir, pass2Candidates, {
              maxFileSize: DEEP_READ_MAX_FILE_SIZE,
              maxTotalSize: DEEP_READ_MAX_TOTAL_SIZE - totalDeepReadBytes,
              evidenceHits: rerankedNew,
            });

            allDeepReads.push(...pass2DeepReads);
            const pass2AbsPaths = buildAbsPathSet(dir, pass2Candidates, pass2DeepReads);
            for (const p of pass2AbsPaths) deepReadAbsPaths.add(p);

            logger.info("Pass 2: deep-read completed", {
              filesRead: pass2DeepReads.length,
            });
          }
        }
      } else {
        emitStep("iteration.pass2.completed", {
          searched: 0,
          raw: 0,
          newHits: 0,
        });
      }
    } catch (err) {
      logger.warn("Iterative pass failed, continuing with pass 1 results", {
        error: err instanceof Error ? err.message : String(err),
      });
      emitStep("gaps.identified", {
        count: 0,
        queries: [],
        error: err instanceof Error ? err.message : String(err),
      });
      emitStep("iteration.pass2.completed", {
        searched: 0,
        raw: 0,
        newHits: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    emitStep("gaps.identified", { count: 0, queries: [], skipped: true });
    emitStep("iteration.pass2.completed", {
      searched: 0,
      raw: 0,
      newHits: 0,
      skipped: true,
    });
  }

  // ── Final filtering ─────────────────────────────────────────────────────

  const filteredEvidence = allDeepReads.length > 0
    ? filterSnippetsForDeepRead(allReranked, deepReadAbsPaths)
    : allReranked;

  logger.info("Iterative pipeline completed", {
    totalDeepReads: allDeepReads.length,
    totalDeepReadBytes: allDeepReads.reduce((s, f) => s + f.sizeBytes, 0),
    filteredSnippets: filteredEvidence.length,
    totalEvidence: allReranked.length,
  });

  return {
    filteredEvidence,
    allEvidence: allReranked,
    deepReads: allDeepReads,
  };
}
