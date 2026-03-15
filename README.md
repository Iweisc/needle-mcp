# needle-mcp

Needle is an MCP server for questions about undocumented, unstable, or fast-moving libraries. It resolves a package or repo, searches the actual source, reads the files that matter, and answers with citations instead of guessing from model memory.

It supports local directories, npm packages, and git repositories. The same core pipeline powers both the MCP tool and the local dashboard.

## Current Build

- Multi-model pipeline: Nova Lite handles query expansion, evidence reranking, and gap analysis; Nova Premier handles final synthesis.
- Iterative evidence collection: pass 1 search, rerank, deep read, import following, then a second targeted search pass.
- Citation integrity checks: citations are validated against real files and line ranges before an answer is accepted.
- Optional snippet verification for npm packages, including assisted import recovery and nested export resolution.
- Local dashboard with live pipeline events, bundled demo resources, and a judge/control preset.
- Benchmark suite that compares Needle against an ungrounded baseline and generates reports plus SVG charts.

## How It Works

```text
resolve resource
  -> discover API surface
  -> collect pass 1 evidence with ripgrep
  -> Nova Lite rerank
  -> deep-read top files
  -> follow relative imports
  -> Nova Lite gap analysis
  -> collect pass 2 evidence
  -> optional web evidence
  -> Nova Premier synthesis
  -> citation validation
  -> optional snippet verification
  -> structured response
```

### Resource Resolution

- `local`: uses a directory already on disk
- `npm`: extracts the package into a temp workspace with `pacote`
- `git`: does a shallow clone and optionally checks out `#ref`

### API Surface Discovery

Before search starts, Needle reads the target's `package.json` and looks for entrypoints from `main`, `module`, `types`, `typings`, and `exports`. It scans those files, prefers `.d.ts` siblings when available, and builds a shortlist of real exported symbols.

That shortlist becomes the starting point for search, which cuts down a lot of noise on packages with weak docs or large dist output.

### Query Generation

Search queries come from four places:

1. Exported symbols discovered from the target package
2. Code-like tokens pulled from the user question
3. Intent patterns such as `export function`, `import.*from`, and common config or constructor shapes
4. Nova Lite query expansion for semantic search terms that the question implies but does not literally mention

Generic English filler words are filtered out before Needle hits ripgrep.

### Evidence Ranking

Needle scores hits by path before reranking. Source files and type definitions outrank docs, and junk like minified bundles or `node_modules` is heavily penalized.

After the initial pass, Nova Lite reranks the collected hits for relevance to the question. Needle then:

- deep-reads the highest-value files
- follows relative imports found in those files
- asks Nova Lite what evidence is still missing
- runs a second targeted ripgrep pass for those gaps

If a file is too large to deep-read whole, Needle extracts only the relevant chunks around evidence hits.

### Safety Guards

- Quality gate: if there are too few code hits and no strong full-file context, Needle returns a low-confidence fallback instead of synthesizing.
- Structured output: synthesis is validated through Zod. Needle retries malformed responses and can run a repair pass if needed.
- Citation validation: cited files must resolve inside the target resource and cited line ranges must be valid. Invalid citations are dropped, confidence is downgraded, and fully invalid answers fail safely.
- Verification: when `options.verify=true` on an npm resource, Needle executes generated snippets in a temp sandbox.

Verification supports three execution modes:

- `direct`: runs the snippet as generated
- `assisted`: auto-imports the package when the snippet omitted imports
- `resolved`: searches nested package modules to recover missing exported symbols

Non-JavaScript snippets, empty snippets, or obvious CLI examples are skipped with an explicit note instead of being treated as runtime failures.

## Requirements

