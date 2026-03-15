# needle-mcp

An MCP server that answers questions about undocumented or bleeding-edge libraries by grounding answers in their actual source code. It resolves a resource (local path, npm package, or git repo), discovers its API surface, searches it with ripgrep using symbol-aware queries, synthesizes an answer via Amazon Bedrock, and returns a structured response with citations.

## Pipeline

```
resolve resource → discover API surface → ripgrep evidence → (optional web) → quality gate → Bedrock synthesis → (optional verify) → structured response
```

### API Surface Discovery

Before searching, needle reads the resource's `package.json`, locates entrypoints (`main`, `module`, `types`, `exports`), and scans barrel exports / `.d.ts` files to extract exported symbol names. This produces a shortlist of real API identifiers (function names, class names, types, hooks) that drive the search.

### Two-Pass Query Generation

1. **Symbol pass**: Queries generated from discovered exports (e.g., `createSanityInstance`, `useQuery`, `SanityApp`). These are the highest-priority queries since they target actual code identifiers.
2. **Question pass**: Code-like tokens extracted from the user's question — only terms with camelCase, underscores, or `@`-prefixes are kept. Generic English words like "use", "show", "app", "way" are filtered out.
3. **Intent patterns**: Structural patterns (`export function`, `export class`, `import.*from`) are added as fallback when symbol/question queries are sparse.

### Evidence Scoring

Hits are scored by file path to prioritize source code over documentation:

| Path pattern | Score modifier |
|---|---|
| `*.d.ts` | +5 |
| `src/**` | +4 |
| `packages/**` | +3.5 |
| `lib/**` | +3 |
| `examples/**` | +3 |
| `index.*` (any dir) | +2 |
| `test/**` | +1.5 |
| `*.ts` / `*.tsx` | +1 |
| `README*` | +0.5 |
| `*.md` | +0.25 |
| `dist/**` (non-.d.ts) | -4 |
| `*.min.js` | -5 |
| `node_modules/**` | -10 |

### Quality Gating

If fewer than 5 code hits (`.ts`, `.js`, `.d.ts`, etc.) exist in the top results, synthesis is skipped. Instead, the tool returns a low-confidence response with suggested follow-up queries. This prevents hallucinated answers from sparse/noisy evidence.

### Strict JSON Output

Synthesis responses are validated through a Zod schema. If the LLM returns invalid JSON, needle automatically retries once before falling back.

### Citation Integrity Guard

Needle now validates model-provided citations against the actual resource files before accepting synthesis output:

- Citation paths must resolve inside the target resource (no out-of-root paths).
- Citation line ranges must parse and be in-bounds for the target file.
- If all citations are invalid, synthesis fails safely with confidence `0`.
- If only some citations are invalid, invalid citations are dropped and confidence is downgraded.

This prevents high-confidence answers with fabricated or impossible line references.

### Snippet Verification Engine (Optional)

When `options.verify=true` and the resource is npm-based, Needle executes generated snippets in a sandboxed temp project:

1. **Direct mode**: runs snippet as-is.
2. **Assisted mode**: auto-imports package exports when snippets omit imports.
3. **Resolved mode**: resolves missing symbols from nested package modules across multiple passes.

Verifier robustness includes:

- Non-JS snippet detection (CLI commands, Python snippets) with explicit skip reasons.
- Syntax repair for missing object-literal braces in malformed calls.
- TypeScript annotation stripping for JS runtime compatibility (e.g. inline param/return annotations in `.mjs` snippets).
- Symbol exposure for accessor/re-export patterns (not only direct value descriptors).

## Prerequisites

- Node.js 20+
- pnpm
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) installed and on PATH
- AWS Bedrock access (Nova Premier model)
- Codex CLI (`codex`) installed for default baseline benchmarking

## Quickstart

```bash
pnpm install
pnpm build
NEEDLE_BEDROCK_BEARER_TOKEN=your-token pnpm start
```

## Dashboard

Needle MCP includes a local web dashboard for demos and debugging. When you run `pnpm start`, the dashboard starts automatically alongside the MCP stdio server.

```
Dashboard listening on 127.0.0.1:4242
```

Open **http://127.0.0.1:4242/** in your browser to:

- Run `needle.ask` queries through a web form
- Watch the pipeline execute in real-time (SSE-powered timeline)
- Browse evidence (top hits, deep-read files, web sources)
- View the final answer, code, citations, and confidence score
- Use **demo presets** backed by bundled, undocumented local libs (`knot-machine` hard mode, `quiet-router`, `pulse-cache`, `framepack`) for realistic no-doc demos
- Use a **judge/control preset** (`@anthropic-ai/sdk@0.78.0`) to verify grounded answers on a mainstream documented package

The dashboard binds to `127.0.0.1` only (no auth needed). Set `NEEDLE_DASHBOARD_PORT` to change the port.

Preset sources live under `./demo-resources/*` and intentionally do not include docs.

### Hard-Mode Demo Resource

`./demo-resources/knot-machine` is a deliberately difficult local target for stress-testing code-grounded reasoning:

- Multi-file architecture (`parse`, `plan`, `runtime`, `ops`, `wire`).
- SCC/Tarjan-based control-flow analysis and component ranking.
- Runtime loop guards and dynamic operation dispatch.
- Bytecode envelope encoding/decoding with checksum validation.

