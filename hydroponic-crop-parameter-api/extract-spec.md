# `extract.py` — Pipeline Specification

The extraction pipeline that converts source PDFs into draft YAML entries for the Hydroponic Crop Parameter dataset. Companion to `dev.md`.

## Design goals

1. **Deterministic** — same source PDF + same pipeline version → same draft output. Replay must be possible.
2. **Auditable** — every run produces a full transcript (prompt + response + validation results) alongside the YAML draft.
3. **Anti-hallucination by construction** — the LLM cannot emit a numeric value without a verbatim source quote that survives post-call fuzzy-match against the extracted PDF text.
4. **Schema-enforced output** — Claude's tool-use feature is the output channel. The model cannot emit malformed YAML because it cannot emit YAML at all — it can only call typed tools.
5. **Drafts only, never direct writes** — output lands in `data/proposed/`. Humans move it to `data/crops/` via PR.

## CLI shape

```bash
# Single PDF, single crop
tools/extract.py --source cornell-cea-lettuce-2017 --pdf sources/raw/cornell-lettuce.pdf --crop lettuce-romaine

# Single PDF, multi-crop (script attempts crop boundary detection)
tools/extract.py --source cornell-cea-leafygreens-2020 --pdf sources/raw/cornell-leafygreens.pdf --multi-crop

# Bulk fetch + extract from a known source pattern (e-GRO has predictable URLs)
tools/extract.py --bulk egro --year-range 2018-2025 --crop-filter edibles

# Dry-run: print draft, do not write
tools/extract.py --source ohio-state-tomato-2019 --pdf sources/raw/ohio-tomato.pdf --crop tomato-beefsteak --dry-run

# Replay a previous run from its transcript (cached: re-run validator + writer only)
tools/extract.py --replay data/proposed/cornell-cea-lettuce-2017/lettuce-romaine.transcript.json

# Replay with actual API re-invocation (for testing prompt changes; writes a new timestamped transcript)
tools/extract.py --replay data/proposed/cornell-cea-lettuce-2017/lettuce-romaine.transcript.json --re-call
```

## Pipeline stages

```
1. Resolve source
   ├─ Verify source-id exists in data/sources/{id}.yaml
   └─ Load source metadata into context

2. Ingest PDF
   ├─ PyMuPDF (fitz): text + page numbers + bookmarks
   ├─ pdfplumber: table detection on pages flagged by step 1
   ├─ Camelot fallback: for pages where pdfplumber misses table structure
   └─ Output: structured document object {pages: [{n, text, tables}]}

3. Build LLM context
   ├─ System prompt (extraction discipline + refusal contract)
   ├─ Schema reference (which fields, units, allowed enums)
   ├─ Source metadata block (incl. page_offset for printed↔physical translation)
   ├─ Document text, page-numbered by PRINTED page (with physical page in a sidecar map for the validator)
   ├─ Tables rendered as markdown AND raw page text retained alongside (lets the LLM cross-verify pdfplumber misparses)
   └─ Target crop slug (or "auto-detect crops" for --multi-crop)

4. Call Claude API
   ├─ Model: claude-opus-4-7 (default; calibration test on day 1 of Phase 2 against Sonnet 4.6 — see Resolved decisions)
   ├─ Tool use: submit_crop_data | flag_ambiguity | note_disagreement
   ├─ Tool choice: "any" (model must call exactly one terminal tool per crop)
   └─ Capture: full request + response in memory for transcript (incl. pipeline version + prompt hash + model ID)

5. Validate tool call payload
   ├─ JSON Schema validation against crop.schema.json
   ├─ For each measurement: fuzzy-match `quote` against page text
   │   ├─ Threshold: 90% token overlap on a normalized window
   │   └─ Mismatch → reject measurement, log to validation_errors
   ├─ Verify page numbers exist in PDF
   ├─ Verify source_id matches the --source argument
   └─ Verify confidence ratings present and valid

6. Write artifacts
   ├─ data/proposed/{source-id}/{crop}.yaml          (the draft)
   ├─ data/proposed/{source-id}/{crop}.transcript.json (full audit trail)
   ├─ data/proposed/{source-id}/{crop}.evidence.md    (human-review sheet)
   └─ data/proposed/{source-id}/{crop}.validation.json (any errors/warnings)

7. Emit summary to stdout
   ├─ Counts: measurements emitted, ambiguities flagged, validation errors
   └─ Next action: "open PR" or "fix prompt/source and replay"
```

