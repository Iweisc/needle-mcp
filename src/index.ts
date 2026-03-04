#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./mcp.js";
import { startDashboard } from "./dashboard.js";
import { logger } from "./util/log.js";

const server = createServer();
const transport = new StdioServerTransport();

logger.info("Starting needle-mcp server");
await server.connect(transport);
logger.info("MCP ready");

// Start dashboard on a separate port (non-blocking, best-effort)
const dashboardPort = Number(process.env.NEEDLE_DASHBOARD_PORT) || 4242;
startDashboard(dashboardPort).catch((err) => {
  logger.warn("Dashboard failed to start", {
    error: err instanceof Error ? err.message : String(err),
  });
});
