# Exploring the USDA PLANTS consolidated dataset

Output of `scripts/consolidate_usda_plants.py`, generated 2026-05-24.

## Files

- `data/raw/usda_plants/mt_plants_full.json` (102 MB) — every MT plant taxon
  (3,215 records keyed by USDA symbol) with **every** per-plant tab payload
  inlined. The raw exploration corpus.
- `data/raw/usda_plants/mt_plants_full.summary.json` — coverage stats.
- `data/raw/usda_plants/mt_plants_full.sample.LERE7.yaml` — Lewisia rediviva
  (MT state flower) as YAML. Low-coverage sample; only counties + classification.
- `data/raw/usda_plants/mt_plants_full.sample.PIPO.yaml` — Pinus ponderosa.
  High-coverage sample; shows what a full Characteristics tab looks like.

## Per-record shape

```yaml
usda_symbol: PIPO                   # primary key
plant_master_id: 23703              # USDA internal id (used for tab joins)
scientific_name: Pinus ponderosa Lawson & C. Lawson
common_name: ponderosa pine
other_common_names: [...]
family: Pinaceae Spreng. ex F. Rudolphi
rank: Species                       # Species | Subspecies | Variety
group: Gymnosperm
durations: [Perennial]
growth_habits: [Tree]
native_statuses:
  - {Region: L48, Status: N, Type: Native}
  - {Region: CAN, Status: N, Type: Native}
synonym_symbol: null
accepted_symbol: null
plant_notes:
  General_Notes: ...
  Synonym_Notes: ...
  ...
has_flags:                          # what data the API says exists
  HasCharacteristics: true
  HasWildlife: true
  HasPollinator: false              # USDA pollinator data is empty for nearly all MT plants
  ...
mt_counties:                        # list of {county_id, county_name, nativity}
  - {county_id: 211, county_name: Beaverhead, nativity: Native}
  - ...
tabs:                               # raw upstream payloads, present only if Has* flag was true
  classification: {...}             # full taxonomy with ancestor chain
  characteristics: [...]            # 82 entries for PIPO — see "Characteristics" below
  wildlife: {Food: [...], Cover: [...], Sources: [...]}
  wetland: [...]
  synonyms: [...]
  subordinate_taxa: [...]
  documentation: {DataSources: [...]}  # citations
  related_links: [...]
  legal_status: [...]
  invasive_status: [...]
  noxious_status: [...]
```

## Coverage at a glance

3,215 records (after filtering to actionable ranks: Species / Subspecies / Variety).

| Tab               | Plants with data | % of records | Notes                                              |
|-------------------|------------------|--------------|----------------------------------------------------|
| classification    | 3215             | 100%         | Always fetched. Full taxonomy ancestor chain.      |
| documentation     | 3215             | 100%         | Citations / data sources per plant.                |
| related_links     | 3197             | 99%          | Links to ITIS, Flora of NA, CalPhotos, etc.        |
| synonyms          | 1939             | 60%          | Taxonomic synonyms.                                |
| wetland           | 1312             | 41%          | Per-region wetland indicator (OBL/FACW/FAC/...).   |
| subordinate_taxa  | 800              | 25%          | Subspecies / varieties under each species.         |
| **characteristics** | **730**          | **23%**      | **The valuable one** — see below.                  |
| legal_status      | 364              | 11%          | State-level conservation status.                   |
| invasive_status   | 157              | 5%           | State invasive listings.                           |
| wildlife          | 130              | 4%           | Food/cover ratings for mammals + birds.            |
| noxious_status    | 43               | 1%           | State noxious weed listings.                       |
| ethnobotany       | 1                | 0%           | Effectively empty.                                 |
| **pollinator**    | **1**            | **0%**       | **Empty.** USDA does not populate this — Xerces still required for v1. |

## What's in the `characteristics` tab

Four categories, ~83 distinct attribute names. Every entry is
`{PlantCharacteristicName, PlantCharacteristicValue, PlantCharacteristicCategory, CultivarName, SynonymName}`.
When `CultivarName` is non-null, the row describes a cultivar — for v1 you can
filter to rows where `CultivarName is null` to get the wild-type values.

