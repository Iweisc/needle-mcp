import type { NeedleAskInput } from "../types.js";

export interface BenchmarkFact {
  id: string;
  description: string;
  patterns: readonly RegExp[];
}

export interface BenchmarkCase {
  id: string;
  title: string;
  input: NeedleAskInput;
  facts: readonly BenchmarkFact[];
}

const DEFAULT_OPTIONS: NeedleAskInput["options"] = {
  language: "any",
  maxHits: 80,
  contextLines: 4,
  enableWeb: false,
  verify: false,
};

function makeInput(spec: string, question: string): NeedleAskInput {
  return {
    resource: {
      type: "local",
      spec,
    },
    question,
    options: DEFAULT_OPTIONS,
  };
}

export const BENCHMARK_CASES: readonly BenchmarkCase[] = [
  {
    id: "quiet-router-routing",
    title: "quiet-router: pattern tokenization + route selection",
    input: makeInput(
      "./demo-resources/quiet-router",
      "How do tokenizePattern() and selectRoute() handle static segments, :params, and ** wildcards?",
    ),
    facts: [
      {
        id: "token-kinds",
        description: "tokenizePattern classifies segments into static/param/wildcard kinds",
        patterns: [
          /\bstatic\b.*\bparam\b.*\bwildcard\b/i,
          /tokenizePattern.*wildcard/i,
        ],
      },
      {
        id: "param-decoding",
        description: "param values are decoded with decodeURIComponent",
        patterns: [
          /decodeURIComponent/i,
          /param.*(?:url|decode)/i,
        ],
      },
      {
        id: "wildcard-rest-capture",
        description: "wildcard captures the remaining path into * and can be empty for terminal wildcard",
        patterns: [
          /captures?.*rest.*\*/i,
          /\["\*"\]/i,
          /wildcard.*empty string/i,
        ],
      },
      {
        id: "select-best-score",
        description: "selectRoute picks the matched route with highest score",
        patterns: [
          /selectRoute.*highest.*score/i,
          /x\.score>b\.route\.score/i,
          /best.*score/i,
        ],
      },
    ],
  },
  {
    id: "quiet-router-scoring",
    title: "quiet-router: specificity scoring behavior",
    input: makeInput(
      "./demo-resources/quiet-router",
      "Explain how route scoring prefers static over params over wildcards. Include where score is computed and used.",
    ),
    facts: [
      {
        id: "score-weights",
        description: "scoreTokens uses +3 static, +1 param, and -2 wildcard",
        patterns: [
          /static.*\+?3.*param.*\+?1.*wildcard.*-2/i,
          /scoreTokens/i,
        ],
      },
      {
        id: "score-computed-compile",
        description: "compileRoute stores score alongside tokens",
        patterns: [
          /compileRoute.*score/i,
          /score:\s*scoreTokens/i,
        ],
      },
      {
        id: "score-used-select",
        description: "selectRoute compares route scores to choose winner",
        patterns: [
          /selectRoute/i,
          /x\.score>b\.route\.score/i,
          /highest.*score/i,
        ],
      },
      {
        id: "terminal-wildcard-empty",
        description: "terminal wildcard can match with * set to empty string",
        patterns: [
          /m\["\*"\]\s*=\s*""/i,
          /wildcard.*\*.*empty/i,
        ],
      },
    ],
  },
  {
    id: "pulse-cache-ttl-remember",
    title: "pulse-cache: ttl jitter + remember flow",
    input: makeInput(
      "./demo-resources/pulse-cache",
      "How are TTL and jitter applied, and what does remember() return on hit versus miss?",
    ),
    facts: [
      {
        id: "expiry-jitter",
        description: "expiry time is ttl plus random jitter window",
        patterns: [
          /ttl.*jitter/i,
          /Math\.random\(\)\*w/i,
          /#computeExpiry/i,
        ],
      },
      {
        id: "expired-delete-on-get",
        description: "get() deletes expired entries before returning",
        patterns: [
          /get\(k\).*expiresAt/i,
          /expired.*delete/i,
        ],
      },
      {
        id: "remember-hit",
        description: "remember() returns cached:true on hit",
        patterns: [
          /remember.*cached\s*:\s*true/i,
          /cache hit/i,
        ],
      },
      {
        id: "remember-miss",
        description: "remember() executes callback, stores value, and returns cached:false",
        patterns: [
          /remember.*cached\s*:\s*false/i,
          /this\.set/i,
          /cache miss/i,
        ],
      },
    ],
  },
  {
    id: "pulse-cache-sweep",
    title: "pulse-cache: sweeping + state structure",
    input: makeInput(
      "./demo-resources/pulse-cache",
      "Describe sweepExpired(), injectable clock behavior, and what metadata set() stores with each item.",
    ),
    facts: [
      {
        id: "sweep-removes-expired",
        description: "sweepExpired iterates entries and deletes expired items",
        patterns: [
          /sweepExpired/i,
          /delete/i,
          /expiresAt/i,
        ],
      },
      {
        id: "sweep-count",
        description: "sweepExpired returns the number of removed entries",
        patterns: [
          /return r/i,
          /removed count/i,
          /r\+=1/i,
        ],
      },
      {
        id: "clock-injection",
        description: "constructor accepts clock and nowMs uses clock() when provided",
        patterns: [
          /clock/i,
          /nowMs/i,
          /typeof c===["']function["']\?c\(\):Date\.now/i,
        ],
      },
      {
        id: "set-metadata",
        description: "set() stores value, updatedAt, and expiresAt",
        patterns: [
          /updatedAt/i,
          /expiresAt/i,
          /items\.set/i,
        ],
      },
    ],
  },
  {
    id: "framepack-encode",
    title: "framepack: encoding layout + checksum",
    input: makeInput(
      "./demo-resources/framepack",
      "How does encodeFrame() lay out header bytes, payload, and checksum?",
    ),
    facts: [
      {
        id: "header-layout",
        description: "header stores type and payload length bytes at positions 0-2",
        patterns: [
          /out\[0\]=type/i,
          /out\[1\]=body\.length/i,
          /out\[2\]=body\.length>>8/i,
          /payload.*starts?.*3/i,
        ],
      },
      {
        id: "checksum-last-byte",
        description: "last byte stores checksum of all prior bytes",
        patterns: [
          /out\[out\.length-1\]=checksum/i,
          /last byte.*checksum/i,
        ],
      },
      {
        id: "payload-normalization",
        description: "payload is either passed Uint8Array or encoded string",
        patterns: [
          /payload instanceof Uint8Array/i,
          /TextEncoder/i,
        ],
      },
      {
        id: "frame-size-formula",
        description: "encoded frame size equals 4 + payload length",
        patterns: [
          /4\+body\.length/i,
          /4 \+ payload/i,
        ],
      },
    ],
  },
  {
    id: "framepack-decode",
    title: "framepack: decode validation paths",
    input: makeInput(
      "./demo-resources/framepack",
      "Explain all decodeFrame() validation checks and what is returned on success.",
    ),
    facts: [
      {
        id: "input-validation",
        description: "decodeFrame validates Uint8Array type and minimum frame length",
        patterns: [
          /frame must be Uint8Array/i,
          /frame too short/i,
        ],
      },
      {
        id: "size-validation",
        description: "decodeFrame compares declared size against actual bytes",
        patterns: [
          /size mismatch/i,
          /header=.*bytes=/i,
          /declared size/i,
        ],
      },
      {
        id: "checksum-validation",
        description: "decodeFrame compares expected checksum against computed checksum",
        patterns: [
          /checksum mismatch/i,
          /expected=.*computed=/i,
        ],
      },
      {
        id: "decode-success-return",
        description: "success returns type, body bytes, and decoded text",
        patterns: [
          /return.*type.*body.*text/i,
          /TextDecoder/i,
        ],
      },
    ],
  },
  {
    id: "knot-machine-plan",
    title: "knot-machine: SCC planning + ranking",
    input: makeInput(
      "./demo-resources/knot-machine",
      "How does buildPlan() detect SCC loops and assign component ranks, and how do flags affect complexity?",
    ),
    facts: [
      {
        id: "scc-analysis",
        description: "buildPlan performs strongly connected component analysis",
        patterns: [
          /strongly connected/i,
          /Tarjan/i,
          /SCC/i,
        ],
      },
      {
        id: "component-ranking",
        description: "component graph is ranked via indegree/queue style topological pass",
        patterns: [
          /rankComponents/i,
          /indeg/i,
          /queue/i,
        ],
      },
      {
        id: "loop-flagging",
        description: "loop flag is set for multi-node component or self-edge",
        patterns: [
          /FLAGS\.LOOP/i,
          /componentSizes.*>1/i,
          /edgeList\.includes\(name\)/i,
        ],
      },
      {
        id: "complexity-scoring",
        description: "complexity adds weight for branch, loop, and terminal flags",
        patterns: [
          /complexity/i,
          /branch.*\+2/i,
          /loop.*\+3/i,
          /terminal.*0\.5/i,
        ],
      },
    ],
  },
  {
    id: "knot-machine-runtime-wire",
    title: "knot-machine: runtime loop guard + bytecode validation",
    input: makeInput(
      "./demo-resources/knot-machine",
      "Describe executePlan() loop guard behavior and how toBytecode()/fromBytecode() validate bytecode envelopes.",
    ),
    facts: [
      {
        id: "runtime-loop-guard",
        description: "loop guard triggers when visits exceed maxVisits on loop nodes and may branch via onFalse",
        patterns: [
          /maxVisits/i,
          /loop_guard/i,
          /onFalse/i,
        ],
      },
      {
        id: "next-override",
        description: "operation outcome.next can override control-flow transitions",
        patterns: [
          /outcome\.next/i,
          /override.*next/i,
          /if\(!next\)/i,
        ],
      },
      {
        id: "bytecode-envelope",
        description: "bytecode stores magic bytes, version, payload size, and checksum",
        patterns: [
          /MAGIC0|MAGIC1/i,
          /VERSION/i,
          /checksum/i,
        ],
      },
      {
        id: "bytecode-validation",
        description: "fromBytecode validates magic, version, size, and checksum before decode",
        patterns: [
          /Invalid bytecode magic/i,
          /Unsupported bytecode version/i,
          /Bytecode size mismatch/i,
          /Bytecode checksum mismatch/i,
        ],
      },
    ],
  },
];