The demo resource sources are minified to simulate poor readability conditions common in undocumented libraries.

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `NEEDLE_BEDROCK_BEARER_TOKEN` | Yes | — | Bearer token for Bedrock API auth |
| `NEEDLE_AWS_REGION` | No | `us-east-1` | AWS region for Bedrock endpoint |
| `NEEDLE_SEARXNG_URL` | No | `http://localhost:8889/search` | Preferred SearXNG URL for web evidence (comma-separated list supported); falls back to Brave search HTML parsing when unavailable |
| `NEEDLE_DASHBOARD_PORT` | No | `4242` | Port for the web dashboard |

## MCP Client Configuration

### Claude Desktop

Add to your Claude Desktop config (`~/.config/claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "needle": {
      "command": "node",
      "args": ["/path/to/needle-mcp/dist/index.js"],
      "env": {
        "NEEDLE_BEDROCK_BEARER_TOKEN": "your-token"
      }
    }
  }
}
```

### OpenAI Codex CLI

```bash
codex mcp add needle --env NEEDLE_BEDROCK_BEARER_TOKEN=your-token -- node /path/to/needle-mcp/dist/index.js
```

## Example Usage

The server exposes a single tool `needle.ask`. Example invocation:

```json
{
  "resource": {
    "type": "npm",
    "spec": "@bugreels/web-script@latest"
  },
  "question": "How do I create a new script instance and run it?",
  "options": {
    "language": "ts",
    "maxHits": 30,
    "enableWeb": false,
    "verify": false
  }
}
```

Local hard-mode example:

```json
{
  "resource": {
    "type": "local",
    "spec": "./demo-resources/knot-machine"
  },
  "question": "Explain how parseProgram(), buildPlan() SCC ranking, executePlan() loop_guard, and bytecode checksum validation interact.",
  "options": {
    "language": "js",
    "maxHits": 80,
    "contextLines": 4,
    "enableWeb": false,
    "verify": false
  }
}
```

### Resource Types

- **`local`**: Point to a directory on disk — `{ "type": "local", "spec": "/path/to/repo" }`
- **`npm`**: Any valid npm specifier — `{ "type": "npm", "spec": "package@version" }`
- **`git`**: Git URL with optional `#ref` — `{ "type": "git", "spec": "https://github.com/user/repo#main" }`

## Development

```bash
pnpm test          # Run unit tests
pnpm test:watch    # Watch mode
pnpm build         # Compile TypeScript
```

## Benchmarks, Graphs, and Impact

Needle includes a built-in benchmark runner that compares:

- **Needle** (grounded pipeline + citations)
- **Baseline** (headless `codex exec` answer without source/tool grounding)

The benchmark suite currently uses 8 deterministic local no-doc cases across:

- `quiet-router`
- `pulse-cache`
- `framepack`
- `knot-machine`

Each case is scored against explicit implementation facts. A case is considered **correct** when fact coverage is at least 75% (and for Needle, includes at least one valid citation).
Expected-time metrics use a conservative 5% correctness floor to avoid divide-by-zero when a baseline has zero fully-correct cases.

### Run Live Benchmark

```bash
NEEDLE_BEDROCK_BEARER_TOKEN=your-token ./benchmark
```

Artifacts are generated under `benchmark-results/latest/`:

- `summary.json` (full machine-readable output)
- `scores.csv` (per-case rows)
- `report.md` (judge-friendly summary table)
- `impact.md` (time/cost impact estimate)
- `graphs/*.svg` (ready-to-embed charts)

Generated charts:

- `graphs/fact-coverage.svg`
- `graphs/correctness-rate.svg`
- `graphs/expected-time-to-correct.svg`
- `graphs/case-fact-coverage.svg`
- `graphs/time-cut-percent.svg`
- `graphs/weekly-time-saved.svg`
- `graphs/hallucination-tax-scenario.svg`

Additional impact tuning env vars:

- `NEEDLE_BENCH_QPW` (default `12`) — questions per engineer per week
- `NEEDLE_BENCH_TEAM_SIZE` (default `6`) — team size for impact model
- `NEEDLE_BENCH_COST_PER_HOUR` (default `90`) — loaded engineering cost/hour (USD)
- `NEEDLE_BENCH_AI_HOURS_PER_DEV_WEEK` (default `20`) — modeled AI-assisted coding hours for hallucination-tax scenario
- `NEEDLE_BENCH_BASELINE_PROVIDER` (default `codex`) — `codex` or `bedrock`
- `NEEDLE_BENCH_CODEX_MODEL` (default `gpt-5.4`) — model passed to `codex exec`
- `NEEDLE_BENCH_CODEX_TIMEOUT_MS` (default `180000`) — per-case timeout for `codex exec`

If you switch baseline provider to Bedrock (`NEEDLE_BENCH_BASELINE_PROVIDER=bedrock`), baseline uses Nova Premier.

### Generate Sample Graphs (No Bedrock Token)

```bash
./benchmark sample
```

This writes synthetic sample outputs with the same schema/layout, useful for CI wiring and slide design before running the real benchmark.

### Rebuild Graphs From Existing Results

```bash
./benchmark graphs
```

Optional:

```bash
./benchmark graphs --input benchmark-results/latest/summary.json --output benchmark-results/latest
```

## Hackathon Submission Playbook

Judge-facing demo flow, rubric mapping, Nova-first framing, and before/after narrative template:

- [`docs/hackathon-playbook.md`](docs/hackathon-playbook.md)
- [`docs/impact-evidence.md`](docs/impact-evidence.md)
