import type { NeedleAskInput, NeedleAskOutput } from "./types.js";
import { resolveResource } from "./resource.js";
import { discoverApiSurface } from "./discover.js";
import { collectWebEvidence } from "./web.js";
import { synthesizeAnswer } from "./synth.js";
import { runIterativePipeline } from "./iterate.js";
import { verifySnippet } from "./verify.js";
import { logger } from "./util/log.js";
import type { RunLogger } from "./events.js";

/**
 * Run the full needle.ask pipeline.
 * Optionally emits events via a RunLogger for dashboard live updates.
 * This is the shared core used by both the MCP tool handler and the dashboard API.
 */
export async function runNeedlePipeline(
  input: NeedleAskInput,
  rl?: RunLogger,
): Promise<NeedleAskOutput> {
  logger.info("needle.ask called", {
    resource: input.resource,
    question: input.question,
  });

  let cleanup: (() => Promise<void>) | undefined;

  try {
    // 1. Resolve resource
    rl?.markStepStart("resource.resolved");
    const resolved = await resolveResource(input.resource);
    cleanup = resolved.cleanup;
    logger.info("Resource resolved", { dir: resolved.dir });
    rl?.emit("resource.resolved", {
      dir: resolved.dir,
      type: input.resource.type,
      spec: input.resource.spec,
    });

    // 2. Discover API surface
    rl?.markStepStart("surface.discovered");
    const surface = await discoverApiSurface(resolved.dir);
    logger.info("API surface discovered", {
      symbols: surface.symbols.length,
      entrypoints: surface.entrypoints.length,
    });
    rl?.emit("surface.discovered", {
      entrypointsCount: surface.entrypoints.length,
      symbolsCount: surface.symbols.length,
      topSymbols: surface.symbols.slice(0, 10),
    });

    // 3. Iterative evidence pipeline
    rl?.markStepStart("evidence.collected");
    const { filteredEvidence, allEvidence, deepReads } =
      await runIterativePipeline(input.question, resolved.dir, {
        evidenceOptions: {
          language: input.options.language,
          maxHits: input.options.maxHits,
          contextLines: input.options.contextLines,
          surface,
          expandWithLlm: true,
        },
        onStep: (step, data) => rl?.emit(step, data),
      });

    rl?.emit("evidence.collected", {
      hits: allEvidence.length,
      filteredHits: filteredEvidence.length,
      deepReadFiles: deepReads.map((f) => ({
        path: f.path,
        sizeBytes: f.sizeBytes,
      })),
      deepReadCount: deepReads.length,
      totalDeepReadBytes: deepReads.reduce((s, f) => s + f.sizeBytes, 0),
    });

    // 4. Collect web evidence (optional)
    let webEvidence: Awaited<ReturnType<typeof collectWebEvidence>> = [];
    if (input.options.enableWeb) {
      rl?.markStepStart("web.collected");
      webEvidence = await collectWebEvidence(input.question);
      logger.info("Web evidence collected", { hits: webEvidence.length });
      rl?.emit("web.collected", {
        hits: webEvidence.length,
        sources: webEvidence.map((w) => ({ title: w.title, url: w.url })),
      });
    }

    // 5. Synthesize answer
    rl?.markStepStart("synthesis.completed");
    const output = await synthesizeAnswer(
      input.question,
      filteredEvidence,
      webEvidence,
      deepReads,
    );
    rl?.emit("synthesis.completed", {
      confidence: output.confidence,
      citationsCount: output.citations.length,
      answerLength: output.answer.length,
      codeLength: output.code.length,
    });

    // 6. Verify (optional, best-effort)
    if (input.options.verify && output.code) {
      const spec =
        input.resource.type === "npm" ? input.resource.spec : undefined;
      if (spec) {
        rl?.markStepStart("verify.completed");
        const result = await verifySnippet(spec, output.code);
        if (result.success) {
          const verificationNote = result.mode !== "direct"
            ? "Verification passed with assisted imports (snippet likely omitted explicit imports)."
            : "Verification passed.";
          output.notes = output.notes
            ? `${output.notes}\n${verificationNote}`
            : verificationNote;
        } else if (result.mode === "skipped") {
          output.notes = output.notes
            ? `${output.notes}\nVerification skipped: ${result.stderr}`
            : `Verification skipped: ${result.stderr}`;
        } else {
          output.notes = output.notes
            ? `${output.notes}\nVerification failed: ${result.stderr}`
            : `Verification failed: ${result.stderr}`;
        }
        rl?.emit("verify.completed", {
          success: result.success,
          skipped: result.mode === "skipped",
          stdoutTail: result.stdout.slice(-500),
          stderrTail: result.stderr.slice(-500),
        });
      }
    }

    // Include resource dir for local resources
    if (input.resource.type === "local") {
      output.evidence.resourceDir = resolved.dir;
    }

    return output;
  } finally {
    if (cleanup) {
      await cleanup().catch((err) =>
        logger.error("Cleanup failed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
}