**Morphology / Physiology** (26 attributes):
Active Growth Period, Bloat, C:N Ratio, Coppice Potential, Fall Conspicuous,
Fire Resistant, Flower Color, Flower Conspicuous, Foliage Color, Foliage
Porosity (Summer/Winter), Foliage Texture, Fruit/Seed Color, Fruit/Seed
Conspicuous, Growth Form, Growth Rate, Height at 20 Years, Height Mature,
Known Allelopath, Leaf Retention, Lifespan, Low Growing Grass, Nitrogen
Fixation, Resprout Ability, Shape and Orientation, Toxicity.

**Growth Requirements** (22 attributes):
Adapted to Coarse/Fine/Medium Textured Soils, Anaerobic Tolerance, CaCO3
Tolerance, Cold Stratification Required, **Drought Tolerance**, Fertility
Requirement, **Fire Tolerance**, Frost Free Days Minimum, Hedge Tolerance,
**Moisture Use**, **pH (Min/Max)**, Planting Density per Acre, **Precipitation
(Min/Max)**, Root Depth Minimum, Salinity Tolerance, **Shade Tolerance**,
**Temperature Minimum (°F)**.

**Reproduction** (20 attributes):
**Bloom Period**, **Commercial Availability**, Fruit/Seed Abundance,
Fruit/Seed Period (Begin/End), Fruit/Seed Persistence, Propagated by Bare
Root / Bulb / Container / Corm / Cuttings / Seed / Sod / Sprigs / Tubers,
Seed per Pound, Seed Spread Rate, Seedling Vigor, Small Grain, Vegetative
Spread Rate.

**Suitability / Use** (15 attributes):
Berry/Nut/Seed Product, Christmas Tree Product, Fodder Product, Fuelwood
Product, Lumber Product, Naval Store Product, Nursery Stock Product,
Palatable Browse/Graze Animal, Palatable Human, Post Product, Protein
Potential, Pulpwood Product, Veneer Product.

## What this changes about v1 plans

1. **MSU Extension demoted from required to optional.** For the ~730 plants
   that have Characteristics, USDA already covers bloom period, drought /
   shade / fire tolerance, pH range, soil texture, precipitation envelope,
   temperature minimum, commercial availability, and propagation methods.
   MSU is now valuable for the 77% of plants USDA doesn't characterize, and
   for finer-grained gardening narrative.

2. **Hardiness zone can be partially derived from `Temperature, Minimum (°F)`.**
   That gives a per-plant cold-hardiness limit, which is what hardiness zones
   represent. (Hardiness *zone* still needs to come from a location, but the
   per-plant zone *fit* check is now data-driven, not heuristic.)

3. **Xerces stays critical.** USDA's PlantPollinator endpoint is essentially
   empty (1 plant). Any pollinator-value data for v1 must come from Xerces or
   another source. This is the single biggest missing piece.

4. **Wildlife tab is sparse but real.** 130 MT plants have it; the schema
   covers food + cover ratings for large mammals, small mammals, water birds,
   and terrestrial birds — directly usable for our "bird value" field.

## Quick exploration recipes

```bash
# Count plants by family
python3 -c "
import json
from collections import Counter
d = json.load(open('data/raw/usda_plants/mt_plants_full.json'))
print(Counter(p['family'] for p in d.values()).most_common(10))
"

# Find plants with the richest data
python3 -c "
import json
d = json.load(open('data/raw/usda_plants/mt_plants_full.json'))
ranked = sorted(d.items(), key=lambda kv: -len(kv[1]['tabs']))
for sym, rec in ranked[:10]:
    print(f'{sym:8} {rec[\"common_name\"] or \"\":30} tabs={len(rec[\"tabs\"])}')
"

# Find drought-tolerant native trees in Gallatin County (id 186)
python3 -c "
import json
d = json.load(open('data/raw/usda_plants/mt_plants_full.json'))
for sym, rec in d.items():
    if 186 not in {c['county_id'] for c in rec['mt_counties']}: continue
    if 'Tree' not in rec['growth_habits']: continue
    chars = rec.get('tabs', {}).get('characteristics', [])
    if any(c['PlantCharacteristicName']=='Drought Tolerance' and c['PlantCharacteristicValue']=='High' for c in chars):
        print(f'{sym:8} {rec[\"scientific_name\"]:50} ({rec[\"common_name\"]})')
"
```
