import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import * as cheerio from "cheerio";

import type { CatalogItem } from "./clean-catalog";

type DownloadItem = {
  title: string;
  language?: string;
  url?: string;
};

export type EnrichedCatalogItem = CatalogItem & {
  description?: string;
  jobLevels?: string[];
  languages?: string[];
  assessmentLengthMinutes?: number;
  downloads?: DownloadItem[];
  enrichedAt?: string;
};

const IN_PATH = path.join("data", "shl_catalog_clean.json");
const OUT_PATH = path.join("data", "shl_catalog_enriched.json");

const HEADERS = {
  "user-agent": "Mozilla/5.0 (compatible; shl-assignment-enricher/1.0)",
  accept: "text/html,application/xhtml+xml",
};

function parseArgs(argv: string[]) {
  const opts = {
    concurrency: 3,
    delayMs: 250,
    timeoutMs: 30_000,
    retries: 3,
    resume: true,
    max: Infinity as number,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--concurrency") opts.concurrency = Number(argv[++i] ?? opts.concurrency);
    else if (a === "--delayMs") opts.delayMs = Number(argv[++i] ?? opts.delayMs);
    else if (a === "--timeoutMs") opts.timeoutMs = Number(argv[++i] ?? opts.timeoutMs);
    else if (a === "--retries") opts.retries = Number(argv[++i] ?? opts.retries);
    else if (a === "--noResume") opts.resume = false;
    else if (a === "--max") opts.max = Number(argv[++i] ?? opts.max);
  }
  if (!Number.isFinite(opts.concurrency) || opts.concurrency < 1) {
    throw new Error(`Invalid --concurrency: ${opts.concurrency}`);
  }
  return opts;
}

async function fetchPage(url: string, timeoutMs: number, retries: number): Promise<string | null> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), timeoutMs);
      const res = await fetch(url, { headers: HEADERS, signal: ac.signal });
      clearTimeout(to);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch {
      // eslint-disable-next-line no-console
      console.log(`Fetch failed (${attempt + 1}/${retries}) for ${url}`);
      await sleep(1_000);
    }
  }
  return null;
}

