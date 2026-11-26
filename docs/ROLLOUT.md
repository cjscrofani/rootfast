# ⚠️ Pending rollout — do this before any other work

**Status as of 2026-11-25.** The repo (branch `feat/d1-summaries`) is ahead of
production and **nothing is committed yet**. Production is on schema 005 with
the Worker deployed on 2026-08-04. The Worker code in this branch depends on
database changes that have not been applied, and the website reads its
headline numbers from the live API, so the steps below must run in order.

What is in the working tree:

- ZIP endpoints (`/v1/zip/{zip}`, `/v1/zip/{zip}/plants`), migration 007
  (`zip_counties`), the `sources/census-zcta/` ETL, `photo_license` /
  `has_photo` filters, richer `/healthz`, `api/scripts/populate_meta.sql`,
  web pages reading numbers from `/healthz`, nativity + stability + licensing
  docs, `CHANGELOG.md`.
- **D1 cost guards (added 2026-11-25).** Production was reading about 86
  billion D1 rows per billing cycle, almost all of it crawler traffic
  re-running unindexed aggregations. Added: migration 008 (summary tables,
  usage ledger, response store), `api/src/guard.ts` (cache keys, row metering,
  daily row budget), real caching in the Worker and the site, tighter rate
  limits, a 10,000-row export cap, and `web/wrangler.toml` (service binding
  from the site to the API). See "Cost guards" in `api/README.md`.

Tested locally: Vitest 95/95, pytest 52/52, `tsc` and `astro check` clean, old
and new queries return identical results on the full dataset, and the Worker
and site were run locally end to end.

## Before you start

- **Plan.** The account currently has the Workers **Paid** plan's allowances
  (and is billed $0 for reasons the dashboard does not explain). Step 1 needs
  them: `populate_summaries.sql` writes about 2.9 million rows and reads well
  over 10 million, against Workers Free limits of 100,000 written and
  5,000,000 read per day. **Do not downgrade to Free before step 1 is done.**
  On Free, a dataset refresh cannot run as built either.
- **What this rollout does not fix.** The guards cap D1 rows read. They do
  not cap requests (100,000 a day on Free, shared by the API and the site's
  Functions) or CPU (10 ms per request on Free; an uncached page render takes
  10–15 ms). About 79% of page requests are unverified clients spread over
  many addresses, which per-IP limits and `robots.txt` do not touch. Only a
  rule on the Cloudflare zone stops a request before it counts — step 4.
- **When the budget trips** (4,000,000 rows in a UTC day), cached answers and
  pages keep working and everything else returns 503 / "temporarily
  unavailable" until 00:00 UTC. That is the guard working, not an outage.
  Expect it on heavy crawl days until step 4 is in place.

## 0. Commit the working tree

```bash
git status
rm "web/public/_headers 2"                  # byte-identical stray duplicate
git add -A
git commit -m "Feature: ZIP-to-plants endpoints, /healthz provenance, D1 cost guards"
```

## 1. Production D1 (from `api/`)

The three schema files run **once each** (a second run fails on the first
statement: `duplicate column name` / `table already exists`; to see whether
008 is applied, `PRAGMA table_info(county_taxa_summary)` lists
`accepted_count`). The data and populate steps are idempotent. A failed
`--file` execution leaves the database as it was.

The currently deployed Worker keeps working on the new schema: 006–008 only
add tables and columns, and the two indexes 008 drops are prefixes of indexes
that remain. But **while a `--file` import runs, the database does not serve
queries**, so the live API and site return errors for the duration — a few
seconds for the schema files, possibly minutes for the populate. Pick a quiet
hour.

```bash
cd api
# schema: 006 summaries, 007 ZIP crosswalk, 008 read-cost summaries + ledger
npx wrangler d1 execute rootfast --remote --file=schema/006_summaries.sql --yes
npx wrangler d1 execute rootfast --remote --file=schema/007_zip_counties.sql --yes
npx wrangler d1 execute rootfast --remote --file=schema/008_read_cost.sql --yes

# data: ZIP crosswalk (~1 MB, already reconciled against counties), then every
# derived table for 006 + 008, one state at a time (~2.9M rows written)
npx wrangler d1 execute rootfast --remote --file=processed/rootfast_zip_counties.sql --yes
npx wrangler d1 execute rootfast --remote --file=scripts/populate_summaries.sql --yes

# provenance + counts for /healthz
npx wrangler d1 execute rootfast --remote --file=scripts/populate_meta.sql --yes
npx wrangler d1 execute rootfast --remote --yes --command \
  "INSERT INTO schema_meta (key,value,updated_at) VALUES ('dataset_version','2026.05',datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
```

The populate has only ever been run on local SQLite (about 10 seconds). If D1
rejects a statement for size or time, nothing is half-applied; say so and
split further before retrying.

