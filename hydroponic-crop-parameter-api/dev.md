# Hydroponic Crop Parameter API — Construction Plan

## Framing

This is a **data project that exposes an API**, not an API project with data. Source of truth = YAML files in git, reviewed by PR. The "API" is a thin read layer on top. The disagreement-preserving design call lives in the schema itself, not in app logic. Hosting stays near-free (CDN-served static JSON + a thin query layer), which matches the "free, public, niche infrastructure" tone of the pitch.

## Locked decisions

- **Distribution:** Static JSON over CDN + thin query API (Cloudflare Worker on top of compiled JSON)
- **Ingestion:** LLM-assisted extraction from PDFs with mandatory human review via PR
- **Pipeline:** Script-led Python pipeline with Claude API as the extraction engine (deterministic, replayable, audit-friendly). Autonomous agents reserved for source discovery, disagreement triage, and schema migrations only. See **Data pipeline** section below.
- **v1 scope:** Full 40 crops, released in tranches (see Source landscape — leafy greens + herbs first, fruiting next, microgreens/brassicas last)

## Source landscape (pre-Phase 1 survey)

**Premise confirmed.** No one has built a citation-backed open hydroponic parameter dataset at this scope. Closest prior art is `being-invincible/hydroponics-grow-guide-dataset` — single-source (zipgrow.com), uncited. OpenFarm shut down April 2025. MIT OpenAg is salvage-grade. The gap is real.

### Top 9 sources to start extracting from, ranked

1. **Cornell CEA handbooks** — lettuce, spinach, leafy greens, basil. Gold standard. Free PDFs, table-rich. https://cea.cals.cornell.edu/crops/
2. **e-GRO alert archive** — 13 years of free PDFs, edibles are a substantial subset. Predictable URL pattern (`pdf/YYYY-VOL-NN.pdf`) makes bulk fetch trivial. https://www.e-gro.org/alert-archive.php
3. **Jack's Nutrients edible crop schedules** — the only major vendor with comprehensive vegetable/herb feed charts (others are cannabis-only). https://www.jacksnutrients.com/ediblecrops-schedules
4. **UF/IFAS EDIS** — HS405, HS1422, HS1488. Strong Florida hydroponic coverage. https://edis.ifas.ufl.edu
5. **Ohio State CFAES tomato fact sheet** — best primary source for fruiting tomato stage parameters. https://cfaes.osu.edu/fact-sheet/hydroponic-nutrient-solution-optimized-greenhouse-tomato-production
6. **U Arizona CEAC** — limited public material; mostly journal citations. https://ceac.arizona.edu/resources/publications
7. **MDPI Horticulturae / Frontiers in Plant Science / HortScience** open-access papers — for crops where extension coverage is thin
8. **WUR Autonomous Greenhouse Challenge datasets** — real operating setpoints for cucumber/tomato/lettuce, structured, underused. https://www.wur.nl/en/research/plant/autonomous-greenhouse-challenge
9. **Texas A&M TAEX + Virginia Tech VCE SPES-465** — fills fruiting/vining gaps

### Coverage map

| Category | Free public source coverage |
|---|---|
| Leafy greens (lettuce, spinach, kale, chard, arugula, …) | **Excellent** — Cornell + e-GRO + UF saturate ~12 crops easily |
| Culinary herbs | **Good** — basil best, rarer herbs (oregano, thyme) thin |
| Fruiting (tomato, cucumber, pepper, strawberry) | **Good** — but requires merging Ohio State + Texas A&M + UF + WUR per crop |
| Microgreens | **Thin** — vendor charts silent, data lives in MDPI/HortScience papers |
| Brassicas, root crops | **Thin** — rarely grown hydroponically, sparse data |

### Dealbreakers and real constraints

- **No single source covers all 40 crops.** Schema must support multi-source merging per parameter (already designed for that — the disagreement array carries the weight).
- **U Arizona CEAC's good material is in paid workshops.** Public page is mostly a journal bibliography. Sub with Ohio State + WUR for fruiting tomato.
- **AHDB Horticulture is dead** (UK levy abolition, 2022).
- **Cannabis vendor charts are useless** for vegetables. Only Jack's spans both worlds.
- **Acta Horticulturae paywalls** will gate some good per-crop studies. Budget for selective article purchases or hunt preprints on ResearchGate.

### What this changes about the plan

1. **"Full 40 at v1" must be tranched.** Leafy greens + herbs (~20 crops) ship cleanly. Fruiting (~5) needs source-merging discipline. Microgreens (~10) and brassicas/roots (~5) require journal hunting that 3–5× the per-crop effort. Communicate this honestly — tranched release inside the 40-crop commitment beats pretending uniform quality.
2. **Cultivar specificity is bigger than originally scoped.** Cornell's lettuce data varies by cultivar (Parris Island vs. Jericho vs. butterhead types). Schema needs cultivar-group as a first-class field, not optional metadata.
3. **Stage taxonomy varies by crop family.** Vendor charts use veg/bloom. Cornell uses seedling/transplant/harvest. Fruiting crops need flowering/fruiting stages leafy greens don't have. Need a per-family stage vocabulary, not a single 4-stage list.
4. **WUR Autonomous Greenhouse Challenge datasets are a bonus discovery.** Structured operating setpoints (not academic prose) for cucumber/tomato/lettuce — likely the cleanest extraction target for fruiting crops.
5. **Bulk e-GRO ingestion is achievable.** Predictable URL pattern means we can script bulk fetch of the edible-tagged archive, then LLM-extract in batch. Probably the highest-volume extraction target.