## Tool-use schema (the output contract)

Three terminal tools. The model must call exactly one `submit_crop_data` per crop, plus zero-or-more `flag_ambiguity` / `note_disagreement` calls.

### `submit_crop_data`

```json
{
  "name": "submit_crop_data",
  "description": "Submit a structured crop parameter entry. Every numeric value MUST include a verbatim quote from the source document and the page number it appears on. If a value is not directly supported by a quote, omit it (use null) and call flag_ambiguity instead.",
  "input_schema": {
    "type": "object",
    "required": ["crop_slug", "common_name", "scientific_name", "source_id", "stages"],
    "properties": {
      "crop_slug": { "type": "string", "pattern": "^[a-z0-9-]+$" },
      "common_name": { "type": "string" },
      "scientific_name": { "type": "string" },
      "cultivar_group": { "type": ["string", "null"], "description": "e.g. 'romaine', 'butterhead'. Null if source does not specify." },
      "cultivars_mentioned": { "type": "array", "items": { "type": "string" } },
      "source_id": { "type": "string", "description": "Must match the --source argument." },
      "stages": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["stage", "parameters"],
          "properties": {
            "stage": { "type": "string", "enum": ["seedling","transplant","vegetative","heading","flowering","fruiting","harvest","microgreen-germination","microgreen-true-leaf"] },
            "duration_days": { "type": ["array","null"], "items": { "type": "integer" }, "minItems": 2, "maxItems": 2 },
            "parameters": {
              "type": "object",
              "properties": {
                "ec_ms_cm":    { "$ref": "#/$defs/measurement" },
                "ph":          { "$ref": "#/$defs/measurement" },
                "ppfd_umol":   { "$ref": "#/$defs/measurement" },
                "dli_mol":     { "$ref": "#/$defs/measurement" },
                "temp_day_c":  { "$ref": "#/$defs/measurement" },
                "temp_night_c":{ "$ref": "#/$defs/measurement" },
                "rootzone_c":  { "$ref": "#/$defs/measurement" },
                "photoperiod_h": { "$ref": "#/$defs/measurement" },
                "vpd_kpa":     { "$ref": "#/$defs/measurement" },
                "rh_pct":      { "$ref": "#/$defs/measurement" }
              }
            },
            "failure_modes": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["mode", "quote", "page"],
                "properties": {
                  "mode": { "type": "string" },
                  "trigger": { "type": ["string","null"] },
                  "quote": { "type": "string" },
                  "page": { "type": "integer" }
                }
              }
            }
          }
        }
      }
    },
    "$defs": {
      "measurement": {
        "type": ["object","null"],
        "description": "A single measurement. Null if the source does not specify this parameter for this stage.",
        "required": ["value", "unit", "quote", "page", "confidence"],
        "properties": {
          "value": {
            "oneOf": [
              { "type": "number" },
              { "type": "array", "items": { "type": "number" }, "minItems": 2, "maxItems": 2, "description": "Range [low, high]" }
            ]
          },
          "unit": { "type": "string", "description": "Original source unit. Conversions happen downstream, not here." },
          "quote": { "type": "string", "description": "Verbatim text from the source supporting this value. Must appear in the PDF text on the cited page." },
          "page": { "type": "integer", "minimum": 1 },
          "confidence": { "type": "string", "enum": ["high","medium","low"] },
          "notes": { "type": ["string","null"] }
        }
      }
    }
  }
}
```

