import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

export type IndexFile = {
  provider: "gemini" | "local";
  model: string;
  dim: number;
  items: Array<{
    entityId: string;
    name: string;
    url: string;
    remoteTesting: boolean;
    adaptiveIrt: boolean;
    testTypes: string[];
    textForEmbedding: string;
    vector: number[];
    assessmentLengthMinutes?: number;
  }>;
};

export type Recommendation = {
  name: string;
  url: string;
  testTypes: string[];
  score: number;
  assessmentLengthMinutes?: number;
};

const DEFAULT_INDEX_PATH = path.join("data", "shl_index.json");

function l2Normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const norm = Math.sqrt(s) || 1;
  return v.map((x) => x / norm);
}

function localHashEmbedding(text: string, dim: number): number[] {
  const v = new Array(dim).fill(0);
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9+.#/ ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  for (const t of tokens) {
    let h = 5381;
    for (let i = 0; i < t.length; i++) h = (h * 33) ^ t.charCodeAt(i);
    const idx = Math.abs(h) % dim;
    v[idx] += 1;
  }
  return l2Normalize(v);
}

function cosine(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function wantsSoftSkills(q: string): boolean {
  return /\b(collaborat|communication|stakeholder|teamwork|team|leadership|interpersonal|business teams?)\b/i.test(
    q,
  );
}

function wantsHardSkills(q: string): boolean {
  return /\b(java|python|sql|javascript|js|developer|engineer|cloud|api|backend|frontend)\b/i.test(
    q,
  );
}

function balancedRerank(
  scored: Recommendation[],
  k: number,
  query: string,
): Recommendation[] {
  const needK = wantsHardSkills(query);
  const needP = wantsSoftSkills(query);
  if (!(needK && needP)) return scored.slice(0, k);

  const K = scored.filter((x) => x.testTypes.includes("K"));
  const P = scored.filter((x) => x.testTypes.includes("P"));
  const other = scored.filter(
    (x) => !x.testTypes.includes("K") && !x.testTypes.includes("P"),
  );

  const out: Recommendation[] = [];
  let i = 0;
  while (out.length < k && (i < K.length || i < P.length)) {
    if (i < K.length) out.push(K[i]);
    if (out.length >= k) break;
    if (i < P.length) out.push(P[i]);
    i++;
  }
  for (const x of [...K.slice(i), ...P.slice(i), ...other]) {
    if (out.length >= k) break;
    if (!out.includes(x)) out.push(x);
  }
  return out;
}

type DurationConstraint =
  | { kind: "range"; min: number; max: number }
  | { kind: "max"; max: number }
  | { kind: "min"; min: number }
  | { kind: "target"; target: number; tolerance: number };

function toMinutes(n: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith("hour") || u.startsWith("hr")) return Math.round(n * 60);
  return Math.round(n);
}

function parseDurationConstraint(query: string): DurationConstraint | null {
  const q = query.toLowerCase();

  if (/\babout an hour\b|\baround an hour\b|\b~\s*1\s*hour\b/.test(q)) {
    return { kind: "target", target: 60, tolerance: 15 };
  }

  const range = q.match(
    /\b(\d+)\s*(?:-|to)\s*(\d+)\s*(mins?|minutes?|hrs?|hours?)\b/,
  );
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    const unit = range[3];
    const min = Math.min(toMinutes(a, unit), toMinutes(b, unit));
    const max = Math.max(toMinutes(a, unit), toMinutes(b, unit));
    return { kind: "range", min, max };
  }

  const max = q.match(
    /\b(?:at most|no more than|not more than|<=)\s*(\d+)\s*(mins?|minutes?|hrs?|hours?)\b/,
  );
  if (max) {
    return { kind: "max", max: toMinutes(Number(max[1]), max[2]) };
  }

  const approx = q.match(
    /\b(?:about|around|approx(?:imately)?)\s*(\d+)\s*(mins?|minutes?|hrs?|hours?)\b/,
  );
  if (approx) {
    const target = toMinutes(Number(approx[1]), approx[2]);
    return {
      kind: "target",
      target,
      tolerance: Math.max(10, Math.round(target * 0.25)),
    };
  }

  const plain = q.match(/\b(\d+)\s*(mins?|minutes?|hrs?|hours?)\b/);
  if (plain) {
    const target = toMinutes(Number(plain[1]), plain[2]);
    return {
      kind: "target",
      target,
      tolerance: Math.max(10, Math.round(target * 0.25)),
    };
  }

  if (/\bhour\b/.test(q)) return { kind: "target", target: 60, tolerance: 15 };
  return null;
}

