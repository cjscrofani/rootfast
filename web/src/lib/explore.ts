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
