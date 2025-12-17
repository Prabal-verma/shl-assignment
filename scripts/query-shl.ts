import { loadIndex, recommend } from "./lib/recommender";

async function main() {
  const query = process.argv.slice(2).join(" ").trim();
  if (!query) {
    throw new Error('Usage: npm run query:shl -- "your query here"');
  }

  const index = await loadIndex();
  const top = await recommend(index, query, 10, true);

  // eslint-disable-next-line no-console
  console.log(
    top
      .map(
        (x, i) =>
          `${String(i + 1).padStart(2, "0")}. ${x.name} | ${x.url} | types=${x.testTypes.join(
            ",",
          )} | score=${x.score.toFixed(4)}`,
      )
      .join("\n"),
  );
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});


