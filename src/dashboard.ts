import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NeedleAskInputSchema } from "./types.js";
import type { NeedleAskInput, NeedleAskOutput } from "./types.js";
import { runNeedlePipeline } from "./pipeline.js";
import { needleEvents, createRunLogger, generateRunId } from "./events.js";
import type { NeedleEvent } from "./events.js";
import { logger } from "./util/log.js";

// ── Run storage (ring buffer) ───────────────────────────────────────────────

const MAX_RUNS = 50;

interface RunRecord {
  runId: string;
  input: NeedleAskInput;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  output?: NeedleAskOutput;
  error?: string;
  events: NeedleEvent[];
}

const runs = new Map<string, RunRecord>();
const runOrder: string[] = []; // oldest first

function addRun(record: RunRecord): void {
  runs.set(record.runId, record);
  runOrder.push(record.runId);
  // Evict oldest if over capacity
  while (runOrder.length > MAX_RUNS) {
    const oldest = runOrder.shift()!;
    runs.delete(oldest);
  }
}

// ── SSE clients ─────────────────────────────────────────────────────────────

const sseClients = new Set<ServerResponse>();

function broadcastSSE(event: NeedleEvent): void {
  const data = JSON.stringify(event);
  for (const client of sseClients) {
    try {
      client.write(`data: ${data}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

// Subscribe to pipeline events
needleEvents.on("event", (event: NeedleEvent) => {
  const run = runs.get(event.runId);
  if (run) {
    run.events.push(event);
  }
  broadcastSSE(event);
});

// ── HTTP helpers ────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(json);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// ── Route handlers ──────────────────────────────────────────────────────────

async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  let input: NeedleAskInput;
  try {
    input = NeedleAskInputSchema.parse(parsed);
  } catch (err) {
    sendJson(res, 400, {
      error: "Invalid input",
      details: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const runId = generateRunId();
  const record: RunRecord = {
    runId,
    input,
    status: "running",
    startedAt: new Date().toISOString(),
    events: [],
  };
  addRun(record);

  const rl = createRunLogger(runId);
  rl.emit("run.started", {
    resource: input.resource,
    question: input.question,
    options: input.options,
  });

  // Return runId immediately, execute pipeline async
  sendJson(res, 202, { runId });

  // Run pipeline in background
  runNeedlePipeline(input, rl)
    .then((output) => {
      record.status = "completed";
      record.completedAt = new Date().toISOString();
      record.output = output;
      rl.emit("run.completed", {
        confidence: output.confidence,
        answerLength: output.answer.length,
        citationsCount: output.citations.length,
      });
    })
    .catch((err) => {
      record.status = "failed";
      record.completedAt = new Date().toISOString();
      record.error = err instanceof Error ? err.message : String(err);
      rl.emit("run.failed", {
        error: record.error,
      });
    });
}

function handleGetRuns(_req: IncomingMessage, res: ServerResponse): void {
  const summaries = runOrder
    .map((id) => runs.get(id))
    .filter(Boolean)
    .reverse()
    .map((r) => ({
      runId: r!.runId,
      status: r!.status,
      startedAt: r!.startedAt,
      completedAt: r!.completedAt,
      question: r!.input.question,
      resource: r!.input.resource,
      confidence: r!.output?.confidence,
      eventCount: r!.events.length,
    }));
  sendJson(res, 200, summaries);
}

function handleGetRun(runId: string, _req: IncomingMessage, res: ServerResponse): void {
  const run = runs.get(runId);
  if (!run) {
    sendJson(res, 404, { error: "Run not found" });
    return;
  }
  sendJson(res, 200, {
    runId: run.runId,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    input: run.input,
    output: run.output,
    error: run.error,
    events: run.events,
  });
}

function handleSSE(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write(":\n\n"); // SSE comment to keep alive

  sseClients.add(res);

  res.on("close", () => {
    sseClients.delete(res);
  });
}

async function serveStatic(res: ServerResponse): Promise<void> {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const htmlPath = join(__dirname, "..", "public", "index.html");
    const html = await readFile(htmlPath, "utf-8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Failed to load dashboard UI");
    logger.error("Failed to serve dashboard HTML", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Server ──────────────────────────────────────────────────────────────────

export function startDashboard(port = 4242, host = "127.0.0.1"): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createHttpServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${host}:${port}`);
      const method = req.method?.toUpperCase() ?? "GET";

      // CORS preflight
      if (method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      try {
        // Route matching
        if (method === "GET" && url.pathname === "/") {
          await serveStatic(res);
        } else if (method === "POST" && url.pathname === "/api/run") {
          await handleRun(req, res);
        } else if (method === "GET" && url.pathname === "/api/runs") {
          handleGetRuns(req, res);
        } else if (method === "GET" && url.pathname.startsWith("/api/runs/")) {
          const runId = url.pathname.slice("/api/runs/".length);
          handleGetRun(runId, req, res);
        } else if (method === "GET" && url.pathname === "/api/stream") {
          handleSSE(req, res);
        } else {
          sendJson(res, 404, { error: "Not found" });
        }
      } catch (err) {
        logger.error("Dashboard request error", {
          path: url.pathname,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) {
          sendJson(res, 500, { error: "Internal server error" });
        }
      }
    });

    server.on("error", reject);
    server.listen(port, host, () => {
      logger.info(`Dashboard listening on ${host}:${port}`);
      resolve();
    });
  });
}
