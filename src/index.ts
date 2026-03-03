#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./mcp.js";
import { logger } from "./util/log.js";

const server = createServer();
const transport = new StdioServerTransport();

logger.info("Starting needle-mcp server");
await server.connect(transport);
