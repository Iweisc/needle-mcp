import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifySnippet } from "../src/verify.js";

describe("verifySnippet", () => {
  it("retries with assisted imports for missing package symbols", async () => {
    const pkgDir = await mkdtemp(join(tmpdir(), "needle-verify-pkg-"));

    try {
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify(
          {
            name: "needle-verify-local",
            version: "1.0.0",
            type: "module",
            exports: "./index.js",
          },
          null,
          2,
        ),
      );

      await writeFile(
        join(pkgDir, "index.js"),
        `export function addRoute(ctx, method, path, handler) {
  ctx.routes.push({ method, path, handler });
}
`,
      );

      const snippet = `const ctx = { routes: [] };
const handler = () => {};
addRoute(ctx, "GET", "/user/:id", handler);
if (ctx.routes.length !== 1) {
  throw new Error("route not added");
}
`;

      const result = await verifySnippet(pkgDir, snippet);
      expect(result.success).toBe(true);
      expect(result.mode).toBe("assisted");
    } finally {
      await rm(pkgDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("resolves missing symbols from nested package modules", async () => {
    const pkgDir = await mkdtemp(join(tmpdir(), "needle-verify-pkg-"));

    try {
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify(
          {
            name: "needle-verify-resolved",
            version: "1.0.0",
            type: "module",
            exports: {
              ".": "./index.js",
              "./resources/beta/messages/messages.mjs":
                "./resources/beta/messages/messages.mjs",
            },
          },
          null,
          2,
        ),
      );

      await writeFile(join(pkgDir, "index.js"), `export const version = "1.0.0";\n`);
      await mkdir(join(pkgDir, "resources", "beta", "messages"), {
        recursive: true,
      });
      await writeFile(
        join(pkgDir, "resources", "beta", "messages", "messages.mjs"),
        `export class BetaToolRunner {
  constructor(value) {
    this.value = value;
  }
}
`,
      );

      const snippet = `const runner = new BetaToolRunner("ok");
if (!(runner instanceof BetaToolRunner)) {
  throw new Error("runner missing");
}
`;

      const result = await verifySnippet(pkgDir, snippet);
      expect(result.success).toBe(true);
      expect(result.mode).toBe("resolved");
    } finally {
      await rm(pkgDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("resolves accessor-style re-exports from nested modules", async () => {
    const pkgDir = await mkdtemp(join(tmpdir(), "needle-verify-pkg-"));

    try {
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify(
          {
            name: "needle-verify-reexport",
            version: "1.0.0",
            type: "module",
            exports: {
              ".": "./index.js",
              "./resources/beta/messages/messages.mjs":
                "./resources/beta/messages/messages.mjs",
              "./resources/beta/messages/tools.mjs":
                "./resources/beta/messages/tools.mjs",
            },
          },
          null,
          2,
        ),
      );

      await writeFile(join(pkgDir, "index.js"), `export const version = "1.0.0";\n`);
      await mkdir(join(pkgDir, "resources", "beta", "messages"), {
        recursive: true,
      });
      await writeFile(
        join(pkgDir, "resources", "beta", "messages", "tools.mjs"),
        `export const weatherTool = { name: "weather" };
`,
      );
      await writeFile(
        join(pkgDir, "resources", "beta", "messages", "messages.mjs"),
        `export default class BetaToolRunner {
  constructor(client, opts) {
    this.client = client;
    this.opts = opts;
  }
}

export { weatherTool } from "./tools.mjs";
`,
      );

      const snippet = `const runner = new BetaToolRunner(null, {
  tools: [weatherTool],
});
if (!runner || runner.opts.tools[0].name !== "weather") {
  throw new Error("missing tool");
}
`;

      const result = await verifySnippet(pkgDir, snippet);
      expect(result.success).toBe(true);
      expect(result.mode).toBe("resolved");
    } finally {
      await rm(pkgDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("detects non-JavaScript snippets and fails with a clear message", async () => {
    const pkgDir = await mkdtemp(join(tmpdir(), "needle-verify-pkg-"));

    try {
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify(
          {
            name: "needle-verify-non-js",
            version: "1.0.0",
            type: "module",
            exports: "./index.js",
          },
          null,
          2,
        ),
      );
      await writeFile(join(pkgDir, "index.js"), `export const ok = true;\n`);

      const result = await verifySnippet(pkgDir, "claude --headless [command]");
      expect(result.success).toBe(false);
      expect(result.stderr).toContain("shell command");
      expect(result.mode).toBe("skipped");
    } finally {
      await rm(pkgDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("detects Python snippets and skips JavaScript verification", async () => {
    const pkgDir = await mkdtemp(join(tmpdir(), "needle-verify-pkg-"));

    try {
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify(
          {
            name: "needle-verify-python",
            version: "1.0.0",
            type: "module",
            exports: "./index.js",
          },
          null,
          2,
        ),
      );
      await writeFile(join(pkgDir, "index.js"), `export const ok = true;\n`);

      const snippet = `# FastAPI wrapper
from fastapi import FastAPI
app = FastAPI()
`;
      const result = await verifySnippet(pkgDir, snippet);
      expect(result.success).toBe(false);
      expect(result.mode).toBe("skipped");
      expect(result.stderr).toContain("Python");
    } finally {
      await rm(pkgDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("repairs missing object-brace syntax before assisted import retry", async () => {
    const pkgDir = await mkdtemp(join(tmpdir(), "needle-verify-pkg-"));

    try {
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify(
          {
            name: "needle-verify-syntax",
            version: "1.0.0",
            type: "module",
            exports: "./index.js",
          },
          null,
          2,
        ),
      );

      await writeFile(
        join(pkgDir, "index.js"),
        `export class BetaToolRunner {
  constructor(_client, payload) {
    this.payload = payload;
  }
}
`,
      );

      const snippet = `const runner = new BetaToolRunner(null,
  "description": "Process data",
);
if (!runner) {
  throw new Error("runner missing");
}
`;

      const result = await verifySnippet(pkgDir, snippet);
      expect(result.success).toBe(true);
      expect(result.mode).toBe("assisted");
    } finally {
      await rm(pkgDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("repairs TypeScript-style annotations before running JavaScript verification", async () => {
    const pkgDir = await mkdtemp(join(tmpdir(), "needle-verify-pkg-"));

    try {
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify(
          {
            name: "needle-verify-ts-annotations",
            version: "1.0.0",
            type: "module",
            exports: "./index.js",
          },
          null,
          2,
        ),
      );
      await writeFile(join(pkgDir, "index.js"), `export const ok = true;\n`);

      const snippet = `const weather = {
  run: async (input: { location: string }): Promise<string> => {
    return input.location;
  },
};

const out = await weather.run({ location: "NYC" });
if (out !== "NYC") {
  throw new Error("weather tool failed");
}
`;

      const result = await verifySnippet(pkgDir, snippet);
      expect(result.success).toBe(true);
      expect(result.mode).toBe("direct");
    } finally {
      await rm(pkgDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("verifies a mainstream SDK snippet via assisted imports (@anthropic-ai/sdk)", async () => {
    const snippet = `const client = new Anthropic({ apiKey: "test-key" });
if (!client || typeof client.messages?.stream !== "function") {
  throw new Error("messages.stream API missing");
}
`;

    const result = await verifySnippet("@anthropic-ai/sdk@0.78.0", snippet);
    expect(result.success).toBe(true);
    expect(["assisted", "resolved"]).toContain(result.mode);
  }, 120_000);
});
