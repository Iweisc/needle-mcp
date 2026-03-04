import type { WebEvidence } from "./types.js";
import { WEB_TIMEOUT } from "./util/limits.js";
import { logger } from "./util/log.js";

const DEFAULT_SEARXNG_URL = "http://localhost:8889/search";
const BRAVE_SEARCH_URL = "https://search.brave.com/search";
const BRAVE_RESULT_REGEX =
  /title:\"((?:\\.|[^\"\\])*)\",url:\"((?:\\.|[^\"\\])*)\"[\s\S]{0,1600}?description:\"((?:\\.|[^\"\\])*)\"/g;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, "\"")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function decodeJsEscapes(text: string): string {
  return text
    .replace(/\\u003C/g, "<")
    .replace(/\\u003E/g, ">")
    .replace(/\\u002F/g, "/")
    .replace(/\\r/g, " ")
    .replace(/\\n/g, " ")
    .replace(/\\t/g, " ")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}

function toSnippet(description: string): string {
  return normalizeWhitespace(
    decodeHtmlEntities(decodeJsEscapes(description).replace(/<[^>]+>/g, " ")),
  );
}

function parseBraveResults(rawHtml: string, maxResults: number): WebEvidence[] {
  const results: WebEvidence[] = [];
  const seen = new Set<string>();

  for (const match of rawHtml.matchAll(BRAVE_RESULT_REGEX)) {
    const title = normalizeWhitespace(decodeHtmlEntities(decodeJsEscapes(match[1])));
    const url = decodeJsEscapes(match[2]).trim();
    const snippet = toSnippet(match[3]);

    if (!title || !url || !/^https?:\/\//.test(url)) continue;
    if (url.includes("search.brave.com") || url.includes("cdn.search.brave.com")) continue;
    if (seen.has(url)) continue;

    seen.add(url);
    results.push({ title, url, snippet });
    if (results.length >= maxResults) break;
  }

  return results;
}

function getSearxngUrls(): string[] {
  const configured = process.env.NEEDLE_SEARXNG_URL;
  if (!configured) return [DEFAULT_SEARXNG_URL];
  return configured
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

async function collectFromSearxng(
  baseUrl: string,
  question: string,
  maxResults: number,
): Promise<WebEvidence[]> {
  const params = new URLSearchParams({
    q: question,
    format: "json",
    categories: "general,it",
    language: "en-US",
  });

  const response = await fetch(`${baseUrl}?${params}`, {
    signal: AbortSignal.timeout(WEB_TIMEOUT),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
  };

  return (data.results ?? [])
    .filter((r) => !!r.url && /^https?:\/\//.test(r.url))
    .slice(0, maxResults)
    .map((r) => ({
      title: (r.title ?? "").trim(),
      url: (r.url ?? "").trim(),
      snippet: normalizeWhitespace(r.content ?? ""),
    }));
}

async function collectFromBrave(
  question: string,
  maxResults: number,
): Promise<WebEvidence[]> {
  const params = new URLSearchParams({
    q: question,
    source: "web",
  });

  const response = await fetch(`${BRAVE_SEARCH_URL}?${params}`, {
    signal: AbortSignal.timeout(WEB_TIMEOUT),
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; needle-mcp/0.1)",
      accept: "text/html,application/xhtml+xml",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const html = await response.text();
  return parseBraveResults(html, maxResults);
}

export async function collectWebEvidence(
  question: string,
  maxResults = 5,
): Promise<WebEvidence[]> {
  for (const baseUrl of getSearxngUrls()) {
    try {
      const hits = await collectFromSearxng(baseUrl, question, maxResults);
      if (hits.length > 0) {
        return hits;
      }
      logger.info("Web evidence: SearXNG returned no results", { baseUrl });
    } catch (err) {
      logger.warn("Web evidence: SearXNG query failed", {
        baseUrl,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    const hits = await collectFromBrave(question, maxResults);
    if (hits.length > 0) {
      logger.info("Web evidence: using Brave HTML fallback", { hits: hits.length });
      return hits;
    }
    logger.warn("Web evidence fallback returned no results");
    return [];
  } catch (err) {
    logger.warn("Web evidence collection failed (SearXNG + fallback)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
