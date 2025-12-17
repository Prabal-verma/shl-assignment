"use client";

import * as React from "react";

export default function Home() {
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-50">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            SHL Assessment Recommendation System
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Paste a recruiter query, a job description, or a JD URL. The system will return 5–10
            relevant SHL Individual Test Solutions.
          </p>
        </header>

        <div className="mt-8 rounded-2xl border border-black/10 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-zinc-950">
          <App />
        </div>

        <footer className="mt-6 text-xs text-zinc-600 dark:text-zinc-400">
          API: <span className="font-mono">GET /health</span>,{" "}
          <span className="font-mono">POST /recommend</span>
        </footer>
      </div>
    </div>
  );
}

type RecommendItem = {
  assessment_name: string;
  assessment_url: string;
};

type RecommendResponse = {
  recommended_assessments: RecommendItem[];
};

function looksLikeUrl(s: string) {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function App() {
  const [input, setInput] = React.useState("");
  const [topK, setTopK] = React.useState(10);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [data, setData] = React.useState<RecommendItem[]>([]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmed = input.trim();
    if (!trimmed) {
      setError("Please paste a query/JD text or a URL.");
      return;
    }

    setLoading(true);
    setData([]);
    try {
      const body = looksLikeUrl(trimmed)
        ? { url: trimmed, top_k: topK }
        : { query: trimmed, top_k: topK };

      const res = await fetch("/recommend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `HTTP ${res.status}`);
      }

      const json = (await res.json()) as RecommendResponse;
      setData(json?.recommended_assessments ?? []);
    } catch (err) {
      setError((err as Error)?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <label className="text-sm font-medium">Query / Job Description / URL</label>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='Example: "Need a Java developer who can collaborate with business teams. 40 minutes."'
          className="min-h-[140px] w-full resize-y rounded-xl border border-black/10 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-zinc-900/10 dark:border-white/10 dark:bg-black dark:focus:ring-white/10"
        />

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium" htmlFor="topk">
              Top K
            </label>
            <select
              id="topk"
              value={topK}
              onChange={(e) => setTopK(Number(e.target.value))}
              className="h-9 rounded-lg border border-black/10 bg-white px-3 text-sm dark:border-white/10 dark:bg-black"
            >
              {[5, 6, 7, 8, 9, 10].map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="inline-flex h-10 items-center justify-center rounded-xl bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            {loading ? "Recommending..." : "Recommend"}
          </button>
        </div>

        {error ? (
          <div className="rounded-xl border border-red-500/20 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-950/30 dark:text-red-200">
            {error}
          </div>
        ) : null}
      </form>

      <div className="rounded-xl border border-black/10 dark:border-white/10">
        <div className="flex items-center justify-between border-b border-black/10 px-4 py-3 text-sm font-medium dark:border-white/10">
          <span>Recommendations</span>
          <span className="text-xs font-normal text-zinc-600 dark:text-zinc-400">
            {data.length ? `${data.length} results` : "No results yet"}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-50 text-xs text-zinc-600 dark:bg-black/40 dark:text-zinc-400">
              <tr>
                <th className="px-4 py-2">Assessment name</th>
                <th className="px-4 py-2">URL</th>
              </tr>
            </thead>
            <tbody>
              {data.length ? (
                data.map((r) => (
                  <tr
                    key={r.assessment_url}
                    className="border-t border-black/5 dark:border-white/10"
                  >
                    <td className="px-4 py-3 align-top">{r.assessment_name}</td>
                    <td className="px-4 py-3 align-top">
                      <a
                        className="break-all text-blue-700 hover:underline dark:text-blue-300"
                        href={r.assessment_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {r.assessment_url}
                      </a>
                    </td>
                  </tr>
                ))
              ) : (
                <tr className="border-t border-black/5 dark:border-white/10">
                  <td className="px-4 py-6 text-zinc-600 dark:text-zinc-400" colSpan={2}>
                    Enter a query above and click “Recommend”.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