## Architecture

- **Source of truth:** YAML files in git (`/data/crops/*.yaml`, `/data/sources/*.yaml`), schema-validated on every PR.
- **Build:** GitHub Action compiles YAML → versioned JSON in `/build`, deploys to Cloudflare Pages.
- **Query layer:** Cloudflare Worker reads the compiled JSON and exposes REST endpoints (free tier handles this trivially).
- **Extraction:** `/tools/extract.py` feeds a PDF + structured-extraction prompt to Claude, emits a draft YAML in `/data/proposed/` with **quoted evidence per datapoint**. Human moves to `/data/crops/` via PR.

Cloudflare over Vercel because the project's ethos is "quiet public infrastructure" — CF's free tier is generous and durable for read-heavy static workloads.

## Repo layout

```
/data
  /crops/{slug}.yaml          # one file per crop, all stages
  /sources/{id}.yaml          # source registry, keyed by stable ID
/schema
  crop.schema.json
  source.schema.json
/tools
  extract.py                  # LLM-assisted PDF → draft YAML
  validate.py                 # JSON Schema validator (CI gate)
  compile.py                  # YAML → JSON build
/build                        # compiled output, gitignored
/api                          # Cloudflare Worker source
/docs                         # docs site (Astro Starlight)
/.github/workflows
```

## Schema sketch — the disagreement model

This is the part that matters most. Every numeric parameter is an **array of measurements**, not a single value. Each measurement carries its source. The API returns the array; the consumer picks.

```yaml
# data/crops/lettuce-romaine.yaml
slug: lettuce-romaine
common_name: Romaine lettuce
scientific_name: Lactuca sativa var. longifolia
cultivars: [Parris Island, Jericho]   # optional, but recommended

stages:
  - stage: seedling
    duration_days: [10, 14]
    parameters:
      ec_ms_cm:
        - { value: [0.8, 1.2], source: cornell-cea-lettuce-2017, page: 14, confidence: high }
        - { value: [1.0, 1.4], source: gh-feedchart-2023, page: null, confidence: medium }
      ph:
        - { value: [5.5, 6.0], source: cornell-cea-lettuce-2017, page: 14, confidence: high }
      # ... other params
    failure_modes:
      - { mode: tipburn, trigger: "EC > 1.8 + low transpiration", source: egro-lettuce-2021 }
```

Sources live in their own registry so they're cited by stable ID, not duplicated:

```yaml
# data/sources/cornell-cea-lettuce-2017.yaml
id: cornell-cea-lettuce-2017
title: "Cornell CEA Lettuce Handbook"
authors: [Mattson, N.]
year: 2017
type: university-handbook
url: https://...
retrieved: 2026-05-24
```

## Data pipeline