If `processed/rootfast_zip_counties.sql` is missing (it is gitignored), regenerate
it: `cd sources/census-zcta/etl && python3 scripts/fetch_zcta_counties.py && python3 scripts/build_sqlite.py`,
then run the small generator at the bottom of this file.

**Verify before moving on — do not deploy the Worker until these match.** With
empty summary tables the new Worker answers `200` with zero rows, and those
answers would be cached.

```bash
npx wrangler d1 execute rootfast --remote --yes --command "SELECT key, value FROM schema_meta WHERE key IN ('schema_version','dataset_version','count_taxa','count_zip_counties') ORDER BY key"
# expect count_taxa 27678 · count_zip_counties 33478 · dataset_version 2026.05 · schema_version 008
npx wrangler d1 execute rootfast --remote --yes --command "SELECT (SELECT COUNT(*) FROM county_plants) cp, (SELECT COUNT(*) FROM plant_county_distribution) pcd, (SELECT COUNT(*) FROM state_plants) sp, (SELECT COUNT(*) FROM state_taxa_summary) st, (SELECT COUNT(*) FROM plant_range_summary) pr, (SELECT SUM(accepted_count) FROM county_taxa_summary) acc, (SELECT COUNT(*) FROM usage_daily) ledger, (SELECT COUNT(*) FROM response_cache) store"
# expect cp = pcd = acc = 2501631 · sp 176781 · st 55 · pr 27678 · ledger 0 · store 0
npx wrangler d1 info rootfast          # database_size should stay well under 500 MB
```

## 2. Deploy the Worker

```bash
cd api && npx wrangler deploy
curl -s https://api.rootfast.org/healthz | jq .            # dataset_version 2026.05, schema 008, counts populated, usage present
curl -s https://api.rootfast.org/v1/zip/59715 | jq .counties
curl -s 'https://api.rootfast.org/v1/zip/59715/plants?nativity=Native&growth_habit=Tree&limit=3' | jq .counts
curl -s https://api.rootfast.org/v1/states/MT | jq .       # county_count 56, taxa_count 3215
curl -s 'https://api.rootfast.org/v1/counties/30031/plants?limit=1' | jq .total   # 1362

# cost guards: a repeat request is served from cache (repeat once more if the
# second still says miss — the cache write happens after the first response)
curl -sD- -o /dev/null https://api.rootfast.org/v1/states/MT/counties | grep -i x-rootfast-cache   # miss
curl -sD- -o /dev/null https://api.rootfast.org/v1/states/MT/counties | grep -i x-rootfast-cache   # edge
curl -sD- -o /dev/null 'https://api.rootfast.org/v1/plants?format=csv' | grep -i 'x-total-count\|^link'
```

Then watch rows read for a day (`npx wrangler d1 info rootfast`, the D1
dashboard, or `usage` in `/healthz`) and
`npx wrangler d1 insights rootfast --sort-by reads --sort-type sum --timePeriod 1d`
for whatever still costs the most. `DAILY_ROWS_BUDGET` in `api/wrangler.toml`
is the dial.

## 3. Merge, which deploys the website

The Pages project builds production from `main`. Deploying `dist` from this
branch with `wrangler pages deploy` would publish a **preview**, not
rootfast.org. The home/about/docs pages are prerendered and read `/healthz`
at build time, so the build must happen after step 2.

`web/wrangler.toml` is new and becomes the source of truth for the Pages
project's bindings and compatibility settings. The live project was checked
on 2026-11-25 (`npx wrangler pages download config rootfast-web`): it has no
variables, bindings or compatibility flags and the same compatibility date,
so nothing is lost. Re-check if anything was added in the dashboard since.

```bash
git push -u origin feat/d1-summaries
gh pr create --fill          # then merge it; Pages builds and deploys main
```

After the production deployment finishes:

- Footer on `https://rootfast.org` reads `dataset 2026.05 · USDA pull 2026-05-26 · schema 008`.
- Pages dashboard → rootfast-web → Settings → Bindings lists the service
  binding `API → rootfast-api`.
- `curl -sI https://rootfast-web.pages.dev/plants/PIPO` answers `301` to
  `https://rootfast.org/plants/PIPO`. (Only server-rendered pages redirect;
  `/`, `/about`, `/docs` are prerendered and rely on their canonical tag.)
- Load a county page twice; `usage.rows_read` in `/healthz` should not move
  on the second view.

Then delete this file (or move the checklist into CHANGELOG) and drop the
"pending rollout" block from `CLAUDE.md`.

## 4. Zone rules for crawlers — NOT YET CONFIGURED

Nothing in the repo stops a request before it reaches the site or the API.
These are set in the Cloudflare dashboard (rootfast.org → Security → WAF) and
are the only controls that reduce request count and CPU. All are on the free
zone plan. They are scoped to the website host so scripts calling
`api.rootfast.org` are untouched. Decide before enabling: challenged clients
that cannot run JavaScript (curl, link previews, small crawlers, uptime
monitors) will not get pages from rootfast.org.

