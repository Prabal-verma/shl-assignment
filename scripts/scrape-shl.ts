import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import * as cheerio from "cheerio";

type CatalogRow = {
  entityId: string;
  name: string;
  url: string;
  remoteTesting: boolean;
  adaptiveIrt: boolean;
  testTypes: string[];
};

const BASE_URL = "https://www.shl.com";
const CATALOG_URL = `${BASE_URL}/products/product-catalog/`;
const HEADERS = {
  "user-agent": "Mozilla/5.0",
  accept: "text/html,application/xhtml+xml",
};

async function fetchPage(url: string, retries = 3): Promise<string | null> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 30_000);
      const res = await fetch(url, { headers: HEADERS, signal: ac.signal });
      clearTimeout(to);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch {
      // eslint-disable-next-line no-console
      console.log(`Network error. Retry ${attempt + 1}/${retries}`);
      await sleep(5_000);
    }
  }
  return null;
}

function absUrl(href: string): string {
  return new URL(href, BASE_URL).toString();
}

async function scrapeIndividualTests(): Promise<CatalogRow[]> {
  let start = 0;
  const results: CatalogRow[] = [];

  while (true) {
    const url = `${CATALOG_URL}?start=${start}&type=1`;
    // eslint-disable-next-line no-console
    console.log(`Scraping page start=${start}`);

    const html = await fetchPage(url);
    if (!html) {
      // eslint-disable-next-line no-console
      console.log("Skipping page due to repeated failure");
      start += 12;
      continue;
    }

    const $ = cheerio.load(html);
    const rows = $("tr[data-entity-id]");
    if (rows.length === 0) break;

    rows.each((_, row) => {
      const $row = $(row);
      const entityId = String($row.attr("data-entity-id") ?? "").trim();

      const $a = $row.find("td.custom__table-heading__title a").first();
      const name = $a.text().trim();
      const href = String($a.attr("href") ?? "").trim();
      if (!entityId || !name || !href) return;

      const cols = $row.find("td.custom__table-heading__general");
      const remoteTesting =
        cols.eq(0).find("span.catalogue__circle.-yes").length > 0;
      const adaptiveIrt =
        cols.eq(1).find("span.catalogue__circle.-yes").length > 0;

      const testTypes = $row
        .find("span.product-catalogue__key")
        .toArray()
        .map((el) => $(el).text().trim())
        .filter(Boolean);

      results.push({
        entityId,
        name,
        url: absUrl(href),
        remoteTesting,
        adaptiveIrt,
        testTypes,
      });
    });

    const nextBtn =
      $("li.pagination__item.-arrow.-next a").first().get(0) ??
      $("li.pagination__item.-next a").first().get(0);
    if (!nextBtn) break;

    start += 12;
    await sleep(2_000);
  }

  // Deduplicate by URL (simple safety)
  const seen = new Set<string>();
  return results.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)));
}

function csvEscape(value: unknown): string {
  const s =
    value === null || value === undefined
      ? ""
      : Array.isArray(value)
        ? value.join(",")
        : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const data = await scrapeIndividualTests();
  if (data.length < 377) {
    throw new Error(`Only scraped ${data.length}. Expected at least 377.`);
  }

  await fs.mkdir("data", { recursive: true });

  await fs.writeFile(
    path.join("data", "shl_catalog.json"),
    JSON.stringify(data, null, 2),
    "utf8",
  );

  const headers = [
    "entityId",
    "name",
    "url",
    "remoteTesting",
    "adaptiveIrt",
    "testTypes",
  ];
  const lines = [
    headers.join(","),
    ...data.map((r) => headers.map((h) => csvEscape((r as any)[h])).join(",")),
  ];
  await fs.writeFile(path.join("data", "shl_catalog.csv"), lines.join("\n"), "utf8");

  // eslint-disable-next-line no-console
  console.log(`Saved ${data.length} records to data/shl_catalog.csv and data/shl_catalog.json`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});


