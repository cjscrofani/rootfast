/**
 * US state and territory metadata.
 *
 * Used to render state names on pages where the API only returns the
 * 2-letter code (e.g., the county detail page).
 */

export const STATE_NAMES: Record<string, string> = {
  AL: 'Alabama',          AK: 'Alaska',
  AZ: 'Arizona',          AR: 'Arkansas',
  CA: 'California',       CO: 'Colorado',
  CT: 'Connecticut',      DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',          GA: 'Georgia',
  HI: 'Hawaii',           ID: 'Idaho',
  IL: 'Illinois',         IN: 'Indiana',
  IA: 'Iowa',             KS: 'Kansas',
  KY: 'Kentucky',         LA: 'Louisiana',
  ME: 'Maine',            MD: 'Maryland',
  MA: 'Massachusetts',    MI: 'Michigan',
  MN: 'Minnesota',        MS: 'Mississippi',
  MO: 'Missouri',         MT: 'Montana',
  NE: 'Nebraska',         NV: 'Nevada',
  NH: 'New Hampshire',    NJ: 'New Jersey',
  NM: 'New Mexico',       NY: 'New York',
  NC: 'North Carolina',   ND: 'North Dakota',
  OH: 'Ohio',             OK: 'Oklahoma',
  OR: 'Oregon',           PA: 'Pennsylvania',
  RI: 'Rhode Island',     SC: 'South Carolina',
  SD: 'South Dakota',     TN: 'Tennessee',
  TX: 'Texas',            UT: 'Utah',
  VT: 'Vermont',          VA: 'Virginia',
  WA: 'Washington',       WV: 'West Virginia',
  WI: 'Wisconsin',        WY: 'Wyoming',
  // Territories
  AS: 'American Samoa',
  GU: 'Guam',
  MP: 'Northern Mariana Islands',
  PR: 'Puerto Rico',
  VI: 'U.S. Virgin Islands',
};

export function stateNameOf(code: string): string {
  return STATE_NAMES[code.toUpperCase()] ?? code;
}

/** Geographic grouping for the state index. */
export const STATE_REGIONS: Record<string, string[]> = {
  'Northeast':     ['CT','ME','MA','NH','NJ','NY','PA','RI','VT'],
  'Mid-Atlantic':  ['DE','DC','MD','VA','WV'],
  'Southeast':     ['AL','AR','FL','GA','KY','LA','MS','NC','SC','TN'],
  'Midwest':       ['IL','IN','IA','KS','MI','MN','MO','NE','ND','OH','SD','WI'],
  'Southwest':     ['AZ','NM','OK','TX'],
  'Mountain West': ['CO','ID','MT','NV','UT','WY'],
  'Pacific':       ['AK','CA','HI','OR','WA'],
  'Territories':   ['AS','GU','MP','PR','VI'],
};

export function regionOf(code: string): string {
  for (const [region, codes] of Object.entries(STATE_REGIONS)) {
    if (codes.includes(code.toUpperCase())) return region;
  }
  return 'Other';
}

/* ----- URL slugs ---------------------------------------------------- */

/** Lowercase, dashes for non-alphanumeric runs, no leading/trailing dashes. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const _STATE_SLUG_TO_CODE: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [code, name] of Object.entries(STATE_NAMES)) {
    out[slugify(name)] = code;
  }
  return out;
})();

export function stateSlugOf(code: string): string {
  const name = STATE_NAMES[code.toUpperCase()];
  return name ? slugify(name) : code.toLowerCase();
}

/** Reverse: slug → state_code. Null if unknown. */
export function stateCodeOfSlug(slug: string): string | null {
  return _STATE_SLUG_TO_CODE[slug.toLowerCase()] ?? null;
}

/** Generates a county slug from a county_name. Within a state these are
 * (almost always) unique; on collision we suffix with -2, -3, etc. when
 * building the per-state slug index. */
export function slugifyCounty(name: string): string {
  return slugify(name);
}