function normList(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractSectionText($: cheerio.CheerioAPI, heading: string): string {
  const h4 = $("h4")
    .filter((_, el) => $(el).text().trim().toLowerCase() === heading.toLowerCase())
    .first();
  if (!h4.length) return "";
  return h4.parent().find("p").first().text().replace(/\s+/g, " ").trim();
}

function parseAssessmentLengthMinutes(text: string): number | undefined {
  // Example: "Approximate Completion Time in minutes = 30"
  const m = text.match(/minutes\s*=\s*(\d+)/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

function parseDownloads($: cheerio.CheerioAPI): DownloadItem[] | undefined {
  const items: DownloadItem[] = [];
  $("ul.product-catalogue__downloads li.product-catalogue__download").each((_, li) => {
    const $li = $(li);
    const $a = $li.find("a").first();
    const title = $a.text().replace(/\s+/g, " ").trim();
    const href = ($a.attr("href") ?? "").trim();
    const language = $li.find("p.product-catalogue__download-language").first().text().trim();
    if (!title) return;
    items.push({
      title,
      language: language || undefined,
      url: href || undefined,
    });
  });
  return items.length ? items : undefined;
}

function parseDetailPage(html: string): Omit<EnrichedCatalogItem, keyof CatalogItem> {
  const $ = cheerio.load(html);
  const description = extractSectionText($, "Description");
  const jobLevelsText = extractSectionText($, "Job levels");
  const languagesText = extractSectionText($, "Languages");
  const lengthText = extractSectionText($, "Assessment length");

  return {
    description: description || undefined,
    jobLevels: jobLevelsText ? normList(jobLevelsText) : undefined,
    languages: languagesText ? normList(languagesText) : undefined,
    assessmentLengthMinutes: parseAssessmentLengthMinutes(lengthText),
    downloads: parseDownloads($),
    enrichedAt: new Date().toISOString(),
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function readExisting(): Promise<Map<string, EnrichedCatalogItem>> {
  try {
    const t = await fs.readFile(OUT_PATH, "utf8");
    const arr = JSON.parse(t) as EnrichedCatalogItem[];
    return new Map(arr.map((x) => [x.url, x]));
  } catch {
    return new Map();
  }
}

async function writeCheckpoint(
  outMap: Map<string, EnrichedCatalogItem>,
  reason: string,
) {
  const out = [...outMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2), "utf8");

  const withDesc = out.filter((x) => x.description && x.description.length > 0).length;
  const withLen = out.filter((x) => typeof x.assessmentLengthMinutes === "number").length;

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        checkpoint: reason,
        saved: out.length,
        withDescription: withDesc,
        withAssessmentLength: withLen,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const catalog = JSON.parse(await fs.readFile(IN_PATH, "utf8")) as CatalogItem[];
  const existing = opts.resume ? await readExisting() : new Map<string, EnrichedCatalogItem>();

  const pending = catalog
    .filter((x) => !existing.has(x.url))
    .slice(0, Number.isFinite(opts.max) ? opts.max : catalog.length);

  const startedAt = Date.now();
  let done = 0;
  let ok = 0;
  let failed = 0;

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        input: IN_PATH,
        output: OUT_PATH,
        total: catalog.length,
        alreadyEnriched: existing.size,
        toEnrichNow: pending.length,
        concurrency: opts.concurrency,
        delayMs: opts.delayMs,
      },
      null,
      2,
    ),
  );

  // Heartbeat log so it's obvious the process isn't stuck
  const heartbeat = setInterval(() => {
    const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    const rate = done / elapsedSec;
    const remaining = Math.max(0, pending.length - done);
    const etaSec = rate > 0 ? Math.round(remaining / rate) : null;
    // eslint-disable-next-line no-console
    console.log(
      `[progress] done=${done}/${pending.length} ok=${ok} failed=${failed} rate=${rate.toFixed(
        3,
      )}/s eta=${etaSec === null ? "?" : `${etaSec}s`}`,
    );
  }, 15_000);

  const enrichedNow = await mapWithConcurrency(pending, opts.concurrency, async (item, idx) => {
    const t0 = Date.now();
    // eslint-disable-next-line no-console
    console.log(`[fetch] (${idx + 1}/${pending.length}) ${item.name} -> ${item.url}`);

    const html = await fetchPage(item.url, opts.timeoutMs, opts.retries);
    if (!html) {
      failed++;
      done++;
      // eslint-disable-next-line no-console
      console.log(
        `[fail] (${idx + 1}/${pending.length}) ${item.name} (took ${Date.now() - t0}ms)`,
      );
      const partial = { ...item, enrichedAt: new Date().toISOString() } as EnrichedCatalogItem;
      existing.set(partial.url, partial);
      if (done % 25 === 0) await writeCheckpoint(existing, `every-25 (done=${done})`);
      return partial;
    }
    const detail = parseDetailPage(html);

    ok++;
    done++;
    const took = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(
      `[ok] (${idx + 1}/${pending.length}) ${item.name} (took ${took}ms) fields=${
        [
          detail.description ? "desc" : null,
          detail.jobLevels?.length ? `jobLevels:${detail.jobLevels.length}` : null,
          detail.languages?.length ? `langs:${detail.languages.length}` : null,
          typeof detail.assessmentLengthMinutes === "number" ? `mins:${detail.assessmentLengthMinutes}` : null,
          detail.downloads?.length ? `downloads:${detail.downloads.length}` : null,
        ]
          .filter(Boolean)
          .join(",") || "none"
      }`,
    );

    if (opts.delayMs > 0) await sleep(opts.delayMs);
    const full = { ...item, ...detail } as EnrichedCatalogItem;
    existing.set(full.url, full);
    if (done % 25 === 0) await writeCheckpoint(existing, `every-25 (done=${done})`);
    return full;
  });

  clearInterval(heartbeat);
  // Ensure any not-yet-saved results (should already be in `existing`) are persisted
  for (const it of enrichedNow) existing.set(it.url, it);
  await writeCheckpoint(existing, "final");
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});


