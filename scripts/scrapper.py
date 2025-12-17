import requests
from bs4 import BeautifulSoup
import pandas as pd
from urllib.parse import urljoin
import time
import json

BASE_URL = "https://www.shl.com"
CATALOG_URL = f"{BASE_URL}/products/product-catalog/"
HEADERS = {
    "User-Agent": "Mozilla/5.0"
}

session = requests.Session()
session.headers.update(HEADERS)


def fetch_page(url, retries=3):
    for attempt in range(retries):
        try:
            res = session.get(url, timeout=30)
            res.raise_for_status()
            return res.text
        except requests.exceptions.RequestException:
            print(f"Network error. Retry {attempt + 1}/{retries}")
            time.sleep(5)
    return None


def scrape_individual_tests():
    start = 0
    results = []

    while True:
        url = f"{CATALOG_URL}?start={start}&type=1"
        print(f"Scraping page start={start}")

        html = fetch_page(url)
        if not html:
            print("Skipping page due to repeated failure")
            start += 12
            continue

        soup = BeautifulSoup(html, "html.parser")
        rows = soup.select("tr[data-entity-id]")

        if not rows:
            break

        for row in rows:
            entity_id = row.get("data-entity-id")

            title_tag = row.select_one("td.custom__table-heading__title a")
            title = title_tag.text.strip()
            link = urljoin(BASE_URL, title_tag["href"])

            cols = row.select("td.custom__table-heading__general")
            remote_testing = bool(cols[0].select_one(".-yes"))
            adaptive_irt = bool(cols[1].select_one(".-yes"))

            test_type_tags = row.select(".product-catalogue__key")
            test_types = [tag.text.strip() for tag in test_type_tags]

            results.append({
                "entityId": entity_id,
                "name": title,
                "url": link,
                "remoteTesting": remote_testing,
                "adaptiveIrt": adaptive_irt,
                "testTypes": test_types
            })

        next_btn = soup.select_one("li.pagination__item.-next a")
        if not next_btn:
            break

        start += 12
        time.sleep(2)

    return results


if __name__ == "__main__":
    data = scrape_individual_tests()

    # Save JSON
    with open("shl_individual_assignments.json", "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    # Save CSV
    df = pd.DataFrame(data)
    df["testTypes"] = df["testTypes"].apply(lambda x: ",".join(x))
    df.to_csv("shl_individual_assignments.csv", index=False)

    print(f"Saved {len(data)} records to CSV and JSON")
