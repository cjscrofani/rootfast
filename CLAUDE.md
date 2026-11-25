# rootfast — notes for Claude Code

## ⚠️ PENDING ROLLOUT — read `docs/ROLLOUT.md` before doing anything else

As of 2026-10-07 there is uncommitted, tested work on `feat/d1-summaries` that
production does not have yet (migrations 006–008, ZIP endpoints, /healthz
provenance, D1 cost guards, docs consistency pass). The order matters: commit → D1 → Worker →
web rebuild → first dataset release. `docs/ROLLOUT.md` has the exact commands
and verification steps. Start every session by checking whether it is done,
and remove this block once it is.

## Project shape

- `api/` Cloudflare Worker + D1 (`src/index.ts` routes, `src/openapi.ts` hand-kept spec, `schema/` migrations, `scripts/build.py` merge).
- `web/` Astro SSR on Cloudflare Pages. Home/about/docs are prerendered and read `/healthz` via `src/lib/stats.ts` — never hand-type dataset numbers into pages.
- `sources/*/etl/` one folder per upstream (USDA PLANTS, PHZM hardiness, SSURGO soil, Census ZCTA).
- Tests: `cd api && npm test` (Vitest), `python -m pytest tests/` (ETL; needs a venv with pytest — system python3 lacks it).

## Conventions

- Dataset versions are date-based (`YYYY.MM`) and match `data-v*` release tags; `/healthz` is the source of truth.
- `/v1` only gains fields. Breaking changes → `/v2`. Log API/schema/data changes in `CHANGELOG.md`.
- County `nativity` is USDA's own per-county flag; never derive it from regional `native_status`.
- When adding a migration, add it to `api/scripts/build.py` TABLE_ORDER and document the D1 apply step in `api/README.md`.
