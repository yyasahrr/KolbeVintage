export type SearchMetric = { term: string; count: number; results: number; clicks: number; conversions: number; zeroResults: boolean; at: number };

/** Aggregated local metric plus anonymous server event. Only the query text is sent; no account or device ID. */
export function recordSearchEvent(term: string, event: "search" | "click" | "conversion", resultCount = 0) {
  const query = term.trim().normalize("NFKC").slice(0, 200);
  if (!query) return;
  const now = Date.now();
  try {
    const rows = JSON.parse(localStorage.getItem("kolbe-search-analytics-v1") || "[]") as SearchMetric[];
    const recent = rows.filter((row) => now - row.at < 30 * 86400000);
    const metric = recent.find((row) => row.term === query);
    if (metric) {
      if (event === "search") { metric.count += 1; metric.results = resultCount; metric.zeroResults = resultCount === 0; }
      if (event === "click") metric.clicks += 1;
      if (event === "conversion") metric.conversions += 1;
      metric.at = now;
    } else {
      recent.push({ term: query, count: event === "search" ? 1 : 0, results: resultCount, clicks: event === "click" ? 1 : 0, conversions: event === "conversion" ? 1 : 0, zeroResults: event === "search" && resultCount === 0, at: now });
    }
    localStorage.setItem("kolbe-search-analytics-v1", JSON.stringify(recent.slice(-300)));
  } catch { /* Storage is optional; search remains usable. */ }
  void fetch("/api/v1/public/search/metrics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, event, resultCount }) }).catch(() => undefined);
}