function durationAdjustedScore(
  baseScore: number,
  itemMinutes: number | undefined,
  constraint: DurationConstraint,
): number {
  if (typeof itemMinutes !== "number" || !Number.isFinite(itemMinutes)) return baseScore;

  let min = 0;
  let max = Infinity;
  if (constraint.kind === "range") {
    min = constraint.min;
    max = constraint.max;
  } else if (constraint.kind === "max") {
    max = constraint.max;
  } else if (constraint.kind === "min") {
    min = constraint.min;
  } else {
    min = Math.max(0, constraint.target - constraint.tolerance);
    max = constraint.target + constraint.tolerance;
  }

  const inWindow = itemMinutes >= min && itemMinutes <= max;
  const delta = inWindow ? 0.015 : -0.015;

  // Strongly penalize violating "max" constraints
  let extra = 0;
  if ((constraint.kind === "max" || constraint.kind === "range") && itemMinutes > max) {
    extra = -Math.min(0.02, (itemMinutes - max) / 300);
  }

  return baseScore + delta + extra;
}

function testTypeIntentBoost(query: string, testTypes: string[]): number {
  const q = query.toLowerCase();
  const weights = new Map<string, number>();

  // Behavioral / culture fit / leadership
  if (/\b(cultur|culture|values|fit)\b/.test(q)) {
    weights.set("P", (weights.get("P") ?? 0) + 0.02);
    weights.set("C", (weights.get("C") ?? 0) + 0.01);
  }
  if (
    /\b(personality|behavior|behaviour|opq|leadership|executive|coo|ceo|cfo)\b/.test(
      q,
    )
  ) {
    weights.set("P", (weights.get("P") ?? 0) + 0.02);
    weights.set("C", (weights.get("C") ?? 0) + 0.01);
    weights.set("D", (weights.get("D") ?? 0) + 0.005);
  }
  if (/\bchina\b/.test(q) && /\b(cultur|culture|fit)\b/.test(q)) {
    weights.set("P", (weights.get("P") ?? 0) + 0.01);
  }

  // Cognitive / ability emphasis
  if (/\b(aptitude|cognitive|ability|numerical|verbal|reasoning)\b/.test(q)) {
    weights.set("A", (weights.get("A") ?? 0) + 0.02);
    weights.set("K", (weights.get("K") ?? 0) + 0.01);
  }

  // Admin/clerical/banking
  if (/\b(admin|assistant|clerical|back office|operations|bank|icici)\b/.test(q)) {
    weights.set("A", (weights.get("A") ?? 0) + 0.01);
    weights.set("S", (weights.get("S") ?? 0) + 0.01);
    weights.set("K", (weights.get("K") ?? 0) + 0.005);
  }

  // Sales / customer-facing
  if (/\b(sales|customer|account manager|business development)\b/.test(q)) {
    weights.set("B", (weights.get("B") ?? 0) + 0.015);
    weights.set("P", (weights.get("P") ?? 0) + 0.01);
    weights.set("C", (weights.get("C") ?? 0) + 0.005);
  }

  // Technical hiring: prioritize knowledge/skills tests
  if (/\b(java|python|sql|javascript|js|developer|engineer|qa|automation|selenium)\b/.test(q)) {
    weights.set("K", (weights.get("K") ?? 0) + 0.02);
  }

  // Explicit simulation mention
  if (/\bsimulation|simulations\b/.test(q)) {
    weights.set("S", (weights.get("S") ?? 0) + 0.02);
  }

  let boost = 0;
  for (const t of testTypes) boost += weights.get(t) ?? 0;

  // Avoid multi-type items winning purely due to having more letters
  boost = testTypes.length ? boost / Math.sqrt(testTypes.length) : 0;
  return Math.max(-0.03, Math.min(0.03, boost));
}

