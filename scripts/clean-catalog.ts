import * as fs from "node:fs/promises";
import * as path from "node:path";

type RawRow = {
  entityId?: unknown;
  name?: unknown;
  url?: unknown;
  remoteTesting?: unknown;
  adaptiveIrt?: unknown;
  testTypes?: unknown;
};

export type CatalogItem = {
  entityId: string;
  name: string;
  url: string;
  remoteTesting: boolean;
  adaptiveIrt: boolean;
  testTypes: string[];
};

const IN_PATH = path.join("data", "shl_catalog.json");
const OUT_PATH = path.join("data", "shl_catalog_clean.json");
const BASE_URL = "https://www.shl.com";

function normalizeName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

function normalizeUrl(u: string): string {
  return new URL(u, BASE_URL).toString();
}

function normalizeTestTypes(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : [];
  const types = arr
    .map((x) => String(x ?? "").trim().toUpperCase())
    .filter(Boolean);
  return [...new Set(types)].sort();
}

function normalizeBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.toLowerCase() === "true";
  if (typeof v === "number") return v !== 0;
  return false;
}

async function main() {
  const rawText = await fs.readFile(IN_PATH, "utf8");
  const raw = JSON.parse(rawText) as RawRow[];

  const cleaned: CatalogItem[] = [];
  for (const r of raw) {
    const entityId = String(r.entityId ?? "").trim();
    const name = normalizeName(String(r.name ?? ""));
    const url = String(r.url ?? "").trim();
    if (!entityId || !name || !url) continue;

    cleaned.push({
      entityId,
      name,
      url: normalizeUrl(url),
      remoteTesting: normalizeBool(r.remoteTesting),
      adaptiveIrt: normalizeBool(r.adaptiveIrt),
      testTypes: normalizeTestTypes(r.testTypes),
    });
  }

  // Dedupe by URL (most stable unique key)
  const byUrl = new Map<string, CatalogItem>();
  for (const item of cleaned) byUrl.set(item.url, item);
  const out = [...byUrl.values()].sort((a, b) => a.name.localeCompare(b.name));

  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2), "utf8");

  const typeCounts: Record<string, number> = {};
  for (const it of out) {
    for (const t of it.testTypes) typeCounts[t] = (typeCounts[t] ?? 0) + 1;
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        input: IN_PATH,
        output: OUT_PATH,
        total: out.length,
        testTypeCounts: typeCounts,
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