1. Custom rule, **Managed Challenge** — parameter URLs from unverified clients:
   `(http.host in {"rootfast.org" "www.rootfast.org"} and not cf.client.bot and http.request.uri.query ne "")`
2. Custom rule, **Block** — crawlers that bring no visitors:
   `(http.user_agent contains "SemrushBot") or (http.user_agent contains "AhrefsBot") or (http.user_agent contains "MJ12bot") or (http.user_agent contains "DotBot") or (http.user_agent contains "PetalBot") or (http.user_agent contains "Bytespider") or (http.user_agent contains "Reflectionbot") or (http.user_agent contains "Amazonbot") or (http.user_agent contains "meta-externalagent") or (http.user_agent contains "GPTBot") or (http.user_agent contains "CCBot")`
3. The one free **rate-limiting rule** — per IP, 10-second window; set the
   threshold above the API's own 60 per minute if the rule cannot be limited
   to the website host.
4. If rule 1 is not enough, widen it to every server-rendered path for
   unverified clients outside North America.

Do **not** enable Bot Fight Mode: it applies to the whole zone, cannot be
scoped, and would challenge scripts using the public API.

After enabling, check Security → Events to confirm requests are stopped
before the Function runs, and watch `usage` in `/healthz`.

## 5. Publish the first dataset snapshot (unblocks "what if this disappears?")

The 503 message, `robots.txt` and the docs all point people to the Releases
page, which is empty until this runs. The release workflow has never run: the
`CLOUDFLARE_API_TOKEN` repo secret does not exist (`gh secret list` is
empty). Create a token with D1 read, then:

```bash
gh secret set CLOUDFLARE_API_TOKEN          # paste token
git tag data-v2026.05 && git push origin data-v2026.05
gh run watch                                # publishes rootfast.sqlite.gz + parquet + manifest
```

The export reads the whole database once and is not counted by the API's
budget; run it early in the UTC day.

## Rollback

No schema down-migration is needed: the previous Worker runs correctly on the
new schema.

- **Worker:** `cd api && npx wrangler rollback` returns to the previous
  version. To keep the new code but switch the budget off, set
  `DAILY_ROWS_BUDGET = "0"` in `api/wrangler.toml` and redeploy.
- **Website:** Pages dashboard → rootfast-web → Deployments → roll back to
  the previous production deployment. The page cache is keyed by build, so
  old and new pages never mix.
- **Wrong answers cached** (for example the Worker was deployed before the
  populate finished): bump `CACHE_EPOCH` in `api/src/index.ts`, redeploy, and
  run `DELETE FROM response_cache` on D1.
- **Zone rules:** disable them in the dashboard; they take effect at once.

## After any later data reload

Re-run `populate_summaries.sql`, then bump `DATASET_VERSION` in
`api/wrangler.toml` and redeploy (see "Applying migrations" in
`api/README.md`).

## Deferred (your call, not blockers)

- Client wrappers (PyPI / npm), API directory + Zenodo/HF listings, forum posts.
- Public uptime page.
- Review the refresh-cadence promise on the about page ("at least twice a year").

---

### Regenerating `api/processed/rootfast_zip_counties.sql`

```bash
python3 - <<'PY'
import sqlite3, sys
sys.path.insert(0, "api/scripts"); import build as b
db = sqlite3.connect(":memory:"); db.isolation_level = None
db.execute("PRAGMA foreign_keys = OFF")
for m in sorted(b.SCHEMA_DIR.glob("*.sql")): db.executescript(m.read_text())
db.execute("ATTACH 'api/processed/rootfast.db' AS ref"); db.execute("INSERT INTO counties SELECT * FROM ref.counties"); db.execute("DETACH ref")
db.execute("ATTACH 'sources/census-zcta/etl/processed/zcta.db' AS src"); db.execute("INSERT OR IGNORE INTO zip_counties SELECT * FROM src.zip_counties"); db.execute("DETACH src")
b.reconcile_zip_counties(db)
rows = db.execute("SELECT zip_code, county_fips, land_share FROM zip_counties ORDER BY 1, 3 DESC").fetchall()
with open("api/processed/rootfast_zip_counties.sql", "w") as f:
    f.write("-- zip_counties data for D1 (migration 007). INSERT OR IGNORE so re-runs are safe.\n")
    for i in range(0, len(rows), 500):
        f.write("INSERT OR IGNORE INTO zip_counties (zip_code, county_fips, land_share) VALUES " + ",".join(f"('{z}','{c}',{s})" for z, c, s in rows[i:i+500]) + ";\n")
print(len(rows), "rows")
PY
```
