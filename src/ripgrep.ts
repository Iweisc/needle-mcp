import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RgMatch } from "./types.js";
import { RG_TIMEOUT, MAX_FILE_SIZE, SOURCE_GLOBS } from "./util/limits.js";
import { logger } from "./util/log.js";

const execFileAsync = promisify(execFile);

export interface RgSearchOptions {
  contextLines?: number;
  globs?: string[];
  timeout?: number;
}

function buildRgArgs(
  pattern: string,
  dir: string,
  opts: Required<RgSearchOptions>,
  fixedStrings = false,
): string[] {
  const args = [
    "--json",
    "-i",
    "-C",
    String(opts.contextLines),
    "--max-filesize",
    MAX_FILE_SIZE,
  ];

  if (fixedStrings) {
    args.push("-F");
  }

  for (const g of opts.globs) {
    args.push("--glob", g);
  }

  args.push("--", pattern, dir);
  return args;
}

export async function rgSearch(
  pattern: string,
  dir: string,
  opts: RgSearchOptions = {},
): Promise<RgMatch[]> {
  const {
    contextLines = 3,
    globs = SOURCE_GLOBS,
    timeout = RG_TIMEOUT,
  } = opts;

  const resolvedOpts: Required<RgSearchOptions> = {
    contextLines,
    globs,
    timeout,
  };

  const run = async (fixedStrings: boolean): Promise<RgMatch[]> => {
    const args = buildRgArgs(pattern, dir, resolvedOpts, fixedStrings);
    const { stdout } = await execFileAsync("rg", args, {
      timeout: resolvedOpts.timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    return parseRgJsonLines(stdout);
  };

  try {
    return await run(false);
  } catch (err: unknown) {
    // Exit code 1 means no matches — not an error
    if (isExecError(err) && err.code === 1) {
      return [];
    }
    if (isRegexParseError(err)) {
      logger.warn("ripgrep regex parse error, retrying as fixed string", {
        pattern,
      });
      try {
        return await run(true);
      } catch (retryErr: unknown) {
        if (isExecError(retryErr) && retryErr.code === 1) {
          return [];
        }
        logger.error("ripgrep fixed-string retry failed", {
          pattern,
          error: retryErr instanceof Error ? retryErr.message : String(retryErr),
        });
        throw retryErr;
      }
    }
    logger.error("ripgrep failed", {
      pattern,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

function isExecError(err: unknown): err is Error & { code: number } {
  return err instanceof Error && "code" in err && typeof (err as any).code === "number";
}

function isRegexParseError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const stderr = typeof (err as any).stderr === "string" ? (err as any).stderr : "";
  const msg = `${err.message}\n${stderr}`.toLowerCase();
  return msg.includes("regex parse error");
}

export function parseRgJsonLines(output: string): RgMatch[] {
  const matches: RgMatch[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;

    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Skip malformed lines
      continue;
    }

    if (parsed.type !== "match") continue;

    const data = parsed.data;
    if (!data?.path?.text || data.line_number == null || !data.lines?.text) {
      continue;
    }

    matches.push({
      path: data.path.text,
      lineNumber: data.line_number,
      text: data.lines.text.trimEnd(),
      submatches: (data.submatches ?? []).map(
        (s: { match: { text: string } }) => s.match.text,
      ),
    });
  }

  return matches;
}
