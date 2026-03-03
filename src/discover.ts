import { readFile, readdir, access } from "node:fs/promises";
import { join, relative, extname, basename } from "node:path";
import { logger } from "./util/log.js";

export interface ApiSurface {
  /** Exported symbol names (functions, classes, types, constants) */
  symbols: string[];
  /** Entrypoint file paths relative to resource dir */
  entrypoints: string[];
  /** Package name if available */
  packageName?: string;
}

/**
 * Discover the public API surface of a resource by reading package.json,
 * finding entrypoints, and scanning barrel exports / .d.ts files.
 */
export async function discoverApiSurface(dir: string): Promise<ApiSurface> {
  const surface: ApiSurface = { symbols: [], entrypoints: [] };

  // 1. Try reading package.json for entrypoints
  const entryFiles = await findEntrypoints(dir);
  surface.entrypoints = entryFiles.map((f) => relative(dir, f));

  // Read package name
  try {
    const pkgRaw = await readFile(join(dir, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgRaw);
    if (pkg.name) surface.packageName = pkg.name;
  } catch {
    // no package.json
  }

  // 2. For each entrypoint, prefer .d.ts sibling, then scan the file itself
  for (const entry of entryFiles) {
    const dtsPath = toDtsPath(entry);
    const fileToScan = dtsPath ? await pickExisting(dtsPath, entry) : entry;
    if (fileToScan) {
      const symbols = await extractExports(fileToScan);
      for (const s of symbols) {
        if (!surface.symbols.includes(s)) surface.symbols.push(s);
      }
    }
  }

  // 3. If we found nothing from entrypoints, scan all .d.ts files in common locations
  if (surface.symbols.length === 0) {
    const dtsFiles = await findDtsFiles(dir);
    for (const f of dtsFiles.slice(0, 10)) {
      const symbols = await extractExports(f);
      for (const s of symbols) {
        if (!surface.symbols.includes(s)) surface.symbols.push(s);
      }
    }
  }

  // 4. If still nothing, try scanning src/index.* or lib/index.*
  if (surface.symbols.length === 0) {
    const fallbacks = [
      "src/index.ts",
      "src/index.js",
      "src/index.mjs",
      "lib/index.ts",
      "lib/index.js",
      "lib/index.mjs",
    ];
    for (const fb of fallbacks) {
      const full = join(dir, fb);
      if (await fileExists(full)) {
        const symbols = await extractExports(full);
        for (const s of symbols) {
          if (!surface.symbols.includes(s)) surface.symbols.push(s);
        }
        if (surface.symbols.length > 0) break;
      }
    }
  }

  logger.info("API surface discovered", {
    symbols: surface.symbols.length,
    entrypoints: surface.entrypoints.length,
    packageName: surface.packageName,
    sample: surface.symbols.slice(0, 15),
  });

  return surface;
}

/** Find entrypoint files from package.json fields */
async function findEntrypoints(dir: string): Promise<string[]> {
  const entries: string[] = [];

  try {
    const pkgRaw = await readFile(join(dir, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgRaw);

    // Collect candidate paths from standard fields
    const candidates: string[] = [];

    if (typeof pkg.main === "string") candidates.push(pkg.main);
    if (typeof pkg.module === "string") candidates.push(pkg.module);
    if (typeof pkg.types === "string") candidates.push(pkg.types);
    if (typeof pkg.typings === "string") candidates.push(pkg.typings);

    // exports field (handle string, object with ".", "./", "import", "types")
    if (pkg.exports) {
      collectExportPaths(pkg.exports, candidates);
    }

    // Deduplicate and resolve
    const seen = new Set<string>();
    for (const c of candidates) {
      if (typeof c !== "string" || seen.has(c)) continue;
      seen.add(c);
      const full = join(dir, c);
      if (await fileExists(full)) {
        entries.push(full);
      }
    }
  } catch {
    // no package.json or parse error
  }

  return entries;
}

/** Recursively collect file paths from package.json "exports" field */
function collectExportPaths(
  exports: unknown,
  out: string[],
): void {
  if (typeof exports === "string") {
    out.push(exports);
    return;
  }
  if (typeof exports === "object" && exports !== null) {
    // Prioritize types/import/require/default
    const obj = exports as Record<string, unknown>;
    for (const key of ["types", "import", "require", "default", ".", "./"]) {
      if (key in obj) {
        collectExportPaths(obj[key], out);
      }
    }
    // Also scan any remaining subpath exports
    for (const [key, val] of Object.entries(obj)) {
      if (key.startsWith("./") && key !== "./") {
        collectExportPaths(val, out);
      }
    }
  }
}

/** Convert a .js/.ts path to its .d.ts sibling */
function toDtsPath(filePath: string): string | null {
  const ext = extname(filePath);
  if (ext === ".d.ts" || filePath.endsWith(".d.ts")) return null; // already .d.ts
  if ([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"].includes(ext)) {
    return filePath.replace(/\.[^.]+$/, ".d.ts");
  }
  return null;
}

/** Return first path that exists, or null */
async function pickExisting(...paths: (string | null)[]): Promise<string | null> {
  for (const p of paths) {
    if (p && (await fileExists(p))) return p;
  }
  return null;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Find .d.ts files in common locations */
async function findDtsFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const searchDirs = ["dist", "lib", "build", "types", "typings", "."];

  for (const sub of searchDirs) {
    const target = sub === "." ? dir : join(dir, sub);
    try {
      const entries = await readdir(target, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith(".d.ts")) {
          results.push(join(target, e.name));
        }
      }
    } catch {
      // dir doesn't exist
    }
    if (results.length > 0) break; // found some, stop searching
  }

  return results;
}

/**
 * Extract exported symbol names from a source or .d.ts file.
 * Parses export statements via regex — intentionally lightweight.
 */
export async function extractExports(filePath: string): Promise<string[]> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  // Cap to 200KB to avoid reading huge bundles
  if (content.length > 200_000) {
    content = content.slice(0, 200_000);
  }

  const symbols: string[] = [];
  const seen = new Set<string>();

  // Language keywords that should never be treated as exported symbols
  const BLOCKED_SYMBOLS = new Set([
    "type", "interface", "enum", "class", "function", "const", "let", "var",
    "import", "export", "from", "default", "extends", "implements",
    "return", "if", "else", "for", "while", "do", "switch", "case",
    "break", "continue", "new", "this", "super", "void", "null",
    "undefined", "true", "false", "typeof", "instanceof", "in", "of",
    "async", "await", "yield", "throw", "try", "catch", "finally",
    "delete", "with", "as", "is", "keyof", "readonly", "declare",
    "abstract", "static", "private", "protected", "public", "override",
  ]);

  const add = (name: string) => {
    const cleaned = name.trim();
    if (
      cleaned &&
      cleaned.length >= 2 &&
      cleaned.length <= 80 &&
      !seen.has(cleaned) &&
      !BLOCKED_SYMBOLS.has(cleaned)
    ) {
      seen.add(cleaned);
      symbols.push(cleaned);
    }
  };

  // export function name / export async function name
  for (const m of content.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) {
    add(m[1]);
  }

  // export class name
  for (const m of content.matchAll(/export\s+class\s+(\w+)/g)) {
    add(m[1]);
  }

  // export const/let/var name
  for (const m of content.matchAll(/export\s+(?:const|let|var)\s+(\w+)/g)) {
    add(m[1]);
  }

  // export type name / export interface name (but NOT "export type {" which is a re-export)
  for (const m of content.matchAll(/export\s+(?:type|interface|enum)\s+(\w+)(?:\s*[<=\{]|\s+extends)/g)) {
    add(m[1]);
  }

  // export default class/function name
  for (const m of content.matchAll(/export\s+default\s+(?:class|function)\s+(\w+)/g)) {
    add(m[1]);
  }

  // export { name1, name2, ... } — barrel re-exports
  for (const m of content.matchAll(/export\s*\{([^}]+)\}/g)) {
    const inner = m[1];
    for (let part of inner.split(",")) {
      // Strip "type " prefix from "export { type Foo }" syntax
      part = part.replace(/^\s*type\s+/, " ");
      // Handle "Name as Alias" — use the alias (exported name)
      const asMatch = part.match(/(?:\w+)\s+as\s+(\w+)/);
      if (asMatch) {
        add(asMatch[1]);
      } else {
        const nameMatch = part.match(/(\w+)/);
        if (nameMatch) add(nameMatch[1]);
      }
    }
  }

  // declare function/class/const (common in .d.ts without export keyword at top level)
  for (const m of content.matchAll(/declare\s+(?:function|class|const|let|var)\s+(\w+)/g)) {
    add(m[1]);
  }
  for (const m of content.matchAll(/declare\s+(?:type|interface|enum)\s+(\w+)/g)) {
    add(m[1]);
  }

  return symbols;
}
