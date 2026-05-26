/**
 * Typed client for the Rootfast API.
 *
 * The base URL is settable via the PUBLIC_API_BASE_URL env var so the site
 * can be repointed at a local Worker (http://localhost:8787) during dev.
 */

export const API_BASE: string =
  (import.meta.env.PUBLIC_API_BASE_URL as string | undefined) ??
  'https://api.rootfast.org';

/* ---------- Domain types -------------------------------------------- */

export interface Plant {
  id: number;
  usda_symbol: string;
  usda_plant_id: number | null;
  gbif_taxon_key: number | null;
  gbif_canonical_name: string | null;
  gbif_match_type: 'EXACT' | 'FUZZY' | 'HIGHERRANK' | 'NONE' | null;
  gbif_match_status: 'ACCEPTED' | 'SYNONYM' | 'DOUBTFUL' | null;
  gbif_match_confidence: number | null;
  itis_tsn: number | null;
  wikidata_qid: string | null;
  inaturalist_taxon_id: number | null;
  scientific_name: string;
  scientific_name_canonical: string;
  common_name: string | null;
  family: string | null;
  genus: string | null;
  taxonomic_group: string | null;
  rank: 'Species' | 'Subspecies' | 'Variety' | 'Form';
  is_synonym: 0 | 1;
  is_excluded: 0 | 1;
  accepted_plant_id: number | null;
  parent_plant_id: number | null;
  source_version: string;
  fetched_at: string;
}

export interface NativeStatus {
  region_code: string;
  status: 'Native' | 'Introduced' | 'Both' | 'Waif' | 'Unknown';
}

export type Nativity = 'Native' | 'Introduced' | 'Both';

/** USDA characteristics — every field is optional and may be null. */
export interface Characteristics {
  // Morphology / Physiology
  active_growth_period?: string | null;
  c_n_ratio?: string | null;
  bloat?: string | null;
  coppice_potential?: 0 | 1 | null;
  fall_conspicuous?: 0 | 1 | null;
  fire_resistant?: 0 | 1 | null;
  flower_color?: string | null;
  flower_conspicuous?: 0 | 1 | null;
  foliage_color?: string | null;
  foliage_porosity_summer?: string | null;
  foliage_porosity_winter?: string | null;
  foliage_texture?: string | null;
  fruit_color?: string | null;
  fruit_conspicuous?: 0 | 1 | null;
  growth_form?: string | null;
  growth_rate?: string | null;
  height_at_20_years_max_ft?: number | null;
  height_mature_ft?: number | null;
  known_allelopath?: 0 | 1 | null;
  leaf_retention?: 0 | 1 | null;
  lifespan?: string | null;
  low_growing_grass?: 0 | 1 | null;
  nitrogen_fixation?: string | null;
  resprout_ability?: 0 | 1 | null;
  shape_and_orientation?: string | null;
  toxicity?: string | null;

  // Growth Requirements
  adapted_to_coarse_textured_soils?: 0 | 1 | null;
  adapted_to_medium_textured_soils?: 0 | 1 | null;
  adapted_to_fine_textured_soils?: 0 | 1 | null;
  anaerobic_tolerance?: string | null;
  caco3_tolerance?: string | null;
  cold_stratification_required?: 0 | 1 | null;
  drought_tolerance?: string | null;
  fertility_requirement?: string | null;
  fire_tolerance?: string | null;
  frost_free_days_min?: number | null;
  hedge_tolerance?: string | null;
  moisture_use?: string | null;
  ph_min?: number | null;
  ph_max?: number | null;
  planting_density_min_per_acre?: number | null;
  planting_density_max_per_acre?: number | null;
  precipitation_min_in?: number | null;
  precipitation_max_in?: number | null;
  root_depth_min_in?: number | null;
  salinity_tolerance?: string | null;
  shade_tolerance?: string | null;
  temperature_min_f?: number | null;

