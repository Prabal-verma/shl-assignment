import * as path from "node:path";

import * as xlsx from "xlsx";

import { loadIndex, recommend } from "./lib/recommender";

type TrainRow = {
  Query: string;
  Assessment_url: string;
};

function normUrl(u: string): string {
  // Labels sometimes use `/solutions/products/product-catalog/view/...` while our scraped catalog uses
  // `/products/product-catalog/view/...`. Canonicalize by extracting the `view/<slug>` portion.
  const raw = u.trim();
  try {
    const url = new URL(raw);
    const m = url.pathname.match(/\/product-catalog\/view\/([^/]+)\/?$/i);
    if (m?.[1]) {
      const slug = m[1];
      return `https://www.shl.com/products/product-catalog/view/${slug}/`;
    }
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "/");
    return url.toString();
  } catch {
    const m = raw.match(/\/product-catalog\/view\/([^/]+)\/?$/i);
    if (m?.[1]) return `https://www.shl.com/products/product-catalog/view/${m[1]}/`;
    return raw;
  }
}

function groupLabels(rows: TrainRow[]) {
  const byQuery = new Map<string, Set<string>>();
  for (const r of rows) {
    const q = (r.Query ?? "").trim();
    const u = (r.Assessment_url ?? "").trim();
    if (!q || !u) continue;
    if (!byQuery.has(q)) byQuery.set(q, new Set());
    byQuery.get(q)!.add(normUrl(u));
  }
  return byQuery;
}

function recallAtK(pred: string[], truth: Set<string>, k: number): number {
  const top = pred.slice(0, k);
  let hit = 0;
  for (const u of top) if (truth.has(normUrl(u))) hit++;
  return truth.size ? hit / truth.size : 0;
}

async function main() {
  const workbookPath = path.join("data", "Gen_AI Dataset.xlsx");
  const wb = xlsx.readFile(workbookPath);
  const sheetName = "Train-Set";
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`Sheet not found: ${sheetName}`);

  const rows = xlsx.utils.sheet_to_json(ws, { defval: "" }) as TrainRow[];
  const labelsByQuery = groupLabels(rows);

  const index = await loadIndex();
  const perQuery: Array<{
    query: string;
    relevant: number;
    recallAt10: number;
    hitsAt10: number;
  }> = [];

  let sum = 0;
  for (const [query, truth] of labelsByQuery.entries()) {
    const recs = await recommend(index, query, 10, true);
    const predUrls = recs.map((r) => r.url);
    const r10 = recallAtK(predUrls, truth, 10);
    const hitsAt10 = Math.round(r10 * truth.size);
    perQuery.push({
      query,
      relevant: truth.size,
      recallAt10: r10,
      hitsAt10,
    });
    sum += r10;
  }

  const meanRecallAt10 = labelsByQuery.size ? sum / labelsByQuery.size : 0;

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        sheet: sheetName,
        queries: labelsByQuery.size,
        meanRecallAt10,
      },
      null,
      2,
    ),
  );

  // eslint-disable-next-line no-console
  console.log(
    "\nPer-query Recall@10:\n" +
      perQuery
        .sort((a, b) => b.recallAt10 - a.recallAt10)
        .map(
          (x) =>
            `- recall@10=${x.recallAt10.toFixed(3)} (${x.hitsAt10}/${x.relevant}) | ${x.query}`,
        )
        .join("\n"),
  );
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});


