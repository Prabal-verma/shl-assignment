import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as xlsx from "xlsx";

import { loadIndex, recommend } from "./lib/recommender";

type TestRow = {
  Query: string;
};

function csvEscape(value: string): string {
  const s = value ?? "";
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const workbookPath = path.join("data", "Gen_AI Dataset.xlsx");
  const outPath = path.join("data", "test_predictions.csv");

  const wb = xlsx.readFile(workbookPath);
  const ws = wb.Sheets["Test-Set"];
  if (!ws) throw new Error("Sheet not found: Test-Set");

  const rows = xlsx.utils.sheet_to_json(ws, { defval: "" }) as TestRow[];
  const queries = rows.map((r) => String(r.Query ?? "").trim()).filter(Boolean);
  if (!queries.length) throw new Error("No queries found in Test-Set.");

  const index = await loadIndex();

  const lines: string[] = ["Query,Assessment_url"];

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    // eslint-disable-next-line no-console
    console.log(`Predicting ${i + 1}/${queries.length}...`);

    const recs = await recommend(index, q, 10, true);
    for (const r of recs) {
      lines.push(`${csvEscape(q)},${csvEscape(r.url)}`);
    }
  }

  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(outPath, lines.join("\n"), "utf8");

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        output: outPath,
        queries: queries.length,
        rows: lines.length - 1,
        perQuery: 10,
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