Not pure scripting (sources are too prose-heavy for regex/heuristics), and not an autonomous agent doing end-to-end work (autonomy fights the project's trust requirements). The right shape is a deterministic Python pipeline that calls Claude as the extractor at one specific stage.

```
fetch (script)
  → text/table extract (PyMuPDF + pdfplumber)
  → Claude API call w/ structured-extraction prompt + tool use
  → schema validate (script)
  → write data/proposed/{crop}.yaml + audit transcript
  → human review PR
  → merge to data/crops/
```

**Why script-led:**
- **Reproducibility** — same input → same draft. Re-running the pipeline on a source produces a deterministic artifact a contributor can audit and replay.
- **Trust over autonomy** — every datapoint needs verifiable provenance (URL, page, quote). An autonomous agent's exploration is harder to audit.
- **Prompt iteration speed** — the extraction prompt is the project's most valuable IP. Iterating it inside a deterministic pipeline is sharper than inside an agent loop.
- **Cost is irrelevant** — ~40 crops × ~3 sources × ~15 pages ≈ 1,800 pages ≈ $15–20 in Sonnet API costs for the whole v1 extraction. Not a tiebreaker.

**Where autonomous agents do earn keep (carved out as separate tools, not the main pipeline):**

1. **Source discovery** — "find open-access papers with hydroponic basil EC data from the last 10 years." Exploration task.
2. **Disagreement triage** — when two sources conflict, an agent cross-references cultivars, units, and growing systems, then writes a triage note for the human reviewer.
3. **Schema migrations** — when we revise the schema (we will, at least once), an agent re-processes existing entries.

**Hard requirements on the extractor (enforced via tool-use schema, not prompt wishes):**

- Every numeric value must be accompanied by a verbatim quote + page number from the source. No quote → tool call rejected.
- The model cannot emit free-form YAML — it can only call typed tools (`submit_crop_data`, `flag_ambiguity`, `note_disagreement`).
- Quotes are fuzzy-matched against extracted PDF text after the call; mismatches reject the entry.
- Missing data returns `null` with a reason. Estimation is forbidden.

Full pipeline + prompt design lives in `extract-spec.md` (drafted alongside this doc).

## API surface (v1)

- `GET /v1/crops` — list
- `GET /v1/crops/{slug}` — full crop, all stages
- `GET /v1/crops/{slug}/stages/{stage}` — one stage
- `GET /v1/sources` / `GET /v1/sources/{id}`
- `GET /v1/search?parameter=ec&stage=vegetative` — Worker earns its keep here
- OpenAPI spec published at `/v1/openapi.json`

## Construction phases

**Phase 1 — Foundation (week 1)**
Schema, validator, 2 hand-entered reference crops (lettuce-romaine, basil-genovese) to prove the schema handles disagreement, cultivar variance, and missing-data fields. Don't skip this — schema rework after 30 crops is brutal.

**Phase 2 — Extraction pipeline (week 1–2)**
Build `tools/extract.py` per `extract-spec.md`. Tool-use-enforced schema output, mandatory verbatim quote + page per numeric value, post-call fuzzy-match validation against source text, full transcript audit log per run. PR template forces reviewer to confirm quote ↔ claim. This is the trust system; build it before any bulk ingestion.

**Day-1 calibration test** (before any production extraction): process three representative documents (easy/medium/hard) through both Opus 4.7 and Sonnet 4.6; diff outputs; lock in the model that demonstrably refuses to fabricate. Default is Opus; downgrade to Sonnet only if outputs are indistinguishable.

**Phase 3 — Build + host (week 2)**
GitHub Action (validate → compile → deploy). Cloudflare Worker with the endpoints above. Docs site stub.

**Phase 4 — Bulk ingestion (weeks 2–N), tranched**
- **Tranche A — Leafy greens + herbs (~20 crops):** Cornell handbooks + bulk e-GRO extraction + Jack's cross-validation. This is the cleanest, fastest tranche; ships first.
- **Tranche B — Fruiting (~5 crops):** Ohio State + UF/IFAS + Texas A&M + WUR Autonomous Greenhouse Challenge. Requires per-crop source merging; slower per crop.
- **Tranche C — Microgreens + brassicas + roots (~15 crops):** journal hunting in MDPI Horticulturae / Frontiers / HortScience. Highest effort per datapoint; ships last.

**Phase 5 — Launch surface**
Docs, OpenAPI, three example consumers (Arduino, Python, "ask Claude" snippet). Soft-launch to r/hydro, ESPHome and Home Assistant communities, hydroponics academic Twitter.

## Three risks worth designing around now

1. **The volume is bigger than it looks.** 40 crops × 4 stages × ~8 parameters × ~2 sources each ≈ **2,500 datapoints** to extract and human-review. At 30 seconds per review that's ~20 hours of pure review time, plus extraction setup, plus disagreement triage. Realistic v1 timeline is 2–3 months of part-time work, not weeks. Worth deciding upfront whether to release in tranches (leafy greens first, fruiting later) even with "40 crops" as the stated v1 goal.

2. **Copyright on quoted evidence.** Facts (the numbers) aren't copyrightable in the US; verbatim quoted snippets from copyrighted PDFs are murkier. Safe play: store full quotes privately in `/data/evidence/` (gitignored or private repo), publish only `{source_id, page, paraphrase}` in the public dataset.

3. **Hallucinated numbers are an existential risk for this project.** One confidently-cited fake EC target undermines the entire "grounded data" pitch. The extraction prompt must refuse to emit a number without a verbatim snippet supporting it, and the PR template must force the reviewer to confirm the snippet says what the YAML claims. Build that discipline into the tooling, not into willpower.

## Open questions before Phase 1

- **Exact parameter list** — the project doc lists 8–9 core; lock the full set, including which are required vs. optional per crop family.
- **Cultivar handling** — survey resolved: cultivar-group must be a first-class field. Remaining decision: one YAML file per cultivar group (e.g. `lettuce-romaine.yaml`, `lettuce-butterhead.yaml`) vs. one file per crop with cultivar-group nested. Lean: one file per cultivar group — simpler queries, cleaner diffs, scales better.
- **Stage taxonomy** — survey resolved: needs to be per-family, not universal. Define stage vocabularies for: leafy greens, herbs, fruiting, microgreens, brassicas/roots. Each crop file declares which vocabulary it uses.
- **Confidence-rating rubric** — what makes a source "high" vs. "medium" vs. "low"? Draft rubric: high = peer-reviewed or university handbook with primary measurement; medium = extension fact sheet or reputable vendor schedule; low = secondary aggregation or undated vendor blog.
- **Tranche release commitment** — do we publish Tranche A as v1.0 with B and C following as v1.1 / v1.2, or hold the whole 40 until all tranches land? Lean: ship A as v1.0; honesty beats artificial completeness.
