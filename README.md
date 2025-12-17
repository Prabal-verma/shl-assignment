# SHL Assessment Recommendation System

This project builds an assessment recommender over SHL’s **Product Catalog → Individual Test Solutions**.

**Input**
- Natural language query
- Job description text
- URL containing a job description (the API fetches and extracts text)

**Output**
- 5–10 recommended assessments with **assessment name** and **catalog URL**

## Approach (high level)

### Data pipeline
1. **Scrape catalog list** (`npm run scrape:shl`)
   - Uses server-rendered pagination: `?type=1&start=...`
   - Extracts only “Individual Test Solutions” rows (`tr[data-entity-id]`) and ignores pre-packaged solutions
   - Produces `data/shl_catalog.json` and `data/shl_catalog.csv` (377 items)

2. **Clean/normalize** (`npm run clean:catalog`)
   - Normalizes URLs/names/booleans/testTypes and deduplicates
   - Produces `data/shl_catalog_clean.json`

3. **Enrich each assessment page** (`npm run enrich:catalog`)
   - Visits each `/products/product-catalog/view/.../` page and extracts:
     - description, job levels, languages, assessment length, downloads
   - Produces `data/shl_catalog_enriched.json`

### Retrieval / recommendation (RAG)
4. **Embed + index** (`npm run build:index`)
   - Builds `data/shl_index.json`
   - Uses Gemini embeddings when `GEMINI_API_KEY` is set
   - Embedding text includes the enriched fields (when available) for better relevance

5. **Query-time logic**
   - Vector similarity search over all 377 assessments (cosine similarity)
   - Lightweight reranking:
     - Duration-aware adjustment when a query mentions time
     - Intent-based test-type boosting (e.g. culture-fit → P, technical → K)
     - Balanced mix of K and P when query contains both technical + collaboration signals

## Evaluation
- `npm run eval:train` reads the labelled `Train-Set` from `data/Gen_AI Dataset.xlsx`
- Computes Recall@10 per query and Mean Recall@10
- Canonicalizes labelled URLs (some use `/solutions/products/...`) to match scraped catalog URLs

## Required submission CSV (test set predictions)
- `npm run predict:test`
  - Reads 9 queries from `Test-Set` (same Excel file)
  - Writes `data/test_predictions.csv` in the required repeated-row format:
    - `Query,Assessment_url` (10 rows per query)

## API
Endpoints are implemented using Next.js route handlers:
- `GET /api/health` → `{ "status": "ok" }`
- `GET|POST /api/recommend`
  - POST body (JSON): one of `{ query }`, `{ text }`, `{ url }`, plus optional `top_k` (1–10)
  - Response:
    - `{ "recommended_assessments": [ { "assessment_name": "...", "assessment_url": "..." }, ... ] }`

## Frontend
- Run `npm run dev` and open `http://localhost:3000`.
- Paste query/JD/URL, choose Top K, and view results in a table.

## Setup

### Install
```bash
npm install
```

### Environment variables
Create `.env` with:
```bash
GEMINI_API_KEY=your_key_here
```

Optional:
```bash
GEMINI_EMBEDDING_MODEL=text-embedding-004
GEMINI_GENERATION_MODEL=gemini-2.5-flash
RETRIEVAL_QUERY_WEIGHT_ORIG=0.75
RETRIEVAL_QUERY_WEIGHT_SUM=0.25
```

## Common commands
```bash
npm run scrape:shl
npm run clean:catalog
npm run enrich:catalog
npm run build:index
npm run eval:train
npm run predict:test
npm run dev
```