  // Reproduction
  bloom_period?: string | null;
  commercial_availability?: string | null;
  fruit_seed_abundance?: string | null;
  fruit_seed_period_begin?: string | null;
  fruit_seed_period_end?: string | null;
  fruit_seed_persistence?: 0 | 1 | null;
  propagated_by_bare_root?: 0 | 1 | null;
  propagated_by_bulb?: 0 | 1 | null;
  propagated_by_container?: 0 | 1 | null;
  propagated_by_corm?: 0 | 1 | null;
  propagated_by_cuttings?: 0 | 1 | null;
  propagated_by_seed?: 0 | 1 | null;
  propagated_by_sod?: 0 | 1 | null;
  propagated_by_sprigs?: 0 | 1 | null;
  propagated_by_tubers?: 0 | 1 | null;
  seed_per_pound?: number | null;
  seed_spread_rate?: string | null;
  seedling_vigor?: string | null;
  small_grain?: 0 | 1 | null;
  vegetative_spread_rate?: string | null;

  // Suitability / Use
  berry_nut_seed_product?: 0 | 1 | null;
  christmas_tree_product?: 0 | 1 | null;
  fodder_product?: 0 | 1 | null;
  fuelwood_product?: string | null;
  lumber_product?: 0 | 1 | null;
  naval_store_product?: 0 | 1 | null;
  nursery_stock_product?: 0 | 1 | null;
  palatable_browse_animal?: string | null;
  palatable_graze_animal?: string | null;
  palatable_human?: 0 | 1 | null;
  post_product?: 0 | 1 | null;
  protein_potential?: string | null;
  pulpwood_product?: 0 | 1 | null;
  veneer_product?: 0 | 1 | null;

  // Allow any extra keys returned by the API without TS complaint
  [key: string]: number | string | null | undefined;
}

export interface CountyPresence {
  county_fips: string;
  county_name: string;
  state_code: string;
  nativity: Nativity;
}

export interface Photo {
  source: string | null;
  source_id: number | null;
  taxon_id: number | null;
  url: string | null;
  thumb_url: string | null;
  license: string | null;
  attribution: string | null;
}

export interface PlantDetail {
  plant: Plant;
  photo: Photo | null;
  growth_habits: string[];
  durations: string[];
  native_status: NativeStatus[];
  characteristics: Characteristics | null;
  counties: CountyPresence[];
}

export interface StateHeader {
  state_code: string;
  state_name: string;
  state_fips: string | null;
  country: string;
}

export interface StateSummary extends StateHeader {
  county_count: number;
  taxa_count: number;
}

export interface CountyHeader {
  county_fips: string;
  county_name: string;
  state_code: string;
}

export interface CountySummary extends CountyHeader {
  centroid_lat: number | null;
  centroid_lon: number | null;
  taxa_count: number;
}

export interface PlantInStateRow {
  usda_symbol: string;
  scientific_name: string;
  common_name: string | null;
  family: string | null;
  photo_thumb_url: string | null;
  county_count: number;
  native_counties: number;
  introduced_counties: number;
  both_counties: number;
  nativity: Nativity;
}

export interface StatePlantsResponse {
  state: StateHeader;
  counts: { taxa: number; counties: number };
  paging?: { limit: number; offset: number; count: number; has_more: boolean };
  plants: PlantInStateRow[];
}

export interface CountiesListResponse {
  count: number;
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
  counties: CountySummary[];
}

export interface PlantInListRow {
  usda_symbol: string;
  scientific_name: string;
  scientific_name_canonical: string;
  common_name: string | null;
  family: string | null;
  genus: string | null;
  rank: 'Species' | 'Subspecies' | 'Variety' | 'Form';
  gbif_taxon_key: number | null;
  photo_url: string | null;
  photo_thumb_url: string | null;
  photo_license: string | null;
}

export interface PlantsListResponse {
  count: number;
  total: number;
  paging: { limit: number; offset: number; has_more: boolean };
  filters: Record<string, string> | null;
  plants: PlantInListRow[];
}

export interface PlantRandomResponse {
  plant: {
    usda_symbol: string;
    scientific_name: string;
    common_name: string | null;
    family: string | null;
    photo_thumb_url: string | null;
    photo_url: string | null;
  };
}