### `flag_ambiguity`

```json
{
  "name": "flag_ambiguity",
  "description": "Call this when you find a parameter mentioned in the source but cannot extract a clean value (ambiguous wording, conflicting numbers within the same source, missing units, etc.). The human reviewer will resolve.",
  "input_schema": {
    "type": "object",
    "required": ["field", "stage", "reason", "quoted_context", "page"],
    "properties": {
      "field": { "type": "string", "description": "e.g. 'ec_ms_cm', 'ph', 'failure_modes'" },
      "stage": { "type": ["string","null"] },
      "reason": { "type": "string" },
      "quoted_context": { "type": "string" },
      "page": { "type": "integer" }
    }
  }
}
```

### `note_disagreement`

```json
{
  "name": "note_disagreement",
  "description": "Call this when the source contradicts itself (e.g. one table says EC 1.2, narrative on the next page says EC 1.6 for the same crop and stage). Do NOT pick one — record both for the reviewer.",
  "input_schema": {
    "type": "object",
    "required": ["parameter", "stage", "values_observed"],
    "properties": {
      "parameter": { "type": "string" },
      "stage": { "type": "string" },
      "values_observed": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["value", "unit", "quote", "page"],
          "properties": {
            "value": {},
            "unit": { "type": "string" },
            "quote": { "type": "string" },
            "page": { "type": "integer" }
          }
        },
        "minItems": 2
      }
    }
  }
}
```

## System prompt (draft)

```
You are an expert horticultural data extractor. Your job is to read a single document
from a published source on hydroponic crop production and convert its quantitative
recommendations into a structured record by calling the provided tools.

You will be given:
- Source metadata (publication, authors, year, URL)
- The full text of the document, page-numbered
- The crop slug you are extracting for (or instructions to detect multiple crops)
- The schema of allowed parameters and stages

## Extraction discipline — these rules are non-negotiable

1. **Verbatim quotes are mandatory.** Every numeric value you submit must include a
   verbatim quote (a continuous span of text copied exactly from the source) that
   supports it, plus the page number where the quote appears. The quote must contain
   the number — paraphrases are forbidden.

2. **Null is the correct answer for missing data.** If the source does not specify a
   parameter for a stage, submit null for that field. Do not estimate, infer from
   related crops, or carry forward from another stage.

3. **Preserve original units.** If the source gives EC in mS/cm, submit "mS/cm". If
   it gives EC in µS/cm, submit "µS/cm". Unit conversion happens downstream. This
   keeps the audit trail honest.

4. **Stage assignment must be supported by the source.** If a value is given for "week
   3 of production," map it to the schema stage only if the source itself labels the
   stage (vegetative, heading, etc.) or the stage is unambiguous from context. If
   uncertain, call flag_ambiguity.

5. **Cultivar specificity matters.** If the source's data is for a specific cultivar
   group (e.g. "romaine lettuce"), set cultivar_group accordingly. If the source is
   silent on cultivar, set it to null — do not assume.

6. **Confidence ratings:**
   - "high": the source is a peer-reviewed publication or a university handbook
     with primary measurements, AND the value is presented unambiguously (clean
     table, explicit recommendation).
   - "medium": the source is an extension fact sheet or a reputable vendor schedule,
     OR the value is in a peer-reviewed source but presented in narrative with some
     ambiguity.
   - "low": the value is in a secondary aggregation, a blog, or an undated source,
     OR there is internal ambiguity (e.g. the source gives a range but the range is
     unusually wide or the context is unclear).

7. **In-source disagreement → note_disagreement, NOT a guess.** If the same source
   gives two different values for the same parameter and stage, call note_disagreement.
   Do not pick the "more reasonable" one.

8. **You may call multiple tools per turn.** Typical pattern: one submit_crop_data
   for the main extraction, plus zero-or-more flag_ambiguity and note_disagreement
   calls for the leftover edge cases. Do not split a single crop's data across
   multiple submit_crop_data calls.

## Refusal contract

If you cannot find verbatim evidence for a value, you MUST return null for that
field. Do not invent quotes. Do not paraphrase numbers from neighboring context.
A null field is a successful outcome; a fabricated quote is a project-ending failure.
```

