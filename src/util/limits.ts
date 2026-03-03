/** Ripgrep search timeout in ms */
export const RG_TIMEOUT = 30_000;

/** Bedrock converse timeout in ms */
export const BEDROCK_TIMEOUT = 120_000;

/** Web evidence fetch timeout in ms */
export const WEB_TIMEOUT = 15_000;

/** Verify snippet timeout in ms */
export const VERIFY_TIMEOUT = 30_000;

/** Maximum file size for ripgrep (bytes) */
export const MAX_FILE_SIZE = "512K";

/** Default maximum evidence hits */
export const DEFAULT_MAX_HITS = 60;

/** Confidence below this triggers a "low confidence" note */
export const LOW_CONFIDENCE_THRESHOLD = 0.4;

// ── Nova Lite agent constants ────────────────────────────────────────────────

/** Timeout for Nova Lite agent calls in ms */
export const LITE_TIMEOUT = 30_000;

/** Max output tokens for Nova Lite calls */
export const LITE_MAX_TOKENS = 1024;

/** Number of evidence hits per rerank batch */
export const RERANK_BATCH_SIZE = 20;

/** Weight applied to Nova Lite relevance scores when combining with path score */
export const RELEVANCE_WEIGHT = 5;

/** Maximum expanded queries returned by Nova Lite */
export const MAX_EXPANDED_QUERIES = 10;

// ── Deep file read constants ─────────────────────────────────────────────────

/** Maximum number of files to deep-read */
export const DEEP_READ_MAX_FILES = 8;

/** Maximum size of a single file to deep-read (bytes) */
export const DEEP_READ_MAX_FILE_SIZE = 32_768;

/** Maximum total size of all deep-read files combined (bytes) */
export const DEEP_READ_MAX_TOTAL_SIZE = 204_800;

/** When deep reads are active, cap snippet evidence to this count */
export const DEEP_READ_SNIPPET_CAP = 30;

// ── Iterative pipeline constants ─────────────────────────────────────────────

/** Maximum follow-up queries from gap analysis */
export const GAP_MAX_QUERIES = 8;

/** Timeout for gap analysis Nova Lite call (ms) */
export const GAP_ANALYSIS_TIMEOUT = 15_000;

/** Maximum additional evidence hits from second pass */
export const ITERATE_MAX_ADDITIONAL_HITS = 30;

/** Maximum additional files to deep-read in the second pass */
export const ITERATE_EXTRA_DEEP_READ = 4;

// ── Import following constants ──────────────────────────────────────────────

/** Maximum import-followed files to attempt reading */
export const IMPORT_FOLLOW_MAX_FILES = 6;

/** Score decay factor for import-followed files */
export const IMPORT_SCORE_DECAY = 0.8;

// ── Smart chunking constants ────────────────────────────────────────────────

/** Lines of context around each evidence cluster in a chunked file */
export const CHUNK_CONTEXT_LINES = 30;

/** Max gap between hits (in lines) to merge into one cluster */
export const CHUNK_MERGE_GAP = 15;

/** Maximum chunked content size per file (bytes) */
export const CHUNK_MAX_SIZE_PER_FILE = 16_384;

/** Source file glob patterns for ripgrep */
export const SOURCE_GLOBS = [
  "*.ts",
  "*.tsx",
  "*.js",
  "*.jsx",
  "*.mjs",
  "*.cjs",
  "*.d.ts",
  "*.md",
  "*.mdx",
  "*.json",
];
