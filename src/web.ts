import type { WebEvidence } from "./types.js";
import { WEB_TIMEOUT } from "./util/limits.js";
import { logger } from "./util/log.js";

const DEFAULT_SEARXNG_URL = "http://localhost:8889/search";

export async function collectWebEvidence(
  question: string,
  maxResults = 5,
): Promise<WebEvidence[]> {
  const baseUrl = process.env.NEEDLE_SEARXNG_URL ?? DEFAULT_SEARXNG_URL;

  try {
    const params = new URLSearchParams({
      q: question,
      format: "json",
      categories: "general,it",
    });

    const response = await fetch(`${baseUrl}?${params}`, {
      signal: AbortSignal.timeout(WEB_TIMEOUT),
    });

    if (!response.ok) {
      logger.warn("SearXNG returned non-OK status", {
        status: response.status,
      });
      return [];
    }

    const data = (await response.json()) as {
      results?: { title?: string; url?: string; content?: string }[];
    };

    return (data.results ?? []).slice(0, maxResults).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.content ?? "",
    }));
  } catch (err) {
    logger.warn("Web evidence collection failed (best-effort)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
