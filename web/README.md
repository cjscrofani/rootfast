# web — Rootfast website

A digital herbarium for the Rootfast Plant API.

Astro 4 + Tailwind 3 + TypeScript strict, deployed to Cloudflare Pages.
Static-first with server-rendered detail pages that fetch from the live
Rootfast API.

## Pages

| Route | Purpose |
|---|---|
| `/` | Hero + status + search + 3 starter taxa |
| `/plants/[symbol]` | Full per-plant detail (identity, native status, characteristics, counties, photo, provenance) |
| `/counties/[fips]` | Plants in a county — filterable by nativity, sortable |
| `/[state_slug]` | State overview — counties, taxa summary |
| `/[state_slug]/[county_slug]` | Friendly URL alias for `/counties/[fips]` |
| `/states` | State/territory index with region, A–Z, taxa-count and coverage-status views |
| `/explore` and `/explore/[slug]` | Curated thematic lists (rarities, bloom time, height ranges, etc.) |
| `/search` | Live full-text search (FTS5 on the API) |
| `/docs` | API reference, runnable examples, license & attribution |
| `/about` | Project narrative + sources |

## Design system

`src/styles/global.css` defines the design tokens:

- **Palette** — warm aged paper `#FAF6EE`, iron-gall ink `#1A1815`, deep forest `#2D4F1E` for native, oxidized rust `#8A4527` for introduced
- **Type** — EB Garamond (serif, scientific names), Atkinson Hyperlegible (sans, UI), IBM Plex Mono (codes)
- **Rhythm** — hairline rules, small-caps section labels, lining figures, asterism (⁂) section breaks

Tailwind is configured with a custom palette (`paper`, `ink`, `native`, etc.) — see `tailwind.config.mjs`.

## Setup

```bash
cd web
npm install
npm run dev
```

By default the site fetches from `https://api.rootfast.org` (production).
To point at a local Worker:

```bash
PUBLIC_API_BASE_URL=http://localhost:8787 npm run dev
```

## Commands

```bash
npm run dev          # Astro dev server on http://localhost:4321
npm run typecheck    # Astro check, strict TS
npm run build        # build to ./dist
npm run preview      # preview the built site
```

## Deploy (Cloudflare Pages)

The `@astrojs/cloudflare` adapter is already wired up. To deploy:

```bash
# one-time, from the rootfast root:
npx wrangler pages project create rootfast-web --production-branch=main

# every time:
cd web
npm run build
npx wrangler pages deploy dist --project-name=rootfast-web
```

You'll want to set `PUBLIC_API_BASE_URL` in the Pages dashboard (or via
wrangler) if pointing at a non-default API.

## Project structure

```
web/
├── astro.config.mjs
├── tailwind.config.mjs
├── tsconfig.json
├── package.json
├── public/
│   └── favicon.svg
├── src/
│   ├── layouts/
│   │   └── BaseLayout.astro
│   ├── components/
│   │   ├── SiteHeader.astro
│   │   ├── SiteFooter.astro
│   │   ├── PlantNameBlock.astro
│   │   ├── CharacteristicsGrid.astro
│   │   └── SearchIsland.astro
│   ├── lib/
│   │   └── api.ts            ← typed API client
│   ├── pages/
│   │   ├── index.astro
│   │   ├── about.astro
│   │   ├── search.astro
│   │   ├── docs/index.astro
│   │   ├── plants/[symbol].astro
│   │   └── counties/[fips].astro
│   └── styles/
│       └── global.css        ← design tokens + base styles
└── README.md
```

## Design decisions worth knowing

- Plant detail pages and county pages are **server-rendered** (Astro `output: 'server'`) so they can fetch from the API at request time and return fully populated HTML — good for sharing links, good for crawlers.
- Search and county filtering are **client-side islands**. The search island lives in `src/components/SearchIsland.astro` and is reusable across pages.
- Scientific names are styled as if in a botanical key: italic Garamond for the binomial, upright Garamond for the authority and rank markers (var., ssp., f.).
- The site is honest about scope. Every page that surfaces data is willing to say "USDA has not characterised this taxon" rather than fake completeness.