## Validation step (post-call, the real anti-hallucination layer)

The prompt asks for honesty. The validator enforces it.

For each measurement in the submitted payload:

1. **Quote presence check.** Normalize the quote (lowercase, collapse whitespace, strip punctuation). Normalize the PDF text on the cited page the same way. Check that the normalized quote appears as a substring, or has ≥90% token-set overlap on a sliding window. If neither: reject the measurement, log to `validation.json`, do not write the value to the YAML.

2. **Page sanity check.** Cited page is the PRINTED page number. Validator translates to physical using `source.page_offset` (or per-section offsets for irregularly paginated PDFs), then verifies the translated index is in `[1, total_pages]`. Allow ±1 for tables that span pages.

3. **Value-in-quote check.** The numeric value (formatted both as integer and with one decimal) must appear in the quote string. This catches cases where the LLM lifts a real quote but inserts a wrong number.

4. **Unit sanity.** Unit string must be on a recognized list (or in a `pending_review` set). Unknown units flag the entry but don't reject it (the reviewer decides).

5. **Range ordering.** For range values `[low, high]`, low ≤ high. Reject if not.

Validator output is a structured `validation.json` consumed by:
- The CLI (exit code nonzero if errors > 0)
- The PR template (reviewer sees a checklist of what passed/failed)
- The `evidence.md` file (renders failures inline next to the YAML they came from)

## Artifacts per run

```
data/proposed/{source-id}/
  {crop-slug}.yaml                          # the draft, ready for human review
  {crop-slug}.transcript.json               # latest Claude API request + response
  {crop-slug}.transcript-{ISO8601}.json     # historical re-call transcripts (--re-call writes a new one, never overwrites)
  {crop-slug}.evidence.md                   # human-readable review sheet (see below)
  {crop-slug}.validation.json               # validator output, structured
```

Every transcript embeds: `pipeline_version`, `prompt_hash`, `model_id`, `timestamp`, `source_id`, full request, full response. This is what makes "deterministic replay" actually deterministic — when the validator changes, we can re-run it against the exact response that produced the original YAML.

The `evidence.md` is the artifact a reviewer actually opens. It looks like:

```markdown
# Review: lettuce-romaine from cornell-cea-lettuce-2017

Status: ⚠️  2 validation warnings, 0 errors

## seedling stage

### ec_ms_cm: [0.8, 1.2] mS/cm ✓
> "Seedling EC should be maintained between 0.8 and 1.2 mS/cm during the first 14 days
> after sowing." — page 14, confidence: high

### ph: [5.5, 6.0] ✓
> "Target pH for seedlings is 5.5 to 6.0." — page 14, confidence: high

### temp_day_c: NULL ⚠ flagged
Reason: "Source gives 'cool conditions preferred' without numeric range" — page 13

...
```

## Cost & runtime notes

- ~15-page Cornell handbook: one Claude call, ~3K input tokens + ~1.5K output
  - Sonnet 4.6: ~$0.03 per crop
  - Opus 4.7: ~$0.15 per crop
- e-GRO alert (3–6 pages):
  - Sonnet 4.6: ~$0.01 per call; 200 alerts ≈ $2 total
  - Opus 4.7: ~$0.05 per call; 200 alerts ≈ $10 total
- Full v1 extraction budget:
  - Sonnet 4.6: **under $25**
  - Opus 4.7: **under $100**
- Runtime: 5–15 seconds per document (Sonnet); 10–25 seconds (Opus). Parallelize across sources, not across crops within a source.

## Out of scope for v1 of the pipeline

