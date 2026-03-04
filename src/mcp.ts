import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { NeedleAskInputSchema } from "./types.js";
import { runNeedlePipeline } from "./pipeline.js";
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

      try {
        const output = await runNeedlePipeline(input);

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
      }
    },
  );

  return server;
}
