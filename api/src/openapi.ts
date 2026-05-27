/**
 * OpenAPI 3.0 spec for the Rootfast API.
 *
 * Hand-maintained — kept in sync with src/index.ts by code review. Served
 * verbatim at /v1/openapi.json, and rendered at /v1/docs via Scalar.
 *
 * Editing rules:
 *   - Bump info.version on breaking changes.
 *   - When adding a path, also list any new query params in the relevant
 *     parameters block.
 *   - Schemas are intentionally summary-level (the surface is large; we
 *     don't aim for 1-to-1 field coverage on the wide plant record).
 */

export const OPENAPI_SPEC = {
  openapi: "3.0.3",
  info: {
    title: "Rootfast API",
    version: "1.0.0",
    summary: "Native plants, counties, hardiness zones — joined and queryable.",
    description:
      "A small, JSON-only HTTP API over USDA PLANTS, USDA Plant Hardiness Zone Map (2023), " +
      "iNaturalist photos, and the GBIF Backbone Taxonomy. No keys, CC0 data, MIT code. " +
      "Bulk listings additionally support `format=csv` and `format=ndjson` for streaming exports.\n\n" +
      "**Rate limits (per client IP, 60-second windows):** " +
      "120 default · 5 for `?format=csv|ndjson` exports · 60 for search " +
      "(`/v1/search` and `POST /v1/plants/search`). " +
      "On rejection: HTTP 429 with `Retry-After: 60` and a `rate_limited` error body. " +
      "`/healthz`, `/v1/openapi.json`, `/v1/docs` are not rate-limited.",
    contact: { name: "Rootfast", url: "https://rootfast.org" },
    license: { name: "CC0 1.0 Universal", url: "https://creativecommons.org/publicdomain/zero/1.0/" },
  },
  servers: [
    { url: "https://api.rootfast.org", description: "Production" },
    { url: "https://rootfast-api.gdws.workers.dev", description: "Workers.dev fallback" },
  ],
  tags: [
    { name: "meta",      description: "Health and metadata." },
    { name: "plants",    description: "Taxa: detail, search, filters." },
    { name: "counties",  description: "County listings and per-county plant lists." },
    { name: "states",    description: "State listings, state×plants, state×counties." },
    { name: "hardiness", description: "USDA Plant Hardiness Zone lookups." },
    { name: "search",    description: "Free-text taxon search." },
  ],

  paths: {
    "/healthz": {
      get: {
        tags: ["meta"],
        operationId: "healthz",
        summary: "Service health.",
        description: "Returns `{ok, dataset_version, schema_version}`. Cheap; no DB read.",
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Health" } } },
          },
        },
      },
    },

    "/v1/plants": {
      get: {
        tags: ["plants"],
        operationId: "listPlants",
        summary: "List/filter plants.",
        description:
          "Paginated taxa list with the full §F filter set (family, growth habit, drought, shade, " +
          "min/max temperature, county-count rarity, etc.). Set `format=csv` or `format=ndjson` for " +
          "bulk export (limit can rise to 50,000 in those modes).",
        parameters: [
          { $ref: "#/components/parameters/limit" },
          { $ref: "#/components/parameters/offset" },
          { $ref: "#/components/parameters/format" },
          { $ref: "#/components/parameters/familyFilter" },
          { $ref: "#/components/parameters/genusFilter" },
          { $ref: "#/components/parameters/rankFilter" },
          { $ref: "#/components/parameters/growthHabitFilter" },
          { $ref: "#/components/parameters/durationFilter" },
          { $ref: "#/components/parameters/nativityFilter" },
          { $ref: "#/components/parameters/droughtTolerance" },
          { $ref: "#/components/parameters/shadeTolerance" },
          { $ref: "#/components/parameters/moistureUse" },
          { $ref: "#/components/parameters/growthRate" },
          { $ref: "#/components/parameters/lifespan" },
          { $ref: "#/components/parameters/commercialAvailability" },
          { $ref: "#/components/parameters/flowerColor" },
          { $ref: "#/components/parameters/minHeightFt" },
          { $ref: "#/components/parameters/maxHeightFt" },
          { $ref: "#/components/parameters/minTemperatureF" },
          { $ref: "#/components/parameters/maxTemperatureF" },
          { $ref: "#/components/parameters/minCounties" },
          { $ref: "#/components/parameters/maxCounties" },
          { $ref: "#/components/parameters/wetlandCodeFilter" },
        ],
        responses: {
          "200": {
            description: "Filtered plant page.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/PlantListResponse" } },
              "text/csv":          { schema: { type: "string" } },
              "application/x-ndjson": { schema: { type: "string" } },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "429": { $ref: "#/components/responses/RateLimited" },
        },
      },
    },

    "/v1/plants/{usda_symbol}": {
      get: {
        tags: ["plants"],
        operationId: "getPlant",
        summary: "Full plant detail.",
        description:
          "Rich record: identity, growth habits, durations, per-region native status, " +
          "characteristics (when USDA has them), every county the taxon is recorded in. " +
          "When a synonym symbol is requested, the response is redirected to the accepted plant.",
        parameters: [{ $ref: "#/components/parameters/usdaSymbol" }],
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/PlantDetail" } } },
          },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    "/v1/plants/{usda_symbol}/synonyms": {
      get: {
        tags: ["plants"],
        operationId: "getPlantSynonyms",
        summary: "Synonyms for a taxon.",
        parameters: [{ $ref: "#/components/parameters/usdaSymbol" }],
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/SynonymsResponse" } } },
          },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    "/v1/plants/by-gbif/{taxon_key}": {
      get: {
        tags: ["plants"],
        operationId: "getPlantByGbif",
        summary: "Plant detail by GBIF taxon key.",
        description: "Lookup by GBIF Backbone integer key. Same shape as /v1/plants/{usda_symbol}.",
        parameters: [
          { name: "taxon_key", in: "path", required: true, schema: { type: "integer", minimum: 0 } },
        ],
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/PlantDetail" } } },
          },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    "/v1/plants/random": {
      get: {
        tags: ["plants"],
        operationId: "randomPlant",
        summary: "A random plant.",
        description: "Returns a random taxon — useful for feature blocks. Short edge cache so it rotates.",
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/PlantDetail" } } },
          },
        },
      },
    },

    "/v1/plants/search": {
      post: {
        tags: ["plants"],
        operationId: "plantFinderSearch",
        summary: "Structured plant finder.",
        description:
          "JSON-body version of the §F filter surface. Accepts the same filter keys as the " +
          "GET /v1/plants query params (plus an optional `q` substring) and returns paged results.",
        requestBody: {
          required: false,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/PlantFinderRequest" } },
          },
        },
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/PlantListResponse" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "429": { $ref: "#/components/responses/RateLimited" },
        },
      },
    },

    "/v1/counties": {
      get: {
        tags: ["counties"],
        operationId: "listCounties",
        summary: "List counties.",
        parameters: [
          { name: "state", in: "query", description: "Two-letter state code.", schema: { type: "string", minLength: 2, maxLength: 2 } },
          { $ref: "#/components/parameters/limit" },
          { $ref: "#/components/parameters/offset" },
        ],
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/CountyListResponse" } } },
          },
        },
      },
    },

    "/v1/counties/taxa-counts": {
      get: {
        tags: ["counties"],
        operationId: "listCountyTaxaCounts",
        summary: "Every county with its taxa count.",
        description:
          "Bulk listing for biodiversity visualizations (the counties-by-biodiversity map on rootfast.org/explore is the canonical consumer). Returns all ~3,227 US counties in one response. Filter by `?state=XX` for a per-state subset.",
        parameters: [
          { name: "state", in: "query", description: "USPS state code (optional filter).", schema: { type: "string", minLength: 2, maxLength: 2 } },
        ],
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/CountyTaxaCountsResponse" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
        },
      },
    },

    "/v1/counties/photo-coverage": {
      get: {
        tags: ["counties"],
        operationId: "listCountyPhotoCoverage",
        summary: "Per-county photo coverage.",
        description:
          "For each US county, returns the total recorded taxa, the count with an iNaturalist photo on file, and the resulting percentage. Used by the photo-coverage map on /explore.",
        parameters: [
          { name: "state", in: "query", schema: { type: "string", minLength: 2, maxLength: 2 } },
        ],
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/CountyPhotoCoverageResponse" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
        },
      },
    },

    "/v1/counties/{county_fips}/plants": {
      get: {
        tags: ["counties"],
        operationId: "plantsByCounty",
        summary: "Plants recorded in a county.",
        description:
          "Per-county listing with all §F filters applied. `nativity` per row reflects the county-level " +
          "record. Bulk-export modes (csv, ndjson) supported.",
        parameters: [
          { $ref: "#/components/parameters/countyFips" },
          { $ref: "#/components/parameters/limit" },
          { $ref: "#/components/parameters/offset" },
          { $ref: "#/components/parameters/format" },
          { $ref: "#/components/parameters/nativityFilter" },
          { $ref: "#/components/parameters/growthHabitFilter" },
          { $ref: "#/components/parameters/familyFilter" },
        ],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/CountyPlantsResponse" } },
              "text/csv":          { schema: { type: "string" } },
              "application/x-ndjson": { schema: { type: "string" } },
            },
          },
          "404": { $ref: "#/components/responses/NotFound" },
          "429": { $ref: "#/components/responses/RateLimited" },
        },
      },
    },

    "/v1/states": {
      get: {
        tags: ["states"],
        operationId: "listStates",
        summary: "States with ingested data.",
        description:
          "Returns only states with at least one ingested distribution record. " +
          "States that exist in our catalogue but have no plant data yet (currently " +
          "just Connecticut, pending USDA's republish post-2022 county abolition) are " +
          "omitted here but remain addressable via `/v1/states/{state_code}`.",
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/StatesListResponse" } } },
          },
        },
      },
    },

    "/v1/states/endemics": {
      get: {
        tags: ["states"],
        operationId: "listStateEndemicCounts",
        summary: "Per-state count of endemic taxa.",
        description:
          "Each state with at least one taxon recorded ONLY within its borders, ranked by endemic count. Florida, California, Texas, and Hawaii dominate the top of the list. Used by the state-endemics explore page.",
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/StateEndemicCountsResponse" } } },
          },
        },
      },
    },

    "/v1/states/{state_code}/endemic-taxa": {
      get: {
        tags: ["states"],
        operationId: "endemicTaxaByState",
        summary: "Endemic taxa within a state.",
        description:
          "Paginated list of taxa whose entire USDA-recorded distribution lies inside the given state — true single-state endemics.",
        parameters: [
          { $ref: "#/components/parameters/stateCode" },
          { $ref: "#/components/parameters/limit" },
          { $ref: "#/components/parameters/offset" },
        ],
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/StateEndemicTaxaResponse" } } },
          },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    "/v1/states/{state_code}": {
      get: {
        tags: ["states"],
        operationId: "getState",
        summary: "Single state header.",
        parameters: [{ $ref: "#/components/parameters/stateCode" }],
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/StateHeaderResponse" } } },
          },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    "/v1/states/{state_code}/plants": {
      get: {
        tags: ["states"],
        operationId: "plantsByState",
        summary: "Plants in a state.",
        description:
          "Every taxon in the state, rolled up across counties. `county_count` / `native_counties` / " +
          "`introduced_counties` / `both_counties` give the per-county breakdown.",
        parameters: [
          { $ref: "#/components/parameters/stateCode" },
          { $ref: "#/components/parameters/limit" },
          { $ref: "#/components/parameters/offset" },
          { $ref: "#/components/parameters/format" },
          { $ref: "#/components/parameters/nativityFilter" },
          { $ref: "#/components/parameters/growthHabitFilter" },
        ],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/StatePlantsResponse" } },
              "text/csv":          { schema: { type: "string" } },
              "application/x-ndjson": { schema: { type: "string" } },
            },
          },
          "404": { $ref: "#/components/responses/NotFound" },
          "429": { $ref: "#/components/responses/RateLimited" },
        },
      },
    },

    "/v1/states/{state_code}/counties": {
      get: {
        tags: ["states"],
        operationId: "countiesByState",
        summary: "Counties of a state.",
        parameters: [{ $ref: "#/components/parameters/stateCode" }],
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/StateCountiesResponse" } } },
          },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    "/v1/families": {
      get: {
        tags: ["plants"],
        operationId: "listFamilies",
        summary: "Plant families with counts.",
        description:
          "Every botanical family that appears in the catalogue, with the count of accepted (non-synonym, non-excluded) taxa and distinct genera. Sorted by `plant_count` descending — Asteraceae, Poaceae, Fabaceae lead. Used by the families browser at /explore/families.",
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/FamiliesResponse" } } },
          },
        },
      },
    },

    "/v1/search": {
      get: {
        tags: ["search"],
        operationId: "search",
        summary: "Free-text taxon search.",
        description: "FTS5-backed search across scientific name, common name, family, genus. Up to 25 results, BM25-ranked.",
        parameters: [
          { name: "q", in: "query", required: true, description: "Search string (>= 2 chars).", schema: { type: "string", minLength: 2 } },
        ],
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/SearchResponse" } } },
          },
          "429": { $ref: "#/components/responses/RateLimited" },
        },
      },
    },

    "/v1/hardiness/zones": {
      get: {
        tags: ["hardiness"],
        operationId: "listHardinessZones",
        summary: "Canonical 26-row hardiness zone reference.",
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/HardinessZonesResponse" } } },
          },
        },
      },
    },

    "/v1/hardiness/zones/{zone_code}": {
      get: {
        tags: ["hardiness"],
        operationId: "getHardinessZone",
        summary: "Single hardiness zone with counts.",
        parameters: [
          { name: "zone_code", in: "path", required: true, schema: { type: "string", pattern: "^([1-9]|1[0-3])[abAB]$", example: "5a" } },
        ],
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/HardinessZoneResponse" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    "/v1/hardiness/counties": {
      get: {
        tags: ["hardiness"],
        operationId: "listHardinessCounties",
        summary: "Every county with a mapped hardiness zone.",
        description:
          "Bulk listing for visualization use cases (the national zone map on rootfast.org/explore " +
          "is the canonical consumer). ~3,199 rows nationwide. Filter by `?state=XX` for a per-state " +
          "subset; counties without a centroid-derived zone (territories, water-heavy coastal) are absent.",
        parameters: [
          { name: "state", in: "query", description: "USPS state code (optional filter).", schema: { type: "string", minLength: 2, maxLength: 2 } },
        ],
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/HardinessCountiesResponse" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
        },
      },
    },

    "/v1/hardiness/zip/{zip}": {
      get: {
        tags: ["hardiness"],
        operationId: "hardinessByZip",
        summary: "Hardiness zone for a US ZIP.",
        description: "Accepts 5-digit ZIP or ZIP+4. Sourced from USDA PHZM 2023 ZIP table.",
        parameters: [
          { name: "zip", in: "path", required: true, schema: { type: "string", example: "59715" } },
        ],
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/HardinessZipResponse" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    "/v1/hardiness/county/{county_fips}": {
      get: {
        tags: ["hardiness"],
        operationId: "hardinessByCounty",
        summary: "Predominant hardiness zone for a county.",
        description:
          "Sampled at the county centroid against the USDA PHZM polygon layer. " +
          "28 of 3,227 counties have `zone: null` (territories or centroid in water).",
        parameters: [{ $ref: "#/components/parameters/countyFips" }],
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/HardinessCountyResponse" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    "/v1/soil/counties": {
      get: {
        tags: ["counties"],
        operationId: "listSoilByCounty",
        summary: "Per-county SSURGO soil profile.",
        description:
          "Bulk listing for soil-map visualizations. One representative soil profile per US county, sampled at the centroid and aggregated from USDA-NRCS SSURGO via the Soil Data Access REST API. Filter by `?state=XX` for a per-state subset.",
        parameters: [
          { name: "state", in: "query", schema: { type: "string", minLength: 2, maxLength: 2 } },
        ],
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/SoilByCountyListResponse" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
        },
      },
    },

    "/v1/soil/county/{county_fips}": {
      get: {
        tags: ["counties"],
        operationId: "soilByCounty",
        summary: "Single county SSURGO soil profile.",
        description:
          "Returns the sampled soil at a county's centroid: USDA map unit, dominant component, drainage class, texture, slope, surface pH, organic matter, sand/silt/clay %, and available water capacity. Counties whose centroid falls outside any mapped soil (territories, big water bodies) return `soil: null` with a note.",
        parameters: [{ $ref: "#/components/parameters/countyFips" }],
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/SoilByCountyResponse" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    "/v1/openapi.json": {
      get: {
        tags: ["meta"],
        operationId: "openapi",
        summary: "This document.",
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
  },

  components: {
    parameters: {
      limit: {
        name: "limit", in: "query",
        description: "Page size. Default 50 (JSON), 50,000 (csv/ndjson). Max 10,000 (JSON), 50,000 (bulk).",
        schema: { type: "integer", minimum: 1, maximum: 50000 },
      },
      offset: {
        name: "offset", in: "query",
        description: "Page offset (0-based).",
        schema: { type: "integer", minimum: 0 },
      },
      format: {
        name: "format", in: "query",
        description: "Response format.",
        schema: { type: "string", enum: ["json", "csv", "ndjson"], default: "json" },
      },
      usdaSymbol: {
        name: "usda_symbol", in: "path", required: true,
        description: "USDA PLANTS symbol (e.g. 'PIPO'). Case-insensitive.",
        schema: { type: "string", example: "PIPO" },
      },
      countyFips: {
        name: "county_fips", in: "path", required: true,
        description: "5-digit county FIPS code (e.g. '30031').",
        schema: { type: "string", pattern: "^[0-9]{4,5}$", example: "30031" },
      },
      stateCode: {
        name: "state_code", in: "path", required: true,
        description: "Two-letter USPS state/territory code (case-insensitive).",
        schema: { type: "string", minLength: 2, maxLength: 2, example: "MT" },
      },
      familyFilter:    { name: "family",      in: "query", schema: { type: "string" }, description: "Match family name prefix (e.g. 'Pinaceae')." },
      genusFilter:     { name: "genus",       in: "query", schema: { type: "string" }, description: "Match genus name (exact)." },
      rankFilter:      { name: "rank",        in: "query", schema: { type: "string", enum: ["Species","Subspecies","Variety","Form"] } },
      growthHabitFilter: { name: "growth_habit", in: "query", schema: { type: "string", enum: ["Tree","Shrub","Subshrub","Vine","Forb/herb","Forb","Graminoid","Nonvascular","Lichenous"] } },
      durationFilter:  { name: "duration",    in: "query", schema: { type: "string", enum: ["Annual","Biennial","Perennial"] } },
      nativityFilter:  { name: "nativity",    in: "query", schema: { type: "string", enum: ["Native","Introduced","Both"] } },
      wetlandCodeFilter: { name: "wetland_code", in: "query", description: "Wetland indicator code from USDA — OBL (obligate wetland), FACW (facultative wetland), FAC (facultative), FACU (facultative upland), UPL (obligate upland), NL (no indicator).", schema: { type: "string", enum: ["OBL","FACW","FAC","FACU","UPL","NL"] } },
      droughtTolerance:{ name: "drought_tolerance", in: "query", schema: { type: "string", enum: ["High","Medium","Low","None"] } },
      shadeTolerance:  { name: "shade_tolerance",   in: "query", schema: { type: "string", enum: ["Intolerant","Intermediate","Tolerant"] } },
      moistureUse:     { name: "moisture_use",      in: "query", schema: { type: "string", enum: ["High","Medium","Low","None"] } },
      growthRate:      { name: "growth_rate",       in: "query", schema: { type: "string", enum: ["Slow","Moderate","Rapid"] } },
      lifespan:        { name: "lifespan",          in: "query", schema: { type: "string", enum: ["Short","Moderate","Long"] } },
      commercialAvailability: { name: "commercial_availability", in: "query", schema: { type: "string", enum: ["No Known Source","Routinely Available","Field Collections Only","Contracting Only"] } },
      flowerColor:     { name: "flower_color",      in: "query", schema: { type: "string" }, description: "Case-insensitive exact match." },
      minHeightFt:     { name: "min_height_ft",     in: "query", schema: { type: "number" } },
      maxHeightFt:     { name: "max_height_ft",     in: "query", schema: { type: "number" } },
      minTemperatureF: { name: "min_temperature_f", in: "query", schema: { type: "number" }, description: "Minimum survivable temperature lower bound (°F)." },
      maxTemperatureF: { name: "max_temperature_f", in: "query", schema: { type: "number" }, description: "Minimum survivable temperature upper bound (°F)." },
      minCounties:     { name: "min_counties",      in: "query", schema: { type: "integer", minimum: 0 }, description: "Plant must be recorded in at least this many counties nationally." },
      maxCounties:     { name: "max_counties",      in: "query", schema: { type: "integer", minimum: 0 }, description: "Plant must be recorded in at most this many counties nationally." },
    },

    schemas: {
      Health: {
        type: "object",
        required: ["ok", "dataset_version", "schema_version"],
        properties: {
          ok:               { type: "boolean" },
          dataset_version:  { type: "string" },
          schema_version:   { type: "string" },
        },
      },
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            required: ["code", "message"],
            properties: {
              code:    { type: "string", example: "not_found" },
              message: { type: "string" },
            },
          },
        },
      },
      Paging: {
        type: "object",
        properties: {
          limit:    { type: "integer" },
          offset:   { type: "integer" },
          count:    { type: "integer", description: "Rows returned in this page." },
          has_more: { type: "boolean" },
        },
      },

      PlantSummary: {
        type: "object",
        description: "Compact taxon row used in lists.",
        properties: {
          usda_symbol:        { type: "string" },
          scientific_name:    { type: "string" },
          common_name:        { type: "string", nullable: true },
          family:             { type: "string", nullable: true },
          photo_thumb_url:    { type: "string", nullable: true },
        },
      },
      Photo: {
        type: "object",
        nullable: true,
        properties: {
          source:      { type: "string", example: "inaturalist" },
          source_id:   { type: "integer", nullable: true },
          taxon_id:    { type: "integer", nullable: true },
          url:         { type: "string" },
          thumb_url:   { type: "string", nullable: true },
          license:     { type: "string", example: "cc-by-nc" },
          attribution: { type: "string" },
        },
      },
      PlantDetail: {
        type: "object",
        properties: {
          plant: {
            type: "object",
            description: "Full plant row from the plants table (~25 fields).",
            additionalProperties: true,
          },
          photo:           { $ref: "#/components/schemas/Photo" },
          growth_habits:   { type: "array", items: { type: "string" } },
          durations:       { type: "array", items: { type: "string" } },
          native_status:   {
            type: "array",
            items: {
              type: "object",
              properties: {
                region_code: { type: "string" },
                status:      { type: "string", enum: ["Native","Introduced","Both","Waif","Unknown"] },
              },
            },
          },
          characteristics: { type: "object", additionalProperties: true, nullable: true },
          counties: {
            type: "array",
            items: {
              type: "object",
              properties: {
                county_fips: { type: "string" },
                county_name: { type: "string" },
                state_code:  { type: "string" },
                nativity:    { type: "string", enum: ["Native","Introduced","Both"] },
              },
            },
          },
        },
      },
      PlantListResponse: {
        type: "object",
        properties: {
          total:   { type: "integer" },
          paging:  { $ref: "#/components/schemas/Paging" },
          filters: { type: "object", additionalProperties: { type: "string" }, nullable: true },
          plants:  { type: "array", items: { $ref: "#/components/schemas/PlantSummary" } },
        },
      },
      PlantFinderRequest: {
        type: "object",
        description: "Same field set as GET /v1/plants query params, plus optional `q`.",
        properties: {
          q:            { type: "string", description: "Substring match against name fields." },
          family:       { type: "string" },
          genus:        { type: "string" },
          rank:         { type: "string" },
          growth_habit: { type: "string" },
          duration:     { type: "string" },
          nativity:     { type: "string", enum: ["Native","Introduced","Both"] },
          drought_tolerance: { type: "string" },
          shade_tolerance:   { type: "string" },
          moisture_use:      { type: "string" },
          min_temperature_f: { type: "number" },
          max_temperature_f: { type: "number" },
          min_counties:      { type: "integer", minimum: 0 },
          max_counties:      { type: "integer", minimum: 0 },
          limit:             { type: "integer" },
          offset:            { type: "integer" },
        },
      },
      SynonymsResponse: {
        type: "object",
        properties: {
          symbol:    { type: "string" },
          accepted:  { type: "object", additionalProperties: true },
          synonyms:  {
            type: "array",
            items: {
              type: "object",
              properties: {
                usda_symbol:     { type: "string" },
                scientific_name: { type: "string" },
              },
            },
          },
        },
      },

      County: {
        type: "object",
        properties: {
          county_fips:  { type: "string" },
          county_name:  { type: "string" },
          state_code:   { type: "string" },
          centroid_lat: { type: "number", nullable: true },
          centroid_lon: { type: "number", nullable: true },
          taxa_count:   { type: "integer" },
        },
      },
      CountyListResponse: {
        type: "object",
        properties: {
          count:    { type: "integer" },
          paging:   { $ref: "#/components/schemas/Paging" },
          counties: { type: "array", items: { $ref: "#/components/schemas/County" } },
        },
      },
      CountyPlantsResponse: {
        type: "object",
        properties: {
          county: { $ref: "#/components/schemas/County" },
          count:  { type: "integer" },
          total:  { type: "integer" },
          paging: { $ref: "#/components/schemas/Paging" },
          plants: {
            type: "array",
            items: {
              allOf: [
                { $ref: "#/components/schemas/PlantSummary" },
                { type: "object", properties: { nativity: { type: "string", enum: ["Native","Introduced","Both"] } } },
              ],
            },
          },
        },
      },

      State: {
        type: "object",
        properties: {
          state_code:    { type: "string" },
          state_name:    { type: "string" },
          state_fips:    { type: "string", nullable: true },
          country:       { type: "string" },
          county_count:  { type: "integer" },
          taxa_count:    { type: "integer" },
        },
      },
      StatesListResponse: {
        type: "object",
        properties: {
          count:  { type: "integer" },
          states: { type: "array", items: { $ref: "#/components/schemas/State" } },
        },
      },
      StateHeaderResponse: {
        type: "object",
        properties: { state: { $ref: "#/components/schemas/State" } },
      },
      StatePlantsResponse: {
        type: "object",
        properties: {
          state:   { $ref: "#/components/schemas/State" },
          counts:  {
            type: "object",
            properties: { taxa: { type: "integer" }, counties: { type: "integer" } },
          },
          paging:  { $ref: "#/components/schemas/Paging" },
          filters: { type: "object", additionalProperties: { type: "string" }, nullable: true },
          plants:  {
            type: "array",
            items: {
              allOf: [
                { $ref: "#/components/schemas/PlantSummary" },
                {
                  type: "object",
                  properties: {
                    county_count:        { type: "integer" },
                    native_counties:     { type: "integer" },
                    introduced_counties: { type: "integer" },
                    both_counties:       { type: "integer" },
                    nativity:            { type: "string", enum: ["Native","Introduced","Both"] },
                  },
                },
              ],
            },
          },
        },
      },
      StateCountiesResponse: {
        type: "object",
        properties: {
          state:    { $ref: "#/components/schemas/State" },
          count:    { type: "integer" },
          counties: { type: "array", items: { $ref: "#/components/schemas/County" } },
        },
      },

      SearchResponse: {
        type: "object",
        properties: {
          query:   { type: "string" },
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                usda_symbol:     { type: "string" },
                scientific_name: { type: "string" },
                common_name:     { type: "string", nullable: true },
                family:          { type: "string", nullable: true },
              },
            },
          },
        },
      },

      HardinessZone: {
        type: "object",
        properties: {
          zone_code:        { type: "string", example: "5a" },
          zone_class_code:  { type: "integer", minimum: 1, maximum: 26 },
          temp_min_f:       { type: "number" },
          temp_max_f:       { type: "number" },
          description:      { type: "string" },
          zip_count:        { type: "integer" },
          county_count:     { type: "integer" },
        },
      },
      HardinessZonesResponse: {
        type: "object",
        properties: {
          count: { type: "integer" },
          zones: { type: "array", items: { $ref: "#/components/schemas/HardinessZone" } },
        },
      },
      HardinessZoneResponse: {
        type: "object",
        properties: { zone: { $ref: "#/components/schemas/HardinessZone" } },
      },
      HardinessZipResponse: {
        type: "object",
        properties: {
          zip_code: { type: "string" },
          zone: {
            type: "object",
            properties: {
              zone_code:        { type: "string" },
              zone_class_code:  { type: "integer" },
              temp_min_f:       { type: "number" },
              temp_max_f:       { type: "number" },
              description:      { type: "string" },
            },
          },
        },
      },
      SoilProfile: {
        type: "object",
        properties: {
          mukey:            { type: "integer", nullable: true, description: "USDA-NRCS map unit key." },
          muname:           { type: "string",  nullable: true },
          dominant_comp:    { type: "string",  nullable: true },
          drainage_class:   { type: "string",  nullable: true },
          texture_class:    { type: "string",  nullable: true, description: "Derived USDA soil-triangle class." },
          slope_pct:        { type: "number",  nullable: true },
          surface_ph:       { type: "number",  nullable: true },
          surface_om_pct:   { type: "number",  nullable: true },
          surface_sand_pct: { type: "number",  nullable: true },
          surface_silt_pct: { type: "number",  nullable: true },
          surface_clay_pct: { type: "number",  nullable: true },
          awc_in_top_25cm:  { type: "number",  nullable: true },
        },
      },
      SoilByCountyResponse: {
        type: "object",
        properties: {
          county: {
            type: "object",
            properties: {
              county_fips: { type: "string" },
              county_name: { type: "string" },
              state_code:  { type: "string" },
            },
          },
          soil: { allOf: [{ $ref: "#/components/schemas/SoilProfile" }], nullable: true },
          note: { type: "string" },
        },
      },
      SoilByCountyListResponse: {
        type: "object",
        properties: {
          count: { type: "integer" },
          counties: {
            type: "array",
            items: {
              type: "object",
              properties: {
                county_fips:      { type: "string" },
                county_name:      { type: "string" },
                state_code:       { type: "string" },
                muname:           { type: "string", nullable: true },
                dominant_comp:    { type: "string", nullable: true },
                drainage_class:   { type: "string", nullable: true },
                texture_class:    { type: "string", nullable: true },
                surface_ph:       { type: "number", nullable: true },
                surface_om_pct:   { type: "number", nullable: true },
                slope_pct:        { type: "number", nullable: true },
                surface_sand_pct: { type: "number", nullable: true },
                surface_silt_pct: { type: "number", nullable: true },
                surface_clay_pct: { type: "number", nullable: true },
                awc_in_top_25cm:  { type: "number", nullable: true },
              },
            },
          },
        },
      },
      CountyPhotoCoverageResponse: {
        type: "object",
        properties: {
          count: { type: "integer" },
          counties: {
            type: "array",
            items: {
              type: "object",
              properties: {
                county_fips: { type: "string" },
                county_name: { type: "string" },
                state_code:  { type: "string" },
                taxa_count:  { type: "integer" },
                photo_count: { type: "integer" },
                photo_pct:   { type: "number", description: "Photos / taxa as a percentage." },
              },
            },
          },
        },
      },
      StateEndemicCountsResponse: {
        type: "object",
        properties: {
          count: { type: "integer" },
          states: {
            type: "array",
            items: {
              type: "object",
              properties: {
                state_code:    { type: "string" },
                state_name:    { type: "string" },
                country:       { type: "string" },
                endemic_count: { type: "integer" },
              },
            },
          },
        },
      },
      StateEndemicTaxaResponse: {
        type: "object",
        properties: {
          state:  { $ref: "#/components/schemas/State" },
          total:  { type: "integer" },
          paging: { $ref: "#/components/schemas/Paging" },
          plants: { type: "array", items: { $ref: "#/components/schemas/PlantSummary" } },
        },
      },
      CountyTaxaCountsResponse: {
        type: "object",
        properties: {
          count: { type: "integer" },
          counties: {
            type: "array",
            items: {
              type: "object",
              properties: {
                county_fips: { type: "string" },
                county_name: { type: "string" },
                state_code:  { type: "string" },
                taxa_count:  { type: "integer" },
              },
            },
          },
        },
      },
      FamiliesResponse: {
        type: "object",
        properties: {
          count: { type: "integer" },
          families: {
            type: "array",
            items: {
              type: "object",
              properties: {
                family:      { type: "string", example: "Asteraceae" },
                plant_count: { type: "integer" },
                genus_count: { type: "integer" },
              },
            },
          },
        },
      },
      HardinessCountiesResponse: {
        type: "object",
        properties: {
          count: { type: "integer" },
          counties: {
            type: "array",
            items: {
              type: "object",
              properties: {
                county_fips: { type: "string" },
                county_name: { type: "string" },
                state_code:  { type: "string" },
                zone_code:   { type: "string" },
              },
            },
          },
        },
      },
      HardinessCountyResponse: {
        type: "object",
        properties: {
          county: {
            type: "object",
            properties: {
              county_fips: { type: "string" },
              county_name: { type: "string" },
              state_code:  { type: "string" },
            },
          },
          zone: {
            type: "object",
            nullable: true,
            properties: {
              zone_code:        { type: "string" },
              zone_class_code:  { type: "integer" },
              temp_min_f:       { type: "number" },
              temp_max_f:       { type: "number" },
              description:      { type: "string" },
            },
          },
          note: { type: "string", description: "Present when zone is null." },
        },
      },
    },

    responses: {
      BadRequest: {
        description: "Bad request",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      NotFound: {
        description: "Not found",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      RateLimited: {
        description:
          "Rate limit exceeded. See top-level description for per-tier limits. " +
          "Response carries a `Retry-After` header (seconds) and a `tier` body field " +
          "indicating which limiter rejected the request.",
        headers: {
          "Retry-After": { schema: { type: "integer" }, description: "Seconds until the limit window resets." },
        },
        content: {
          "application/json": {
            schema: {
              allOf: [
                { $ref: "#/components/schemas/Error" },
                {
                  type: "object",
                  properties: {
                    tier:        { type: "string", enum: ["default", "bulk", "search"] },
                    retry_after: { type: "integer" },
                  },
                },
              ],
            },
          },
        },
      },
    },
  },
} as const;
