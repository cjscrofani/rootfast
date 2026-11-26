/**
 * One source of truth for the headline numbers the site prints (home, about,
 * docs). They come from /healthz at build time — the API reads them from the
 * schema_meta table the data build stamps — so pages can't drift from the
 * data or from each other. The fallbacks only matter when the API is
 * unreachable during a build; keep them in step with the latest release.
 */
import { api, type HealthResponse } from '@/lib/api';

export interface DatasetStats {
  taxa: number;
  states: number;
  /** Rows in the states table, i.e. the denominator for "N of M". */
  statesTotal: number;
  counties: number;
  distributionRecords: number;
  photos: number;
  hardinessZips: number;
  hardinessCounties: number;
  zipCounties: number;
  datasetVersion: string;
  datasetDate: string;
  schemaVersion: string;
  apiVersion: string;
  usdaPulled: string;
  live: boolean;
}

export const FALLBACK_STATS: DatasetStats = {
  taxa: 27_678,
  states: 55,
  statesTotal: 56,
  counties: 3_230,
  distributionRecords: 2_501_631,
  photos: 26_125,
  hardinessZips: 40_502,
  hardinessCounties: 3_199,
  zipCounties: 33_478,
  datasetVersion: '2026.05',
  datasetDate: '2026-05-26',
  schemaVersion: '008',
  apiVersion: '1.2.0',
  usdaPulled: '2026-05-26',
  live: false,
};

export function statsFromHealth(h: HealthResponse | null): DatasetStats {
  if (!h) return FALLBACK_STATS;
  const c = h.counts ?? ({} as NonNullable<HealthResponse['counts']>);
  const n = (v: number | null | undefined, fb: number) => (typeof v === 'number' && v > 0 ? v : fb);
  return {
    taxa:                n(c.taxa,                 FALLBACK_STATS.taxa),
    states:              n(c.states,               FALLBACK_STATS.states),
    statesTotal:         FALLBACK_STATS.statesTotal,
    counties:            n(c.counties,             FALLBACK_STATS.counties),
    distributionRecords: n(c.distribution_records, FALLBACK_STATS.distributionRecords),
    photos:              n(c.photos,               FALLBACK_STATS.photos),
    hardinessZips:       n(c.hardiness_zips,       FALLBACK_STATS.hardinessZips),
    hardinessCounties:   n(c.hardiness_counties,   FALLBACK_STATS.hardinessCounties),
    zipCounties:         n(c.zip_counties,         FALLBACK_STATS.zipCounties),
    datasetVersion:      h.dataset_version || FALLBACK_STATS.datasetVersion,
    datasetDate:         h.dataset_date || h.sources?.usda_plants_pulled || FALLBACK_STATS.datasetDate,
    schemaVersion:       h.schema_version || FALLBACK_STATS.schemaVersion,
    apiVersion:          h.api_version || FALLBACK_STATS.apiVersion,
    usdaPulled:          h.sources?.usda_plants_pulled || FALLBACK_STATS.usdaPulled,
    live: true,
  };
}

/** Fetch /healthz and fold it over the fallbacks. Never throws. */
export async function datasetStats(): Promise<DatasetStats> {
  try {
    return statsFromHealth(await api.health());
  } catch {
    return FALLBACK_STATS;
  }
}

export const fmt = (n: number) => n.toLocaleString('en-US');
export const pct = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`;