function combineVectors(a: number[], b: number[], wa: number, wb: number): number[] {
  const n = Math.min(a.length, b.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = wa * a[i] + wb * b[i];
  return l2Normalize(out);
}

function shouldSummarize(text: string): boolean {
  const chars = text.length;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return chars >= 500 || words >= 120;
}

const summaryCache = new Map<string, string>();

async function summarizeForRetrieval(text: string): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;

  const cacheKey = crypto.createHash("sha1").update(text).digest("hex");
  const cached = summaryCache.get(cacheKey);
  if (cached) return cached;

  const genAI = new GoogleGenerativeAI(apiKey);
  const preferred = (process.env.GEMINI_GENERATION_MODEL || "gemini-2.5-flash").trim();
  const candidates = [
    preferred,
    // fallbacks in case a model isn't enabled for the account / api version
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash-latest",
    "gemini-1.5-pro-latest",
  ].filter(Boolean);

  const prompt = [
    "Extract search keywords for an SHL assessment recommender.",
    "Output ONE line of comma-separated keywords only (no sentences).",
    "Include: role title, key hard skills, key soft skills, seniority, domain/industry, and any time constraint (minutes/hours).",
    "",
    text,
  ].join("\n");

  let out = "";
  let lastErr: unknown = null;
  for (const genModel of candidates) {
    try {
      const model = genAI.getGenerativeModel({ model: genModel });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0 },
      });
      out = String(res?.response?.text?.() ?? "").trim();
      if (out) break;
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  if (!out) return null;

  summaryCache.set(cacheKey, out);
  return out;
}

async function embedQuery(index: IndexFile, text: string): Promise<number[]> {
  if (index.provider === "local") return localHashEmbedding(text, index.dim);

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("Index was built with Gemini, but GEMINI_API_KEY is missing.");
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: index.model });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await model.embedContent(text);
  const values: unknown = res?.embedding?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("Gemini embedContent returned no embedding values.");
  }
  return l2Normalize(values.map((x: unknown) => Number(x)));
}

export async function loadIndex(indexPath = DEFAULT_INDEX_PATH): Promise<IndexFile> {
  return JSON.parse(await fs.readFile(indexPath, "utf8")) as IndexFile;
}

export async function recommend(
  index: IndexFile,
  query: string,
  topK = 10,
  balance = true,
): Promise<Recommendation[]> {
  const baseVec = await embedQuery(index, query);
  let qv = baseVec;

  // For long JDs, keyword summarization helps retrieval.
  if (index.provider === "gemini" && shouldSummarize(query)) {
    const summary = await summarizeForRetrieval(query);
    if (summary) {
      const sumVec = await embedQuery(index, summary);
      const wOrig = Number(process.env.RETRIEVAL_QUERY_WEIGHT_ORIG ?? 0.75);
      const wSum = Number(process.env.RETRIEVAL_QUERY_WEIGHT_SUM ?? 0.25);
      qv = combineVectors(baseVec, sumVec, wOrig, wSum);
    }
  }

  const duration = parseDurationConstraint(query);
  const scored: Recommendation[] = index.items
    .map((it) => ({
      name: it.name,
      url: it.url,
      testTypes: it.testTypes,
      assessmentLengthMinutes: it.assessmentLengthMinutes,
      score: (() => {
        const base = cosine(qv, it.vector);
        const durAdjusted = duration
          ? durationAdjustedScore(base, it.assessmentLengthMinutes, duration)
          : base;
        return durAdjusted + testTypeIntentBoost(query, it.testTypes);
      })(),
    }))
    .sort((a, b) => b.score - a.score);

  return balance ? balancedRerank(scored, topK, query) : scored.slice(0, topK);
}


