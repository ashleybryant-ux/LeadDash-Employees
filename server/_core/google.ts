import { ENV } from "./env";

/**
 * Google results through Serper.dev (Google's own search API closed to new
 * customers and shuts down Jan 1, 2027). Used to widen opportunity searches:
 * every result is handed to the employee to check, never trusted as-is.
 * About $1 per 1,000 searches; failures return nothing.
 */
export type GoogleResult = { title: string; url: string; snippet: string; query: string };

export function googleConfigured() {
  return Boolean(ENV.serperKey) && process.env.NODE_ENV !== "test";
}

export async function googleSearch(queries: string[], perQuery = 10): Promise<GoogleResult[]> {
  if (!googleConfigured() || !queries.length) return [];
  const seen = new Set<string>();
  const out: GoogleResult[] = [];
  await Promise.all(
    queries.map(async (q) => {
      try {
        const res = await fetch("https://google.serper.dev/search", {
          method: "POST",
          headers: { "X-API-KEY": ENV.serperKey, "content-type": "application/json" },
          body: JSON.stringify({ q, num: perQuery, gl: "us", hl: "en" }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return;
        const data: any = await res.json();
        for (const r of data?.organic ?? []) {
          const url = String(r.link || "");
          if (!/^https?:\/\//.test(url) || seen.has(url)) continue;
          seen.add(url);
          out.push({ title: String(r.title || ""), url, snippet: String(r.snippet || "").slice(0, 300), query: q });
        }
      } catch {
        /* ignore one failed query */
      }
    })
  );
  return out;
}