- Node.js 20+
- pnpm
- [ripgrep](https://github.com/BurntSushi/ripgrep) available as `rg`
- AWS Bedrock access with a bearer token
- `codex` installed if you want to run the default benchmark baseline

## Quick Start

```bash
pnpm install
pnpm build
NEEDLE_BEDROCK_BEARER_TOKEN=your-token pnpm start
```

That starts two things:

- the MCP stdio server
- the local dashboard on `127.0.0.1:4242`

If you only want to run the built server directly:

```bash
NEEDLE_BEDROCK_BEARER_TOKEN=your-token node dist/index.js
```

## Environment Variables

### Runtime

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `NEEDLE_BEDROCK_BEARER_TOKEN` | Yes | none | Bearer token for Bedrock auth |
| `NEEDLE_AWS_REGION` | No | `us-east-1` | Bedrock region |
| `NEEDLE_SEARXNG_URL` | No | `http://localhost:8889/search` | Preferred SearXNG endpoint for optional web evidence. Comma-separated values are allowed. Needle falls back to Brave HTML parsing if all configured endpoints fail. |
| `NEEDLE_DASHBOARD_PORT` | No | `4242` | Dashboard port |

### Benchmarking

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEEDLE_BENCH_QPW` | `12` | Questions per engineer per week in the impact model |
| `NEEDLE_BENCH_TEAM_SIZE` | `6` | Team size in the impact model |
| `NEEDLE_BENCH_COST_PER_HOUR` | `90` | Loaded engineering cost per hour in USD |
| `NEEDLE_BENCH_AI_HOURS_PER_DEV_WEEK` | `20` | AI-assisted coding hours used in the hallucination-tax scenario |
| `NEEDLE_BENCH_BASELINE_PROVIDER` | `codex` | Baseline system: `codex` or `bedrock` |
| `NEEDLE_BENCH_CODEX_MODEL` | `gpt-5.4` | Model passed to `codex exec` |
| `NEEDLE_BENCH_CODEX_TIMEOUT_MS` | `180000` | Timeout per Codex baseline case |

If you switch `NEEDLE_BENCH_BASELINE_PROVIDER=bedrock`, the baseline answer comes from Nova Premier instead of `codex exec`.

## MCP Setup

### Claude Desktop

Add this to `~/.config/claude/claude_desktop_config.json`:

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

## MCP Tool

Needle exposes one tool: `needle.ask`.

### Input

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
    "contextLines": 3,
    "enableWeb": false,
    "verify": false
  }
}
```

### Input Fields

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `resource.type` | `local \| npm \| git` | none | Target resource kind |
| `resource.spec` | `string` | none | Local path, npm specifier, or git URL with optional `#ref` |
| `question` | `string` | none | Natural-language question about the target |
| `options.language` | `ts \| js \| any` | `any` | Restricts evidence file types |
| `options.maxHits` | `number` | `60` | Maximum evidence hits passed downstream |
| `options.contextLines` | `number` | `3` | Context lines around each ripgrep hit |
| `options.enableWeb` | `boolean` | `false` | Adds web evidence via SearXNG or Brave fallback |
| `options.verify` | `boolean` | `false` | Attempts snippet execution for npm resources when the answer includes code |

### Resource Examples

- `local`: `{ "type": "local", "spec": "/path/to/repo" }`
- `npm`: `{ "type": "npm", "spec": "package@version" }`
- `git`: `{ "type": "git", "spec": "https://github.com/user/repo#main" }`

### Output Shape

Needle returns structured JSON with these fields:

- `answer`: grounded explanation
- `code`: example snippet, if one was produced
- `confidence`: `0..1`
- `citations`: validated file and line references
- `evidence.hits`: ranked evidence snippets
- `evidence.resourceDir`: included for local resources
- `nextQueries`: follow-up queries when confidence is low or evidence is thin
- `notes`: verification notes, quality-gate notes, or repair/citation warnings

### Local Demo Example

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

## Dashboard

When you run `pnpm start`, Needle also starts a local dashboard at [http://127.0.0.1:4242/](http://127.0.0.1:4242/).

The dashboard is for demos and debugging. It can:

- submit `needle.ask` runs through a web form
- stream pipeline events live over SSE
- show the reranked top hits
- show deep-read files and web evidence
- show final answer, code, citations, notes, and confidence
- replay recent runs from an in-memory history

The server binds to `127.0.0.1` only. There is no auth layer, so keep it local.

### Dashboard API

The UI talks to a small local HTTP API:

- `GET /` returns the dashboard UI
- `POST /api/run` starts a run and returns `202 { "runId": "..." }`
- `GET /api/runs` lists recent runs
- `GET /api/runs/:id` returns one run with input, output, and event log
- `GET /api/stream` streams live pipeline events over SSE

## Demo Resources

The repository ships with bundled local targets under `./demo-resources/`:

- `quiet-router`: route tokenization and scoring
- `pulse-cache`: TTL cache behavior with jitter
- `framepack`: binary frame encoding and checksum validation
- `knot-machine`: deliberately difficult hard-mode target with minified multi-file internals

The dashboard also includes a judge/control preset for `@anthropic-ai/sdk@0.78.0` so you can compare Needle against a mainstream package whose behavior is easy to verify manually.

## Benchmark Suite

Needle includes a benchmark runner that compares:

- `needle`: the grounded pipeline with citations
- `baseline`: an ungrounded answer from either `codex exec` or Nova Premier

The benchmark suite uses 8 deterministic local cases across the bundled demo resources. Each case has explicit implementation facts, and a run is counted as correct at 75% fact coverage. Needle also needs at least one valid citation for a case to count as correct.

Expected-time metrics use a conservative 5% correctness floor so the comparison still works when a baseline gets zero fully correct answers.

### Run A Live Benchmark

```bash
NEEDLE_BEDROCK_BEARER_TOKEN=your-token ./benchmark
```

Equivalent npm script:

```bash
pnpm benchmark
```

### Generate Sample Artifacts

This mode does not need a Bedrock token.

```bash
./benchmark sample
```

Equivalent npm script:

```bash
pnpm benchmark:sample
```

### Rebuild Graphs And Reports From Existing Results

```bash
./benchmark graphs
```

Equivalent npm script:

```bash
pnpm benchmark:graphs
```

Optional flags:

```bash
./benchmark graphs --input benchmark-results/latest/summary.json --output benchmark-results/latest
```

### Benchmark Artifacts

Artifacts are written to `benchmark-results/latest/` by default:

- `summary.json`: full machine-readable output
- `scores.csv`: one row per system per case
- `report.md`: benchmark summary table
- `impact.md`: time and cost impact model
- `graphs/fact-coverage.svg`
- `graphs/correctness-rate.svg`
- `graphs/expected-time-to-correct.svg`
- `graphs/case-fact-coverage.svg`
- `graphs/time-cut-percent.svg`
- `graphs/weekly-time-saved.svg`
- `graphs/hallucination-tax-scenario.svg`

## Development

```bash
pnpm test
pnpm test:watch
pnpm build
```

## Supporting Docs

- [`docs/hackathon-playbook.md`](docs/hackathon-playbook.md)
- [`docs/impact-evidence.md`](docs/impact-evidence.md)
