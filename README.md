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

## Prerequisites

- Node.js 20+
- pnpm
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) installed and on PATH
- AWS Bedrock access (Nova Premier model)

## Quickstart

```bash
pnpm install
pnpm build
NEEDLE_BEDROCK_BEARER_TOKEN=your-token pnpm start
```

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `NEEDLE_BEDROCK_BEARER_TOKEN` | Yes | — | Bearer token for Bedrock API auth |
| `NEEDLE_AWS_REGION` | No | `us-east-1` | AWS region for Bedrock endpoint |
| `NEEDLE_SEARXNG_URL` | No | `http://localhost:8889/search` | SearXNG instance URL for web evidence |

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

### Resource Types

- **`local`**: Point to a directory on disk — `{ "type": "local", "spec": "/path/to/repo" }`
- **`npm`**: Any valid npm specifier — `{ "type": "npm", "spec": "package@version" }`
- **`git`**: Git URL with optional `#ref` — `{ "type": "git", "spec": "https://github.com/user/repo#main" }`

## Development

```bash
pnpm test          # Run unit tests (45 tests)
pnpm test:watch    # Watch mode
pnpm build         # Compile TypeScript
```
