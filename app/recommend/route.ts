import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as cheerio from "cheerio";
import { NextRequest, NextResponse } from "next/server";

import { recommend } from "../../scripts/lib/recommender";

export const runtime = "nodejs";

type RecommendRequestBody = {
  query?: string;
  text?: string;
  url?: string;
  top_k?: number;
  topK?: number;
};

type RecommendItem = {
  assessment_name: string;
  assessment_url: string;
};

type RecommendResponse = {
  recommended_assessments: RecommendItem[];
};

type IndexFile = Parameters<typeof recommend>[0];

let indexPromise: Promise<IndexFile> | null = null;

async function loadIndex(): Promise<IndexFile> {
  if (!indexPromise) {
    indexPromise = (async () => {
      const p = path.join(process.cwd(), "data", "shl_index.json");
      const raw = await fs.readFile(p, "utf8");
      return JSON.parse(raw) as IndexFile;
    })();
  }
  return indexPromise;
}

function clampTopK(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 10;
  return Math.max(1, Math.min(10, Math.trunc(n)));
}

function extractTextFromHtml(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim();
  return text;
}

async function fetchUrlText(url: string): Promise<string> {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 20_000);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; shl-assignment-recommender/1.0)",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return extractTextFromHtml(html);
  } finally {
    clearTimeout(to);
  }
}

function pickInput(body: RecommendRequestBody): { input: string; topK: number } {
  const topK = clampTopK(body.top_k ?? body.topK);
  const q = (body.query ?? "").trim();
  const t = (body.text ?? "").trim();
  const u = (body.url ?? "").trim();

  if (q) return { input: q, topK };
  if (t) return { input: t, topK };
  if (u) return { input: u, topK }; // will be treated as URL below if it looks like one
  return { input: "", topK };
}

function looksLikeUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

async function handleRecommend(inputRaw: string, topK: number): Promise<RecommendResponse> {
  const idx = await loadIndex();
  const input = looksLikeUrl(inputRaw) ? await fetchUrlText(inputRaw) : inputRaw;

  const recs = await recommend(idx, input, topK, true);
  const items: RecommendItem[] = recs
    .slice(0, topK)
    .map((r) => ({
      assessment_name: r.name,
      assessment_url: r.url,
    }));

  return { recommended_assessments: items };
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("query") || req.nextUrl.searchParams.get("q") || "";
  const url = req.nextUrl.searchParams.get("url") || "";
  const topK = clampTopK(req.nextUrl.searchParams.get("top_k") || req.nextUrl.searchParams.get("topK"));

  const inputRaw = (q || url).trim();
  if (!inputRaw) {
    return NextResponse.json(
      { error: "Provide query via ?query=... or ?url=..." },
      { status: 400 },
    );
  }

  try {
    const out = await handleRecommend(inputRaw, topK);
    return NextResponse.json(out, { status: 200 });
  } catch (e) {
    return NextResponse.json(
      { error: "Recommendation failed", detail: String((e as Error)?.message ?? e) },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  let body: RecommendRequestBody | null = null;
  try {
    body = (await req.json()) as RecommendRequestBody;
  } catch {
    body = null;
  }

  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { input, topK } = pickInput(body);
  if (!input) {
    return NextResponse.json(
      { error: "Provide one of: query, text, url" },
      { status: 400 },
    );
  }

  try {
    const out = await handleRecommend(input, topK);
    return NextResponse.json(out, { status: 200 });
  } catch (e) {
    return NextResponse.json(
      { error: "Recommendation failed", detail: String((e as Error)?.message ?? e) },
      { status: 500 },
    );
  }
}