- OCR for image-only PDFs. Defer; flag and skip.
- Multi-language sources (WUR Dutch reports). Defer; English-only v1.
- Live web scraping of HTML sources (Texas A&M Aggie Hort). Manual save-as-PDF for v1.
- Automatic source registration. Source YAMLs are written by hand in v1; the pipeline only consumes them.

## Resolved decisions

### Model: Opus 4.7 default, with mandatory day-1 calibration test

Opus 4.7 (`claude-opus-4-7`) is the default extraction model. The project's trust model depends on the extractor refusing to fabricate quotes and reliably following the 8-rule extraction discipline under pressure — exactly where Opus has a meaningful edge over Sonnet, and where smaller models degrade silently. Cost difference (~$75 vs ~$15 for the full v1 corpus) is not a tiebreaker at this scale.

**Day-1 calibration test (Phase 2 task before any bulk ingestion):**

Process three documents through both Opus 4.7 and Sonnet 4.6, diff outputs, decide:

| Difficulty | Document | What we're testing |
|---|---|---|
| Easy   | Cornell lettuce handbook, single clean parameter table | Baseline extraction accuracy |
| Medium | An e-GRO alert with prose-embedded numbers and unit ambiguity | Honest refusal + ambiguity flagging |
| Hard   | A journal methods section with multiple cultivars + overlapping stage labels | Cultivar specificity + stage mapping |

If outputs are indistinguishable, downgrade to Sonnet permanently. If Opus catches things Sonnet misses, lock in Opus. Document the diff in `tools/calibration/` for posterity. **Do not consider Haiku** — extraction discipline is exactly where small models fail in ways that are dangerous because they're silent.

### Page numbering: printed pages in the dataset, `page_offset` in source YAML

Citations in the public dataset use **printed page numbers** (what a reader sees on the page, what academic citation norms use). Each source YAML carries a `page_offset` field; the validator translates printed → physical internally for text lookup.

```yaml
# data/sources/cornell-cea-lettuce-2017.yaml
id: cornell-cea-lettuce-2017
page_offset: 4   # physical = printed + 4
```

For PDFs with inconsistent paging (Roman numerals → Arabic, multi-section reprints), set `page_numbering: physical` on the source and cite physical pages directly, with a comment in the source YAML explaining why.

The LLM is instructed to cite the printed page number it sees on the page (matches what the source itself uses). Translation is the validator's job, not the model's.

### Tables: markdown rendering + raw page text retained alongside

Tables detected by pdfplumber are rendered as markdown in the prompt (LLM-native format, structure-preserving, debuggable). The raw page text is retained in the prompt as well, so the model can cross-verify against pdfplumber misparses (split ranges, collapsed multi-line headers, mis-aligned columns).

Example prompt fragment:

```
=== Page 14 (printed) ===
[raw text from page 14]

Tables detected on page 14:

Table 1:
| Stage | EC (mS/cm) | pH | Photoperiod (h) |
|-------|------------|-----|-----------------|
| Seedling | 0.8–1.2 | 5.5–6.0 | 18 |
| Vegetative | 1.2–1.6 | 5.5–6.0 | 18 |
```

Token cost of the duplication is negligible at v1 scale and worth the cross-verification.

### Replay: cached by default, `--re-call` for re-invocation, never overwrite history

`--replay` re-runs the validator and writer against the cached response in the existing transcript. Deterministic, free, fast. This is the common case (validator changes, schema migrations, evidence.md template changes).

`--replay --re-call` actually re-invokes the Claude API. Writes a new transcript with an ISO8601 timestamp suffix; never overwrites the prior transcript. The `.transcript.json` symlink (or "latest" pointer) updates to the newest call; historical transcripts remain on disk so we can diff prompt-iteration behavior over time.

Every transcript embeds `pipeline_version`, `prompt_hash`, `model_id`, `timestamp`, and `source_id`. When any of those change between runs, a `--replay` will warn loudly that the cached response was produced by a different pipeline version.
