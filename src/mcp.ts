import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { NeedleAskInputSchema } from "./types.js";
import type { NeedleAskOutput } from "./types.js";
import { resolveResource } from "./resource.js";
import { discoverApiSurface } from "./discover.js";
import { collectWebEvidence } from "./web.js";
import { synthesizeAnswer } from "./synth.js";
import { runIterativePipeline } from "./iterate.js";
import { verifySnippet } from "./verify.js";
import { logger } from "./util/log.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "needle-mcp",
    version: "0.2.0",
  });

  server.tool(
    "needle.ask",
    "Answer questions about a library/codebase by searching its source code, synthesizing evidence with an LLM, and returning a grounded answer with citations.",
    NeedleAskInputSchema.shape,
    async (raw) => {
      const input = NeedleAskInputSchema.parse(raw);
      logger.info("needle.ask called", {
        resource: input.resource,
        question: input.question,
      });

      let cleanup: (() => Promise<void>) | undefined;

      try {
        // 1. Resolve resource
        const resolved = await resolveResource(input.resource);
        cleanup = resolved.cleanup;
        logger.info("Resource resolved", { dir: resolved.dir });

        // 2. Discover API surface (entrypoints, exports, symbols)
        const surface = await discoverApiSurface(resolved.dir);
        logger.info("API surface discovered", {
          symbols: surface.symbols.length,
          entrypoints: surface.entrypoints.length,
        });

        // 3. Iterative evidence pipeline (collect → rerank → deep-read → import follow → gap analysis → pass 2)
        const { filteredEvidence, allEvidence, deepReads } = await runIterativePipeline(
          input.question,
          resolved.dir,
          {
            evidenceOptions: {
              language: input.options.language,
              maxHits: input.options.maxHits,
              contextLines: input.options.contextLines,
              surface,
              expandWithLlm: true,
            },
          },
        );

        // 4. Collect web evidence (optional)
        let webEvidence: Awaited<ReturnType<typeof collectWebEvidence>> = [];
        if (input.options.enableWeb) {
          webEvidence = await collectWebEvidence(input.question);
          logger.info("Web evidence collected", { hits: webEvidence.length });
        }

        // 5. Synthesize answer (includes quality gating)
        const output = await synthesizeAnswer(
          input.question,
          filteredEvidence,
          webEvidence,
          deepReads,
        );

        // 6. Verify (optional, best-effort)
        if (input.options.verify && output.code) {
          const spec =
            input.resource.type === "npm"
              ? input.resource.spec
              : undefined;
          if (spec) {
            const result = await verifySnippet(spec, output.code);
            if (result.success) {
              output.notes = output.notes
                ? `${output.notes}\nVerification passed.`
                : "Verification passed.";
            } else {
              output.notes = output.notes
                ? `${output.notes}\nVerification failed: ${result.stderr}`
                : `Verification failed: ${result.stderr}`;
            }
          }
        }

        // Include resource dir for local resources
        if (input.resource.type === "local") {
          output.evidence.resourceDir = resolved.dir;
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (err) {
        logger.error("needle.ask failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
              }),
            },
          ],
          isError: true,
        };
      } finally {
        if (cleanup) {
          await cleanup().catch((err) =>
            logger.error("Cleanup failed", {
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
    },
  );

  return server;
}
