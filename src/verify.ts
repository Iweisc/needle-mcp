import { readFile, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTempDir } from "./util/tmp.js";
import { VERIFY_TIMEOUT } from "./util/limits.js";
import { logger } from "./util/log.js";

const execFileAsync = promisify(execFile);

type VerifyMode = "direct" | "assisted" | "resolved" | "skipped";

export interface VerifyResult {
  success: boolean;
  stdout: string;
  stderr: string;
  mode: VerifyMode;
}

function isMissingIdentifierError(stderr: string): boolean {
  return /ReferenceError:\s+[A-Za-z_$][\w$]*\s+is not defined/.test(stderr);
}

function extractMissingIdentifiers(stderr: string): string[] {
  const re = /ReferenceError:\s+([A-Za-z_$][\w$]*)\s+is not defined/g;
  const symbols: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    symbols.push(m[1]);
  }
  return [...new Set(symbols)];
}

function normalizeSnippetSource(codeSnippet: string): string {
  const trimmed = codeSnippet.trim();
  const fences = [...trimmed.matchAll(/```([a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g)];
  if (fences.length === 0) {
    return trimmed;
  }
  const jsLike = new Set(["js", "mjs", "cjs", "javascript", "ts", "tsx", "typescript"]);

  const pickLongest = (items: RegExpMatchArray[]): string =>
    items
      .map((m) => m[2] ?? "")
      .sort((a, b) => b.length - a.length)[0]
      .trim();

  const jsFences = fences.filter((m) =>
    m[1] ? jsLike.has(m[1].toLowerCase()) : false,
  );
  if (jsFences.length > 0) return pickLongest(jsFences);

  const unlabeled = fences.filter((m) => !m[1]);
  if (unlabeled.length > 0) return pickLongest(unlabeled);

  return pickLongest(fences);
}

function detectNonJavaScriptSnippet(snippet: string): string | null {
  const trimmed = snippet.trim();
  if (!trimmed) {
    return "Snippet is empty.";
  }

  const firstLine = trimmed.split(/\r?\n/, 1)[0].trim();
  if (/^\$?\s*(npm|pnpm|yarn|npx|node|bun|python|pip|claude|codex|git|curl|wget)\b/i.test(firstLine)) {
    return `Snippet appears to be a shell command, not executable JavaScript: ${firstLine}`;
  }

  if (/^[a-z0-9_.-]+\s+--[a-z0-9-]+/i.test(firstLine) && !/[=({;]|\bconst\b|\blet\b|\bimport\b/.test(firstLine)) {
    return `Snippet appears to be a CLI invocation, not JavaScript: ${firstLine}`;
  }

  const headLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 16);
  const pythonPatterns = [
    /^#!.*\bpython\d*(?:\.\d+)?\b/i,
    /^from\s+[A-Za-z_][\w.]*\s+import\s+/,
    /^import\s+[A-Za-z_][\w.]*(\s*,\s*[A-Za-z_][\w.]*)*$/,
    /^(?:async\s+)?def\s+[A-Za-z_][\w]*\s*\(.*\)\s*:/,
    /^class\s+[A-Za-z_][\w]*(?:\([^)]*\))?\s*:/,
    /^if\s+__name__\s*==\s*["']__main__["']\s*:/,
    /^@\w[\w.]*/,
  ];
  const pythonLine = headLines.find((line) =>
    pythonPatterns.some((pattern) => pattern.test(line)),
  );
  if (pythonLine) {
    return `Snippet appears to be Python, not executable JavaScript: ${pythonLine}`;
  }

  return null;
}

/**
 * Repair common malformed snippets where an object argument is missing its opening `{`,
 * resulting in `Unexpected token ':'` on the first object key line.
 */
function repairMissingObjectLiteral(snippet: string): string | null {
  const lines = snippet.split(/\r?\n/);
  const keyLineIdx = lines.findIndex((line) =>
    /^\s*(?:["'][^"']+["']|[A-Za-z_$][\w$]*)\s*:/.test(line),
  );
  if (keyLineIdx <= 0) return null;

  const prev = lines[keyLineIdx - 1];
  if (prev.includes("{")) return null;
  if (/^\s*$/.test(prev)) return null;

  const fixed = [...lines];
  fixed[keyLineIdx - 1] = `${prev.trimEnd()} {`;

  const keyIndent = (lines[keyLineIdx].match(/^(\s*)/)?.[1] ?? "");
  const closeLineIdx = fixed.findIndex((line, i) =>
    i > keyLineIdx && /^\s*\)\s*;?\s*$/.test(line),
  );

  if (closeLineIdx !== -1) {
    const closeIndent = keyIndent.length >= 2 ? keyIndent.slice(0, -2) : "";
    fixed.splice(closeLineIdx, 0, `${closeIndent}}`);
  } else {
    fixed.push("}");
  }

  const repaired = fixed.join("\n");
  return repaired === snippet ? null : repaired;
}

/**
 * Repair common TypeScript-only syntax so snippets can run as plain JavaScript.
 * Focuses on lightweight annotation stripping for params/returns/variables.
 */
function repairTypeScriptAnnotations(snippet: string): string | null {
  let repaired = snippet;

  // Arrow/function param annotations, including object-literal types:
  // `(input: { location: string })` -> `(input)`.
  repaired = repaired.replace(
    /([,(]\s*(?:\.\.\.)?[A-Za-z_$][\w$]*\??)\s*:\s*(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}|[A-Za-z_$][\w$<>,.\s\[\]\|&?]*)(?=\s*(?:[=,)]))/g,
    "$1",
  );

  // Return type annotations before arrow functions:
  // `(input): Promise<string> =>` -> `(input) =>`.
  repaired = repaired.replace(
    /(\)\s*):\s*[A-Za-z_$][\w$<>,.\s\[\]\|&?]*(\s*=>)/g,
    "$1$2",
  );

  // Variable declaration annotations:
  // `const x: Foo =` -> `const x =`.
  repaired = repaired.replace(
    /\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$<>,.\s\[\]\|&?]*(\s*=)/g,
    "$1 $2$3",
  );

  return repaired === snippet ? null : repaired;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePackageNameFromNpmSpec(spec: string): string {
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    if (slash === -1) return spec;
    const versionAt = spec.indexOf("@", slash + 1);
    return versionAt === -1 ? spec : spec.slice(0, versionAt);
  }
  const versionAt = spec.indexOf("@");
  return versionAt === -1 ? spec : spec.slice(0, versionAt);
}

async function parsePackageNameFromLocalSpec(spec: string): Promise<string | null> {
  let packageDir = spec;
  if (spec.startsWith("file:")) {
    try {
      packageDir = fileURLToPath(spec);
    } catch {
      return null;
    }
  }
  if (!isAbsolute(packageDir) && !packageDir.startsWith(".")) {
    return null;
  }
  try {
    const raw = await readFile(join(packageDir, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

async function resolveInstalledImportSpec(dir: string, originalSpec: string): Promise<string> {
  try {
    const raw = await readFile(join(dir, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { dependencies?: Record<string, string> };
    const deps = Object.keys(parsed.dependencies ?? {});
    if (deps.length === 1) return deps[0];
  } catch {
    // Fall through to heuristic parsing.
  }

  const localName = await parsePackageNameFromLocalSpec(originalSpec);
  if (localName) return localName;

  return parsePackageNameFromNpmSpec(originalSpec);
}

function packageDirFromImportSpec(verifyDir: string, importSpec: string): string {
  if (importSpec.startsWith("@")) {
    const [scope, name] = importSpec.split("/");
    return join(verifyDir, "node_modules", scope, name ?? "");
  }
  return join(verifyDir, "node_modules", importSpec);
}

async function findSymbolModuleUrls(
  verifyDir: string,
  importSpec: string,
  symbols: string[],
): Promise<string[]> {
  if (symbols.length === 0) return [];

  const packageDir = packageDirFromImportSpec(verifyDir, importSpec);
  const symbolPattern = symbols.map(escapeRegex).join("|");
  const regex = `\\b(${symbolPattern})\\b`;

  try {
    const { stdout } = await execFileAsync(
      "rg",
      [
        "-l",
        "--pcre2",
        "--glob",
        "*.js",
        "--glob",
        "*.mjs",
        "--glob",
        "*.cjs",
        regex,
        packageDir,
      ],
      {
        cwd: verifyDir,
        timeout: Math.min(VERIFY_TIMEOUT, 8_000),
      },
    );

    const files = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const scored = files.map((file) => {
      let score = 0;
      if (file.includes("/resources/")) score += 4;
      if (file.includes("/lib/")) score += 3;
      if (file.includes("/index.")) score += 2;
      if (file.includes("/dist/")) score += 1;
      if (file.includes(".min.")) score -= 3;
      if (file.includes("/test/") || file.includes("/examples/")) score -= 3;
      return { file, score };
    });

    return scored
      .sort((a, b) => b.score - a.score)
      .map((entry) => pathToFileURL(entry.file).href)
      .filter((href, i, arr) => arr.indexOf(href) === i)
      .slice(0, 12);
  } catch {
    return [];
  }
}

function buildAssistedHarness(importSpec: string, extraModuleUrls: string[] = []): string {
  const spec = JSON.stringify(importSpec);
  const extras = JSON.stringify(extraModuleUrls);
  return `const pkg = await import(${spec});
const extraModules = ${extras};

function expose(target) {
  if (!target || (typeof target !== "object" && typeof target !== "function")) return;
  for (const key of Object.getOwnPropertyNames(target)) {
    if (key === "default" || key in globalThis) continue;
    let value;
    try {
      value = Reflect.get(target, key);
    } catch {
      continue;
    }
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
}

function exposeModule(mod) {
  expose(mod);
  if ("default" in mod) {
    const def = mod.default;
    expose(def);
    if (!("defaultExport" in globalThis)) {
      Object.defineProperty(globalThis, "defaultExport", {
        value: def,
        configurable: true,
        writable: true,
      });
    }
    if (typeof def === "function" && def.name && !(def.name in globalThis)) {
      Object.defineProperty(globalThis, def.name, {
        value: def,
        configurable: true,
        writable: true,
      });
    }
  }
}

// Auto-instantiate: for PascalCase constructors, expose a camelCase instance.
// Covers the common pattern where snippets use e.g. "anthropic" as an instance of "Anthropic".
function autoInstantiate() {
  const noopHandler = {
    get(_, prop) {
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === "then") return undefined; // not thenable
      return new Proxy(function(){}, noopHandler);
    },
    apply() { return new Proxy(function(){}, noopHandler); },
  };

  function tryInstantiate(Ctor) {
    try {
      return new Ctor();
    } catch {
      return new Proxy(function(){}, noopHandler);
    }
  }

  function defineIfMissing(name, value) {
    if (name in globalThis) return;
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
  }

  // Find the primary constructor: default export if it's a function, otherwise
  // the first PascalCase constructor found on globalThis.
  let primaryCtor = null;
  if ("defaultExport" in globalThis && typeof globalThis.defaultExport === "function") {
    primaryCtor = globalThis.defaultExport;
  }

  const keys = Object.getOwnPropertyNames(globalThis);
  for (const key of keys) {
    if (!/^[A-Z][a-zA-Z0-9]*$/.test(key)) continue;
    const Ctor = globalThis[key];
    if (typeof Ctor !== "function") continue;
    if (!primaryCtor) primaryCtor = Ctor;

    // Expose camelCase instance (e.g. Anthropic → anthropic)
    const camel = key[0].toLowerCase() + key.slice(1);
    defineIfMissing(camel, tryInstantiate(Ctor));
  }

  // Expose generic aliases as deep no-op Proxies so snippets using
  // "client", "sdk", "api", or "app" can traverse any property chain.
  if (primaryCtor) {
    const proxy = new Proxy(function(){}, noopHandler);
    for (const alias of ["client", "sdk", "api", "app"]) {
      defineIfMissing(alias, proxy);
    }
  }
}

exposeModule(pkg);
for (const modUrl of extraModules) {
  try {
    const mod = await import(modUrl);
    exposeModule(mod);
  } catch {}
}
autoInstantiate();

await import("./snippet.mjs");
`;
}

async function runScript(cwd: string, scriptName: string): Promise<VerifyResult> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [scriptName], {
      cwd,
      timeout: VERIFY_TIMEOUT,
    });
    return { success: true, stdout, stderr, mode: "direct" };
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    return {
      success: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? (err instanceof Error ? err.message : String(err)),
      mode: "direct",
    };
  }
}

export async function verifySnippet(
  packageSpec: string,
  codeSnippet: string,
): Promise<VerifyResult> {
  const { dir, cleanup } = await createTempDir();

  try {
    let snippetSource = normalizeSnippetSource(codeSnippet);
    const nonJsReason = detectNonJavaScriptSnippet(snippetSource);
    if (nonJsReason) {
      return {
        success: false,
        stdout: "",
        stderr: nonJsReason,
        mode: "skipped",
      };
    }

    // Create a minimal package.json
    const pkgJson = {
      name: "needle-verify",
      version: "0.0.0",
      type: "module",
      private: true,
    };
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify(pkgJson, null, 2),
    );

    // Write the snippet under test.
    await writeFile(join(dir, "snippet.mjs"), snippetSource);

    // Install the package
    logger.info("Verify: installing package", { spec: packageSpec });
    await execFileAsync("npm", ["install", packageSpec], {
      cwd: dir,
      timeout: VERIFY_TIMEOUT,
    });

    const importSpec = await resolveInstalledImportSpec(dir, packageSpec);

    // Run snippet directly first.
    logger.info("Verify: running snippet (direct)");
    let direct = await runScript(dir, "snippet.mjs");
    if (direct.success) {
      return direct;
    }

    if (/SyntaxError:/.test(direct.stderr)) {
      const repaired = repairMissingObjectLiteral(snippetSource);
      if (repaired && repaired !== snippetSource) {
        logger.info("Verify: retrying snippet after syntax repair");
        snippetSource = repaired;
        await writeFile(join(dir, "snippet.mjs"), snippetSource);
        direct = await runScript(dir, "snippet.mjs");
        if (direct.success) {
          return direct;
        }
      }

      const tsRepaired = repairTypeScriptAnnotations(snippetSource);
      if (tsRepaired && tsRepaired !== snippetSource) {
        logger.info("Verify: retrying snippet after TypeScript annotation repair");
        snippetSource = tsRepaired;
        await writeFile(join(dir, "snippet.mjs"), snippetSource);
        direct = await runScript(dir, "snippet.mjs");
        if (direct.success) {
          return direct;
        }
      }
    }

    const directMissing = extractMissingIdentifiers(direct.stderr);
    if (directMissing.length === 0) {
      return direct;
    }

    // Fallback for model snippets that omit imports of package exports.
    logger.info("Verify: retrying snippet with assisted import harness");
    await writeFile(join(dir, "test.mjs"), buildAssistedHarness(importSpec));
    const assisted = await runScript(dir, "test.mjs");
    assisted.mode = "assisted";

    if (assisted.success) {
      assisted.stderr = direct.stderr;
      return assisted;
    }

    let unresolved = [...new Set([
      ...directMissing,
      ...extractMissingIdentifiers(assisted.stderr),
    ])];

    const allExtraModules: string[] = [];
    const MAX_RESOLVE_PASSES = 3;
    let lastResolved: VerifyResult | null = null;

    for (let pass = 0; pass < MAX_RESOLVE_PASSES && unresolved.length > 0; pass++) {
      const newModules = await findSymbolModuleUrls(dir, importSpec, unresolved);
      for (const m of newModules) {
        if (!allExtraModules.includes(m)) allExtraModules.push(m);
      }

      if (allExtraModules.length === 0) break;

      logger.info("Verify: retrying snippet with symbol-resolved import harness", {
        pass: pass + 1,
        symbols: unresolved.slice(0, 8),
        modules: allExtraModules.length,
      });
      await writeFile(
        join(dir, "test.mjs"),
        buildAssistedHarness(importSpec, allExtraModules),
      );
      const resolved = await runScript(dir, "test.mjs");
      resolved.mode = "resolved";
      lastResolved = resolved;

      if (resolved.success) {
        resolved.stderr = direct.stderr;
        return resolved;
      }

      const newMissing = extractMissingIdentifiers(resolved.stderr);
      const brandNew = newMissing.filter((s) => !unresolved.includes(s));
      if (brandNew.length === 0) break;

      unresolved = [...new Set([...unresolved, ...brandNew])];
    }

    if (lastResolved) {
      lastResolved.stderr =
        `Direct run failed:\n${direct.stderr}\n\n` +
        `Assisted run failed:\n${assisted.stderr}\n\n` +
        `Resolved run failed:\n${lastResolved.stderr}`;
      return lastResolved;
    }

    assisted.stderr =
      `Direct run failed:\n${direct.stderr}\n\n` +
      `Assisted run failed:\n${assisted.stderr}`;
    return assisted;
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    logger.warn("Verify: snippet execution failed", {
      error: error.message ?? String(err),
    });
    return {
      success: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? (err instanceof Error ? err.message : String(err)),
      mode: "direct",
    };
  } finally {
    await cleanup();
  }
}