export interface StateCountiesResponse {
  state: StateHeader;
  count: number;
  counties: CountySummary[];
}

export interface StatesListResponse {
  count: number;
  states: StateSummary[];
}

export interface PlantInCountyRow {
  usda_symbol: string;
  scientific_name: string;
  common_name: string | null;
  family: string | null;
  nativity: Nativity;
  photo_thumb_url?: string | null;
  photo_license?: string | null;
}

export interface CountyPlantsResponse {
  county: CountyHeader;
  count: number;
  plants: PlantInCountyRow[];
}

export interface SearchHit {
  usda_symbol: string;
  scientific_name: string;
  common_name: string | null;
  family: string | null;
  photo_thumb_url?: string | null;
}

export interface SearchResponse {
  query: string;
  results: SearchHit[];
}

export interface HealthResponse {
  ok: boolean;
  dataset_version: string;
  schema_version: string | null;
}

/* ---------- Fetch helpers ------------------------------------------- */

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    throw new ApiError(res.status, `GET ${path} → ${res.status}`);
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export const api = {
  health: () => getJson<HealthResponse>('/healthz'),
  plant:  (symbol: string) =>
    getJson<PlantDetail>(`/v1/plants/${encodeURIComponent(symbol.toUpperCase())}`),
  plantRandom: () =>
    getJson<PlantRandomResponse>('/v1/plants/random'),
  /** /v1/plants — flat list, supports the §F filter params and limit/offset. */
  plants: (opts?: Record<string, string | number | undefined>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts ?? {})) {
      if (v === undefined || v === null || v === '') continue;
      qs.set(k, String(v));
    }
    const q = qs.toString();
    return getJson<PlantsListResponse>(`/v1/plants${q ? `?${q}` : ''}`);
  },
  counties: (opts?: { state?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (opts?.state)  qs.set('state',  opts.state.toUpperCase());
    if (opts?.limit  !== undefined) qs.set('limit',  String(opts.limit));
    if (opts?.offset !== undefined) qs.set('offset', String(opts.offset));
    const q = qs.toString();
    return getJson<CountiesListResponse>(`/v1/counties${q ? `?${q}` : ''}`);
  },
  county: (fips: string, opts?: { limit?: number; offset?: number; nativity?: string; sort?: string }) => {
    const qs = new URLSearchParams();
    if (opts?.limit  !== undefined) qs.set('limit',  String(opts.limit));
    if (opts?.offset !== undefined) qs.set('offset', String(opts.offset));
    if (opts?.nativity) qs.set('nativity', opts.nativity);
    if (opts?.sort)     qs.set('sort',     opts.sort);
    const q = qs.toString();
    return getJson<CountyPlantsResponse>(
      `/v1/counties/${encodeURIComponent(fips)}/plants${q ? `?${q}` : ''}`
    );
  },
  states: () => getJson<StatesListResponse>('/v1/states'),
  state:  (code: string) =>
    getJson<{ state: StateSummary }>(`/v1/states/${encodeURIComponent(code.toUpperCase())}`),
  statePlants:   (code: string, opts?: { limit?: number; offset?: number; nativity?: string; sort?: string }) => {
    const qs = new URLSearchParams();
    if (opts?.limit  !== undefined) qs.set('limit',  String(opts.limit));
    if (opts?.offset !== undefined) qs.set('offset', String(opts.offset));
    if (opts?.nativity) qs.set('nativity', opts.nativity);
    if (opts?.sort)     qs.set('sort',     opts.sort);
    const q = qs.toString();
    return getJson<StatePlantsResponse>(
      `/v1/states/${encodeURIComponent(code.toUpperCase())}/plants${q ? `?${q}` : ''}`
    );
  },
  stateCounties: (code: string) =>
    getJson<StateCountiesResponse>(`/v1/states/${encodeURIComponent(code.toUpperCase())}/counties`),
  search: (q: string) =>
    getJson<SearchResponse>(`/v1/search?q=${encodeURIComponent(q)}`),
};
