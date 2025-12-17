import * as fs from "node:fs/promises";
import * as path from "node:path";

import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

import type { CatalogItem } from "./clean-catalog";
import type { EnrichedCatalogItem } from "./enrich-catalog";

type IndexItem = CatalogItem & {
  textForEmbedding: string;
  vector: number[];
};

type IndexFile = {
  provider: "gemini" | "local";
  model: string;
  dim: number;
  createdAt: string;
  items: IndexItem[];
};

const CLEAN_PATH = path.join("data", "shl_catalog_clean.json");
const ENRICHED_PATH = path.join("data", "shl_catalog_enriched.json");
const OUT_PATH = path.join("data", "shl_index.json");

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

function l2Normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const norm = Math.sqrt(s) || 1;
  return v.map((x) => x / norm);
}

// Simple deterministic embedding (fallback if no API key). Not "LLM", but lets you run end-to-end locally.
function localHashEmbedding(text: string, dim = 512): number[] {
  const v = new Array(dim).fill(0);
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9+.#/ ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  for (const t of tokens) {
    // djb2-ish hash
    let h = 5381;
    for (let i = 0; i < t.length; i++) h = (h * 33) ^ t.charCodeAt(i);
    const idx = Math.abs(h) % dim;
    v[idx] += 1;
  }
  return l2Normalize(v);
}

function buildTextForEmbedding(item: CatalogItem | EnrichedCatalogItem): string {
  // Richer text = better retrieval. Keep it compact to avoid huge prompts.
  const types = item.testTypes.join(", ");
  const remote = item.remoteTesting ? "remote testing available" : "remote testing not available";
  const adaptive = item.adaptiveIrt ? "adaptive IRT available" : "adaptive IRT not available";
  const parts: string[] = [
    item.name,
    `Test types: ${types}.`,
    `${remote}.`,
    `${adaptive}.`,
  ];

  const anyItem = item as Partial<EnrichedCatalogItem>;
  if (anyItem.assessmentLengthMinutes) {
    parts.push(`Approximate completion time: ${anyItem.assessmentLengthMinutes} minutes.`);
  }
  if (anyItem.jobLevels?.length) {
    parts.push(`Job levels: ${anyItem.jobLevels.join(", ")}.`);
  }
  if (anyItem.languages?.length) {
    parts.push(`Languages: ${anyItem.languages.join(", ")}.`);
  }
  if (anyItem.description) {
    parts.push(`Description: ${anyItem.description}`);
  }
  if (anyItem.downloads?.length) {
    const dlTitles = anyItem.downloads
      .map((d) => d.title)
      .filter(Boolean)
      .slice(0, 10);
    if (dlTitles.length) parts.push(`Downloads: ${dlTitles.join(", ")}.`);
  }

  return parts.join(" ");
}

async function geminiEmbedding(text: string): Promise<number[]> {
  const GEMINI_MODEL =
    process.env.GEMINI_EMBEDDING_MODEL || "text-embedding-004";
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY (or GOOGLE_API_KEY).");
  }
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  // Gemini Node SDK returns: { embedding: { values: number[] } }
  // If the SDK changes, this try/catch will surface it early.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await model.embedContent(text);
  const values: unknown = res?.embedding?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("Gemini embedContent returned no embedding values.");
  }
  return l2Normalize(values.map((x: unknown) => Number(x)));
}

async function main() {
  const GEMINI_MODEL =
    process.env.GEMINI_EMBEDDING_MODEL || "text-embedding-004";
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

  // Prefer enriched catalog ONLY if it looks complete. It's easy to accidentally have a partial
  // enriched file during long-running enrichment.
  const clean = JSON.parse(await fs.readFile(CLEAN_PATH, "utf8")) as CatalogItem[];

  let inPath = CLEAN_PATH;
  let raw: Array<CatalogItem | EnrichedCatalogItem> = clean;
  try {
    await fs.access(ENRICHED_PATH);
    const enriched = JSON.parse(await fs.readFile(ENRICHED_PATH, "utf8")) as EnrichedCatalogItem[];
    if (enriched.length >= clean.length) {
      inPath = ENRICHED_PATH;
      raw = enriched;
    } else {
      // eslint-disable-next-line no-console
      console.log(
        `Enriched catalog is partial (${enriched.length}/${clean.length}); using clean catalog until enrichment finishes.`,
      );
    }
  } catch {
    // fall back to clean
  }

  const itemsBase = raw.map((it) => ({
    ...it,
    textForEmbedding: buildTextForEmbedding(it),
  }));

  const useGemini = Boolean(GEMINI_API_KEY);
  const provider: IndexFile["provider"] = useGemini ? "gemini" : "local";
  const model = useGemini ? GEMINI_MODEL : "local-hash-512";
  const dim = useGemini ? -1 : 512; // fill after first embedding for gemini

  if (!useGemini) {
    // eslint-disable-next-line no-console
    console.log(
      "No GEMINI_API_KEY/GOOGLE_API_KEY found in env or .env; falling back to local deterministic embeddings.",
    );
  }

  const items: IndexItem[] = [];
  for (let i = 0; i < itemsBase.length; i++) {
    const it = itemsBase[i];
    // eslint-disable-next-line no-console
    if (i % 25 === 0) console.log(`Embedding ${i}/${itemsBase.length}...`);

    const vector = useGemini
      ? await geminiEmbedding(it.textForEmbedding)
      : localHashEmbedding(it.textForEmbedding, 512);

    items.push({ ...it, vector });
  }

  const finalDim = useGemini ? items[0]?.vector.length ?? 0 : dim;
  const out: IndexFile = {
    provider,
    model,
    dim: finalDim,
    createdAt: new Date().toISOString(),
    items,
  };

  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2), "utf8");

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        input: inPath,
        output: OUT_PATH,
        provider,
        model,
        dim: finalDim,
        total: items.length,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});


