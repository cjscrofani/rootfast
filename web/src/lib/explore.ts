/**
 * Curated "Explore" lists.
 *
 * Each entry is a thematic slice of the catalogue with hand-picked API filter
 * values. The /explore landing page renders these grouped into categories;
 * /explore/[slug] turns the filter set into a paginated plant listing.
 *
 * Filter values are passed straight to /v1/plants as URL params, so they must
 * be valid §F values. Comma-separated values OR together inside a param.
 */

export type ExploreFilters = Record<string, string | number>;

export interface ExploreList {
  slug: string;
  label: string;
  short: string;          // shown on cards
  description: string;    // shown on the detail page
  filters: ExploreFilters;
}

export interface ExploreCategory {
  key: string;
  label: string;
  intro: string;
  lists: ExploreList[];
}

export const EXPLORE_CATEGORIES: ExploreCategory[] = [
  {
    key: 'hardiness',
    label: 'Hardiness & climate',
    intro: 'Slices keyed to the USDA Plant Hardiness Zone Map (2023). The map shows where each zone lands; the lists join the zone temperature bounds against each plant\'s minimum survivable temperature.',
    lists: [
      {
        slug: 'hardiness-zone-map',
        label: 'National hardiness zone map',
        short: 'Every US county coloured by zone.',
        description: 'Renders all 3,199 mapped US counties at their USDA-published hardiness zone. Hover for the county\'s zone class and °F range.',
        filters: {},  // visualization, not a filtered listing — see /explore/hardiness-zone-map
      },
      {
        slug: 'cold-hardy-plants',
        label: 'Cold-hardy (zone 4a or colder)',
        short: 'Plants surviving to −30 °F or below.',
        description: 'Taxa whose minimum survivable temperature is −30 °F or lower — suitable for hardiness zone 4a and colder. The Upper Plains, northern New England, the Mountain West interior.',
        filters: { max_temperature_f: -30 },
      },
      {
        slug: 'warm-climate-plants',
        label: 'Warm-climate (zone 8a and warmer)',
        short: 'Plants needing winter lows no colder than 10 °F.',
        description: 'Taxa whose minimum survivable temperature is at least 10 °F — won\'t survive a hard freeze, thrive in zone 8a and warmer. The Gulf Coast, Florida, low desert.',
        filters: { min_temperature_f: 10 },
      },
      {
        slug: 'biodiversity-map',
        label: 'Counties by plant diversity',
        short: 'Every county coloured by its taxa count.',
        description: 'Every US county rendered by how many distinct plant taxa USDA records there. The southern Appalachians, the California Floristic Province, and the Gulf Coast lead by a wide margin.',
        filters: {},
      },
      {
        slug: 'photo-coverage-map',
        label: 'Photo coverage by county',
        short: 'Where iNaturalist photo coverage is thin.',
        description: 'Each US county rendered by the share of its recorded taxa that have an iNaturalist photo on file. An honest look at where the visual side of the catalogue is well-covered and where it isn\'t.',
        filters: {},
      },
      {
        slug: 'where-i-live',
        label: 'What grows where I live?',
        short: 'Enter a ZIP. See your zone and what works.',
        description: 'Enter a US ZIP code. Rootfast looks up your USDA hardiness zone and returns the catalogue filtered to taxa whose minimum survivable temperature is at or below your zone\'s lower bound.',
        filters: {},
      },
      {
        slug: 'soil-map',
        label: 'National soil-texture map',
        short: 'Every county coloured by its surface soil texture.',
        description: 'Each US county rendered at its USDA-SSURGO surface texture class — sandy soils in the Coastal Plain, silt loams across the Corn Belt, clays along the Mississippi alluvium, and rocky mountain skeleton soils where centroids fall in steep terrain.',
        filters: {},
      },
    ],
  },

  {
    key: 'seasonal',
    label: 'Seasonal',
    intro: 'Time-sensitive slices that rotate with the calendar.',
    lists: [
      {
        slug: 'blooming-now',
        label: 'What\'s blooming now',
        short: 'Native plants flowering this month.',
        description: 'Taxa USDA records as blooming during the current month — re-computed each time the page is requested. Useful for matching a field observation against the catalogue or for planning a phenology walk.',
        filters: {},
      },
    ],
  },

  {
    key: 'wetland',
    label: 'Wetland gradient',
    intro: 'USDA\'s wetland indicator codes mark a plant\'s typical hydrology — from obligate wetland species you only find with their feet wet, all the way to obligate uplands that won\'t tolerate standing water. Useful for restoration, rain-garden design, and reading a site\'s hydrology.',
    lists: [
      {
        slug: 'wetland-obligate',
        label: 'Obligate wetland (OBL)',
        short: 'Almost always in wetlands.',
        description: 'Species USDA classifies as OBL — found in wetlands more than 99% of the time. Cattails, marsh marigold, the duckweeds. The canonical "this site is a wetland" indicators.',
        filters: { wetland_code: 'OBL' },
      },
      {
        slug: 'wetland-facultative-wet',
        label: 'Facultative wetland (FACW)',
        short: 'Usually in wetlands.',
        description: 'Species USDA classifies as FACW — wetlands 67%–99% of the time, occasionally in uplands. Many sedges and willows.',
        filters: { wetland_code: 'FACW' },
      },
      {
        slug: 'wetland-facultative',
        label: 'Facultative (FAC)',
        short: 'Equally at home in either.',
        description: 'Species USDA classifies as FAC — wetlands and uplands roughly evenly. The generalists.',
        filters: { wetland_code: 'FAC' },
      },
      {
        slug: 'wetland-facultative-upland',
        label: 'Facultative upland (FACU)',
        short: 'Usually in uplands.',
        description: 'Species USDA classifies as FACU — uplands 67%–99% of the time, but tolerate occasional wet feet.',
        filters: { wetland_code: 'FACU' },
      },
      {
        slug: 'wetland-upland',
        label: 'Obligate upland (UPL)',
        short: 'Almost never in wetlands.',
        description: 'Species USDA classifies as UPL — uplands more than 99% of the time. Desert and dryland natives, most conifers.',
        filters: { wetland_code: 'UPL' },
      },
    ],
  },

  {
    key: 'taxonomy',
    label: 'Taxonomic exploration',
    intro: 'Browse by botanical structure — families for taxonomic depth, growth habit for shape.',
    lists: [
      {
        slug: 'families',
        label: 'Browse by family',
        short: 'All 300+ families ranked by taxa count.',
        description: 'Every botanical family present in the catalogue, with the number of accepted taxa and distinct genera in each. Asteraceae (asters, sunflowers, daisies) leads with nearly 4,000 taxa; Poaceae (grasses) and Fabaceae (legumes) follow.',
        filters: {},
      },
      {
        slug: 'trees',
        label: 'Trees',
        short: 'Every taxon USDA classes as a tree.',
        description: 'Taxa with a Tree growth habit — from coast redwoods to high-elevation krummholz pines.',
        filters: { growth_habit: 'Tree' },
      },
      {
        slug: 'shrubs',
        label: 'Shrubs',
        short: 'Shrubs and subshrubs.',
        description: 'Woody plants smaller than trees — the structural layer of most natural plantings.',
        filters: { growth_habit: 'Shrub' },
      },
      {
        slug: 'grasses',
        label: 'Grasses & graminoids',
        short: 'Bunchgrasses, sedges, rushes.',
        description: 'Graminoid-form taxa: grasses (Poaceae), sedges (Cyperaceae), rushes (Juncaceae), plus their look-alikes.',
        filters: { growth_habit: 'Graminoid' },
      },
      {
        slug: 'forbs',
        label: 'Forbs & herbs',
        short: 'Non-graminoid herbaceous plants.',
        description: 'Forb-form herbaceous plants — wildflowers, broadleaved herbs, everything between grasses and shrubs.',
        filters: { growth_habit: 'Forb/herb' },
      },
    ],
  },

  {
    key: 'ecology',
    label: 'Ecological role',
    intro: 'Slices keyed to ecological function rather than appearance.',
    lists: [
      {
        slug: 'nitrogen-fixers',
        label: 'Nitrogen fixers',
        short: 'Plants that fix atmospheric nitrogen.',
        description: 'Taxa USDA rates as Medium or High for nitrogen fixation — legumes (Fabaceae), alders (Alnus), Ceanothus, and a handful of other lineages with the symbiotic-bacteria trick. Important for soil-building plantings and restoration after disturbance.',
        filters: { nitrogen_fixation: 'Medium,High' },
      },
      {
        slug: 'state-endemics',
        label: 'State endemics',
        short: 'Plants recorded in exactly one state.',
        description: 'For each US state, the taxa whose entire USDA-recorded distribution lives within that single state. California, Hawaii, Texas, and Florida dominate.',
        filters: {},
      },
    ],
  },
  {
    key: 'availability',
    label: 'Commercial availability',
    intro: 'Plants you can actually buy — what nurseries stock, what propagators contract for.',
    lists: [
      {
        slug: 'routinely-available',
        label: 'Routinely available',
        short: 'Routinely stocked at nurseries (≈900 species).',
        description: 'Species USDA flags as routinely available through the commercial nursery trade. The realistic shortlist if you walk into a native-plant nursery with a planting plan.',
        filters: { commercial_availability: 'Routinely Available' },
      },
      {
        slug: 'nursery-stock',
        label: 'Sold as nursery stock',
        short: 'Plants sold as nursery stock — easier first plantings.',
        description: 'Plants USDA tags as a nursery-stock product. Ideal for gardeners who want container-grown or balled-and-burlapped material rather than seed.',
        filters: { nursery_stock_product: '1' },
      },
      {
        slug: 'contracting-only',
        label: 'Contracting only',
        short: 'Specialty material — propagators grow it on contract.',
        description: 'Species that aren\'t shelf-stocked but propagators will grow on contract. Useful for restoration or large jobs where lead time is acceptable.',
        filters: { commercial_availability: 'Contracting Only' },
      },
    ],
  },
  {
    key: 'rarity',
    label: 'Range and rarity',
    intro: 'County-count slices — from single-county endemics to widespread generalists.',
    lists: [
      {
        slug: 'single-county-taxa',
        label: 'Single-county taxa',
        short: 'Recorded in exactly 1 county nationally.',
        description: 'Taxa documented in only a single county across the entire catalogue. Mostly local endemics, sub-rank curiosities, and rarely-collected outliers — the eccentric edge of the flora.',
        filters: { max_counties: 1 },
      },
      {
        slug: 'rare-fewer-than-five',
        label: 'Rare (≤ 5 counties)',
        short: 'Recorded in 5 or fewer counties.',
        description: 'A broader rarity slice: taxa known from five counties or fewer nationwide. Includes single-county endemics plus the next-most-restricted species.',
        filters: { max_counties: 5 },
      },
      {
        slug: 'widespread-natives',
        label: 'Widespread (100+ counties)',
        short: 'Native species recorded in 100+ counties.',
        description: 'Taxa with broad geographic ranges, recorded across at least 100 counties. The opposite of the rarities — generalists that show up almost anywhere.',
        filters: { min_counties: 100, nativity: 'Native' },
      },
    ],
  },
  {
    key: 'bloom',
    label: 'Bloom time',
    intro: 'When the flowers open. Useful for planning succession through the season.',
    lists: [
      {
        slug: 'early-spring-bloomers',
        label: 'Early spring',
        short: 'Bloom in early spring.',
        description: 'Species USDA tags as early-spring bloomers — the first flush before tree leaves fully emerge.',
        filters: { bloom_period: 'Early Spring' },
      },
      {
        slug: 'spring-bloomers',
        label: 'Spring',
        short: 'Bloom in spring (any phase).',
        description: 'Species blooming in early, mid, or late spring.',
        filters: { bloom_period: 'Early Spring,Mid Spring,Late Spring,Spring' },
      },
      {
        slug: 'summer-bloomers',
        label: 'Summer',
        short: 'Bloom in summer.',
        description: 'Species USDA tags as summer-flowering — early, mid, late, or generally "summer".',
        filters: { bloom_period: 'Early Summer,Mid Summer,Late Summer,Summer' },
      },
      {
        slug: 'fall-bloomers',
        label: 'Fall',
        short: 'Bloom in fall.',
        description: 'Late-season bloomers — species USDA flags as fall-flowering.',
        filters: { bloom_period: 'Fall' },
      },
      {
        slug: 'winter-bloomers',
        label: 'Winter',
        short: 'Bloom in winter or late winter.',
        description: 'A small but distinctive group of species that flower in winter or late winter — useful for keeping pollinator support active off-season.',
        filters: { bloom_period: 'Winter,Late Winter' },
      },
    ],
  },
  {
    key: 'flower-color',
    label: 'Flower color',
    intro: 'Recorded flower color from USDA characteristics.',
    lists: [
      { slug: 'yellow-flowers', label: 'Yellow', short: 'Yellow-flowered species.',  description: 'Species with yellow flowers per USDA.',  filters: { flower_color: 'Yellow' } },
      { slug: 'white-flowers',  label: 'White',  short: 'White-flowered species.',   description: 'Species with white flowers per USDA.',   filters: { flower_color: 'White'  } },
      { slug: 'purple-flowers', label: 'Purple', short: 'Purple-flowered species.',  description: 'Species with purple flowers per USDA.',  filters: { flower_color: 'Purple' } },
      { slug: 'red-flowers',    label: 'Red',    short: 'Red-flowered species.',     description: 'Species with red flowers per USDA.',     filters: { flower_color: 'Red'    } },
      { slug: 'blue-flowers',   label: 'Blue',   short: 'Blue-flowered species.',    description: 'Species with blue flowers per USDA.',    filters: { flower_color: 'Blue'   } },
      { slug: 'orange-flowers', label: 'Orange', short: 'Orange-flowered species.',  description: 'Species with orange flowers per USDA.',  filters: { flower_color: 'Orange' } },
    ],
  },
  {
    key: 'height',
    label: 'Mature height',
    intro: 'Practical size ranges for garden planning — groundcovers up to canopy trees.',
    lists: [
      {
        slug: 'groundcovers',
        label: 'Groundcovers (< 1 ft)',
        short: 'Plants staying under 1 foot at maturity.',
        description: 'Low-growing species — groundcovers, mat-formers, and low forbs that mature under a foot tall.',
        filters: { max_height_ft: 1 },
      },
      {
        slug: 'low-perennials',
        label: 'Low perennials (1–3 ft)',
        short: 'Plants 1 to 3 feet at maturity.',
        description: 'Knee-high perennials and small subshrubs — the workhorse layer for most native-plant borders.',
        filters: { min_height_ft: 1, max_height_ft: 3 },
      },
      {
        slug: 'shrubs-3-to-8-ft',
        label: 'Shrubs (3–8 ft)',
        short: 'Mid-sized shrubs and tall perennials.',
        description: 'Substantial shrubs and tall herbaceous species in the 3-to-8-foot range — hedging, screens, structural layer.',
        filters: { min_height_ft: 3, max_height_ft: 8 },
      },
      {
        slug: 'small-trees',
        label: 'Small trees (8–25 ft)',
        short: 'Understory and small ornamental trees.',
        description: 'Small trees suitable for understory plantings, courtyards, and tight urban sites where canopy species would overgrow.',
        filters: { min_height_ft: 8, max_height_ft: 25 },
      },
      {
        slug: 'canopy-trees',
        label: 'Canopy trees (25+ ft)',
        short: 'Full-sized trees, 25 feet and up.',
        description: 'The forest-canopy and shade-tree layer — full-grown trees over 25 feet at maturity.',
        filters: { min_height_ft: 25 },
      },
    ],
  },
];

/** Build a flat slug index for the dynamic route. */
export const EXPLORE_BY_SLUG: Record<string, ExploreList & { category: string; categoryLabel: string }> = (() => {
  const out: Record<string, ExploreList & { category: string; categoryLabel: string }> = {};
  for (const cat of EXPLORE_CATEGORIES) {
    for (const list of cat.lists) {
      out[list.slug] = { ...list, category: cat.key, categoryLabel: cat.label };
    }
  }
  return out;
})();
