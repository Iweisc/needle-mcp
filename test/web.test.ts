import { afterEach, describe, expect, it, vi } from "vitest";
import { collectWebEvidence } from "../src/web.js";

describe("collectWebEvidence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses SearXNG JSON results when available", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              title: "rou3 - npm",
              url: "https://www.npmjs.com/package/rou3",
              content: "Lightweight and fast router",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const results = await collectWebEvidence("rou3 router", 5);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      {
        title: "rou3 - npm",
        url: "https://www.npmjs.com/package/rou3",
        snippet: "Lightweight and fast router",
      },
    ]);
  });

  it("falls back to Brave HTML parser when SearXNG is unavailable", async () => {
    const braveHtml = `prefix
title:"GitHub - h3js/rou3: \uD83C\uDF33 Lightweight and fast rou(ter) for JavaScript",url:"https://github.com/h3js/rou3",foo:"bar",description:"<strong>Lightweight and fast router for JavaScript</strong>. import { createRouter, addRoute } from &quot;rou3&quot;;"
between
title:"rou3 - npm",url:"https://www.npmjs.com/package/rou3",x:"y",description:"import { createRouter, addRoute } from &quot;rou3&quot;;"
suffix`;

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("upstream unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(braveHtml, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await collectWebEvidence("rou3 router", 5);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.url).toBe("https://github.com/h3js/rou3");
    expect(results[0]?.title).toContain("GitHub - h3js/rou3");
    expect(results[0]?.snippet).toContain("Lightweight and fast router for JavaScript");
  });
});
