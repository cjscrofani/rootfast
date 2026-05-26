# Example species: `JUCO6` — *Juniperus communis L.* (common juniper)

This file shows **every data point** rootfast has on one species across all
ingested sources, with provenance. It is a snapshot of the *available* data;
only a subset is currently surfaced through the built `data/processed/plants.json`.

Sources cited per row use these short keys:

- `usda:profile` — USDA PLANTS PlantProfile response
- `usda:characteristics` — USDA PLANTS PlantCharacteristics tab
- `usda:wildlife` — USDA PLANTS PlantWildlife tab
- `usda:wetland` — USDA PLANTS PlantWetland tab
- `usda:synonyms` / `usda:subordinate_taxa` — USDA taxonomic relations
- `usda:legal_status` / `usda:invasive_status` / `usda:noxious_status` — USDA status tabs
- `usda:classification` — USDA classification ancestor chain
- `usda:documentation` / `usda:related_links` — USDA citation + external links
- `usda:mapserver` — USDA PLANTS ArcGIS MapServer (county-level distribution)
- `usda_hardiness:2023` — USDA 2023 Plant Hardiness Zone Map (FeatureServer)
- `mt_field_guide` — fieldguide.mt.gov species page (`#gen`, `#habt`, etc.)
- `mt_field_guide:obs_chart` — monthly observation counts (phenology proxy)
- `derived` — computed field (e.g. observation-peak month, zone from min temp)

## 1. Identification

| Field | Value | Source |
|---|---|---|
| USDA symbol | JUCO6 | usda:profile |
| Scientific name | Juniperus communis L. | usda:profile |
| Common name | common juniper | usda:profile |
| Other common names | — | usda:profile |
| Family | Cupressaceae Gray | usda:profile |
| Group | Gymnosperm | usda:profile |
| Rank | Species | usda:profile |
| Plant master id | 15168 | usda:profile |
| Field Guide ELCODE | PGCUP050N0 | mt_field_guide |
| USDA crosswalk via | direct | derived |
| Accepted symbol | (this taxon is the accepted name) | usda:profile |
| Synonym symbol | — | usda:profile |
| Durations | Perennial | usda:profile |
| Growth habits | Shrub, Tree | usda:profile |

## 2. Taxonomy (ancestor chain)

| Rank | Name |
|---|---|
| Division | *Coniferophyta* |
| Family | *Cupressaceae Gray* |
| Genus | *Juniperus L.* |
| Species | *Juniperus communis L.* |
| Order | *Pinales* |
| Class | *Pinopsida* |
| Kingdom | *Plantae* |
| Superdivision | *Spermatophyta* |
| Subkingdom | *Tracheobionta* |
| **Species** | ***Juniperus communis L.*** |

_Subordinate taxa (5):_  `JUCOC4` *Juniperus communis L. var. charlottensis R.P. Adams*, `JUCOC3` *Juniperus communis L. var. communis L. [excluded]*, `JUCOD` *Juniperus communis L. var. depressa Pursh*, `JUCOM` *Juniperus communis L. var. megistocarpa Fernald & H. St. John*, `JUCOM2` *Juniperus communis L. var. montana Aiton*

## 3. Native status (regional)

| Region | Status | Type |
|---|---|---|
| AK | N | Native |
| CAN | N | Native |
| GL | N | Native |
| L48 | N | Native |
| SPM | N | Native |

Regions: AK=Alaska, CAN=Canada, GL=Greenland, HI=Hawaii, L48=Lower 48, PB=Pacific Basin, PR=Puerto Rico, SPM=St. Pierre & Miquelon, VI=US Virgin Is.

## 4. Montana county presence

Recorded in **28 of 56** Montana counties.
Per-county hardiness zone is joined from the USDA 2023 hardiness map.

| FIPS | County | Nativity | County hardiness zone |
|---|---|---|---|
| 30007 | Broadwater | Native | 4b |
| 30011 | Carter | Native | 4a |
| 30013 | Cascade | Native | 4a |
| 30021 | Dawson | Native | 4a |
| 30025 | Fallon | Native | 4a |
| 30027 | Fergus | Native | 4b |
| 30029 | Flathead | Native | 4b |
| 30031 | Gallatin | Native | 5a |
| 30033 | Garfield | Native | 4a |
| 30035 | Glacier | Native | 4a |
| 30037 | Golden Valley | Native | 4b |
| 30041 | Hill | Native | 4a |
| 30043 | Jefferson | Native | 4b |
| 30045 | Judith Basin | Native | 4a |
| 30049 | Lewis and Clark | Native | 4b |
| 30053 | Lincoln | Native | 5a |
| 30063 | Missoula | Native | 6a |
| 30067 | Park | Native | 5a |
| 30071 | Phillips | Native | 3b |
| 30075 | Powder River | Native | 4a |
| 30083 | Richland | Native | 3b |
| 30085 | Roosevelt | Native | 3b |
| 30091 | Sheridan | Native | 3b |
| 30095 | Stillwater | Native | 4b |
| 30099 | Teton | Native | 4a |
| 30101 | Toole | Native | 4a |
| 30105 | Valley | Native | 4a |
| 30107 | Wheatland | Native | 4a |

_Source: `usda:mapserver` for presence + nativity; `usda_hardiness:2023` for zones._

## 5. Cultivation characteristics (USDA)

Wild-type values only (cultivar rows excluded).

### 5.1 Morphology/Physiology

| Attribute | Value | Source |
|---|---|---|
| Active Growth Period | Spring and Summer | usda:characteristics |
| Bloat | None | usda:characteristics |
| C:N Ratio | High | usda:characteristics |
| Coppice Potential | No | usda:characteristics |
| Fall Conspicuous | No | usda:characteristics |
| Fire Resistant | No | usda:characteristics |
| Flower Color | Yellow | usda:characteristics |
| Flower Conspicuous | No | usda:characteristics |
| Foliage Color | Green | usda:characteristics |
| Foliage Porosity Summer | Dense | usda:characteristics |
| Foliage Porosity Winter | Dense | usda:characteristics |
| Foliage Texture | Medium | usda:characteristics |
| Fruit/Seed Color | Blue | usda:characteristics |
| Fruit/Seed Conspicuous | Yes | usda:characteristics |
| Growth Form | Single Stem | usda:characteristics |
| Growth Rate | Slow | usda:characteristics |
| Height at 20 Years, Maximum (feet) | 5 | usda:characteristics |
| Height, Mature (feet) | 10.0 | usda:characteristics |
| Known Allelopath | Yes | usda:characteristics |
| Leaf Retention | Yes | usda:characteristics |
| Lifespan | Long | usda:characteristics |
| Low Growing Grass | No | usda:characteristics |
| Nitrogen Fixation | None | usda:characteristics |
| Resprout Ability | No | usda:characteristics |
| Shape and Orientation | Semi-Erect | usda:characteristics |
| Toxicity | None | usda:characteristics |

### 5.2 Growth Requirements

| Attribute | Value | Source |
|---|---|---|
| Adapted to Coarse Textured Soils | Yes | usda:characteristics |
| Adapted to Fine Textured Soils | Yes | usda:characteristics |
| Adapted to Medium Textured Soils | Yes | usda:characteristics |
| Anaerobic Tolerance | None | usda:characteristics |
| CaCO3 Tolerance | High | usda:characteristics |
| Cold Stratification Required | Yes | usda:characteristics |
| Drought Tolerance | High | usda:characteristics |
| Fertility Requirement | Low | usda:characteristics |
| Fire Tolerance | Low | usda:characteristics |
| Frost Free Days, Minimum | 90 | usda:characteristics |
| Hedge Tolerance | Medium | usda:characteristics |
| Moisture Use | Low | usda:characteristics |
| Planting Density per Acre, Maximum | 2200 | usda:characteristics |
| Planting Density per Acre, Minimum | 700 | usda:characteristics |
| Precipitation, Maximum | 60 | usda:characteristics |
| Precipitation, Minimum | 20 | usda:characteristics |
| Root Depth, Minimum (inches) | 14 | usda:characteristics |
| Salinity Tolerance | Medium | usda:characteristics |
| Shade Tolerance | High | usda:characteristics |
| Temperature, Minimum (°F) | -43 | usda:characteristics |
| pH, Maximum | 8.0 | usda:characteristics |
| pH, Minimum | 5.5 | usda:characteristics |

### 5.3 Reproduction

| Attribute | Value | Source |
|---|---|---|
| Bloom Period | Mid Spring | usda:characteristics |
| Commercial Availability | Routinely Available | usda:characteristics |
| Fruit/Seed Abundance | Medium | usda:characteristics |
| Fruit/Seed Period Begin | Summer | usda:characteristics |
| Fruit/Seed Period End | Fall | usda:characteristics |
| Fruit/Seed Persistence | Yes | usda:characteristics |
| Propagated by Bare Root | Yes | usda:characteristics |
| Propagated by Bulb | No | usda:characteristics |
| Propagated by Container | Yes | usda:characteristics |
| Propagated by Corm | No | usda:characteristics |
| Propagated by Cuttings | No | usda:characteristics |
| Propagated by Seed | Yes | usda:characteristics |
| Propagated by Sod | No | usda:characteristics |
| Propagated by Sprigs | No | usda:characteristics |
| Propagated by Tubers | No | usda:characteristics |
| Seed Spread Rate | Slow | usda:characteristics |
| Seed per Pound | 40363 | usda:characteristics |
| Seedling Vigor | Low | usda:characteristics |
| Small Grain | No | usda:characteristics |
| Vegetative Spread Rate | None | usda:characteristics |

### 5.4 Suitability/Use

| Attribute | Value | Source |
|---|---|---|
| Berry/Nut/Seed Product | No | usda:characteristics |
| Christmas Tree Product | No | usda:characteristics |
| Fodder Product | No | usda:characteristics |
| Lumber Product | No | usda:characteristics |
| Naval Store Product | No | usda:characteristics |
| Nursery Stock Product | Yes | usda:characteristics |
| Palatable Browse Animal | Low | usda:characteristics |
| Palatable Graze Animal | Low | usda:characteristics |
| Palatable Human | No | usda:characteristics |
| Post Product | No | usda:characteristics |
| Protein Potential | Low | usda:characteristics |
| Pulpwood Product | No | usda:characteristics |
| Veneer Product | No | usda:characteristics |

## 6. Wildlife value

### 6.1 Food value

| Source ref | Large mammals | Small mammals | Water birds | Terrestrial birds |
|---|---|---|---|---|
| Quinlan | — | — | — | Low |

### 6.2 Cover value

| Source ref | Large mammals | Small mammals | Water birds | Terrestrial birds |
|---|---|---|---|---|
| Quinlan | — | — | — | Moderate |

_Source: `usda:wildlife`._

## 7. Wetland indicator (USDA regional)

| Region | Sub-region | Code |
|---|---|---|
| Arid West | — | FACU |
| Atlantic and Gulf Coastal Plain | — | FACU |
| Eastern Mountains and Piedmont | — | FACU |
| Northcentral & Northeast | — | FACU |
| Western Mountains, Valleys, and Coast | — | UPL |
| Alaska | — | UPL |
| Great Plains | — | UPL |
| Midwest | — | UPL |

Codes: OBL=Obligate Wetland, FACW=Facultative Wetland, FAC=Facultative, FACU=Facultative Upland, UPL=Obligate Upland, NL=Not Listed.

_Source: `usda:wetland`._

## 8. Pollinator value

_USDA `HasPollinator` is `false` for this species. Xerces Society Rocky
Mountains list is the natural fill-in but ingestion is **backlogged**
pending permission (Xerces publications are © All Rights Reserved)._

## 9. Conservation / regulatory status

### 9.1 Legal / conservation status (per state)

| State / locality | Statuses |
|---|---|
| Alabama | {LocalityRank=1} |

_(no `invasive_status` data)_

_(no `noxious_status` data)_

## 10. Field Guide narrative (MT Natural Heritage)

| Field | Value | Source |
|---|---|---|
| ELCODE | PGCUP050N0 | mt_field_guide |
| Scientific name (FG) | Juniperus communis | mt_field_guide |
| Common name (FG title) | — | mt_field_guide |
| Distribution header | Montana Range Range Descriptions Native | mt_field_guide |
| General description (truncated) | Rounded shrub with prostrate to erect stems up to 1 m. Bark brown, fibrous. Leaves stiff, needle-like, 5–20 mm long, whitish on lower surface, in whorls of 3, jointed where they meet the stem. Seed cones maturing in 2 years, bluish-black, 4–7 mm long, seeds 2 to 3 ( Lesica et al.… | mt_field_guide |
| Habitat narrative | Drier forests, forest margins, open slopes, outcrops and rock slides at all but the highest elevations ( Lesica et al. 2012. Manual of Montana Vascular Plants. BRIT Press. Fort Worth, TX ). | mt_field_guide |

### 10.1 MT range statistics

| Statistic | Value |
|---|---|
| Range MT Pct | 100% |
| Suitable MT Pct | 57% |
| Suitable Range Pct | 57% |
| Total Range Acres | 93,692,325 |
| Total Range km2 | 379,168 |
| Total Suitable Acres | 53,753,486 |
| Total Suitable km2 | 217,537 |

### 10.2 Range by land owner

| Owner | Classes |
|---|---|
| Federal | Total Suitable=45%; Optimal Suitability=1%; Moderate Suitability=26%; Low Suitability=18% |
| State | Total Suitable=6%; Optimal Suitability=<1%; Moderate Suitability=2%; Low Suitability=4% |
| Local | Total Suitable=<1%; Optimal Suitability=<1%; Moderate Suitability=<1%; Low Suitability=<1% |
| Conservation Lands/Easements | Total Suitable=5%; Optimal Suitability=<1%; Moderate Suitability=2%; Low Suitability=3% |
| Private/Tribal/Unknown | Total Suitable=45%; Optimal Suitability=<1%; Moderate Suitability=13%; Low Suitability=32% |


## 11. Phenology (citizen observations by month)

| Month | Observations | Bar |
|---|---:|---|
| Jan | 19 | `` |
| Feb | 1 | `` |
| Mar | 14 | `` |
| Apr | 36 | `` |
| May | 176 | `##` |
| Jun | 746 | `############` |
| Jul | 1108 | `##################` |
| Aug | 1188 | `####################` |
| Sep | 514 | `########` |
| Oct | 174 | `##` |
| Nov | 18 | `` |
| Dec | 10 | `` |
| **Total** | **4004** | |

_Derived bloom proxy (peak observation month): **month 8** — LOW confidence. Source: `derived` from `mt_field_guide:obs_chart`._

## 12. Hardiness zone fit (per-species)

| Field | Value | Source |
|---|---|---|
| Temperature, Minimum (°F) | -43 | usda:characteristics |
| Hardiest zone this species tolerates | 2b | derived |

_Plant will likely survive in zones at or warmer than this derived zone._

## 13. Curated notes from USDA

_(all PlantNotes fields are empty for this species)_

## 14. Citations & external links

### 14.1 Related links (10 entries)

| Link text | URL |
|---|---|
| MN-University of Minnesota Vascular Plant Collection (JUCO6) | <http://www.wildflowers.umn.edu> |
| ARS Germplasm Resources Information Network (JUCO6) | <https://npgsweb.ars-grin.gov/gringlobal/taxon/taxonomysearch> |
| CalPhotos (JUCO6) | <http://calphotos.berkeley.edu/cgi/img_query?query_src=photos_index&where-taxon=Juniperus+communis> |
| Flora of North America (JUCO6) | <http://www.efloras.org/florataxon.aspx?flora_id=1&taxon_id=200005424> |
| Integrated Taxonomic Information System (JUCO6) | <http://www.itis.gov/servlet/SingleRpt/SingleRpt?search_topic=TSN&search_value=194820> |
| Jepson Interchange (University of California - Berkeley) (JUCO6) | <http://ucjeps.berkeley.edu/cgi-bin/get_cpn.pl?JUCO6> |
| Lady Bird Johnson Wildflower Center Native Plant Information Network (JUCO6) | <http://www.wildflower.org/plants/result.php?id_plant=JUCO6> |
| Native American Ethnobotany (University of Michigan - Dearborn) (JUCO6) | <http://herb.umd.umich.edu/herb/search.pl?searchstring=Juniperus+communis> |
| Native Plants Network (JUCO6) | <http://www.nativeplantnetwork.org/network/ViewProtocols.aspx?ProtocolID=66,897> |
| USDA Forest Service Fire Effects Information System (JUCO6) | <http://www.fs.fed.us/database/feis/plants/shrub/juncom/all.html> |

### 14.2 USDA documentation / data sources (25 entries)

- 1971. Journal of the Elisha Mitchell Scientific Society.   _[Distribution, Connecticut, Indiana, Maine, Massachusetts, New Hampshire, New Jersey, Ohio, Rhode Island, Vermont, West Virginia]_
- 1986. Douglasia.   _[Distribution, Washington]_
- 1999. University of Minnesota Herbarium: Vascular plant collection.   _[Distribution, Minnesota]_
- 2000. CalFlora: Information on California plants for education, research and conservation. The CalFlora Database, Berkeley.   _[Distribution, California]_
- Adams, R.P. 2008. Taxonomy of Juniperus communis in North America: Insight from variation in nrDNA SNPs. Phytologia. 90.  _[Distribution, Alaska, British Columbia]_
- Alabama Natural Heritage Program. Alabama Natural Heritage Program.   _[Distribution, Alabama]_
- Alt 9 (ALA 00023996). Specimen at University of Alaska Museum, Fairbanks, Alaska.  _[Distribution, Alaska]_
- Anderson & Gasser 7196 (ALA 00000125). Specimen at University of Alaska Museum, Fairbanks, Alaska.  _[Distribution, Alaska]_
- _… 17 more_

### 14.3 Field Guide citations (57 entries)

- Literature Cited Above Legend: View Online Publication Lesica, P., M.T. Lavin, and P.F. Stickney. 2012. Manual of Montana Vascular Plants. Fort Worth, TX: BRIT Press. viii + 771 p. McGregor, R.L. (coordinator), T.M. Barkley, R.E. Brooks, and E.K. Schofield (eds). 1986. Flora of the Great Plains: Great Plains Flora Association. Lawrence, KS: Univ. Press Kansas. 1392 pp.
- Lesica, P., M.T. Lavin, and P.F. Stickney. 2012. Manual of Montana Vascular Plants. Fort Worth, TX: BRIT Press. viii + 771 p.
- McGregor, R.L. (coordinator), T.M. Barkley, R.E. Brooks, and E.K. Schofield (eds). 1986. Flora of the Great Plains: Great Plains Flora Association. Lawrence, KS: Univ. Press Kansas. 1392 pp.
- Additional References Legend: View Online Publication Do you know of a citation we're missing? Adhikari, S. 2018. Impacts of dryland farming systems on biodiversity, plant-insect interactions, and ecosystem services. Ph.D. Dissertation. Bozeman, MT: Montana State University. 207 p. Aho, Ken Andrew. 2006. Alpine and Cliff Ecosystems in the North-Central Rocky Mountains. Ph.D. Dissertation. Bozeman,
- Adhikari, S. 2018. Impacts of dryland farming systems on biodiversity, plant-insect interactions, and ecosystem services. Ph.D. Dissertation. Bozeman, MT: Montana State University. 207 p.
- Aho, Ken Andrew. 2006. Alpine and Cliff Ecosystems in the North-Central Rocky Mountains. Ph.D. Dissertation. Bozeman, Montana: Montana State University. 343 p.
- Aradottir, A.L. 1984. Ammonia volatilization from native grasslands and forests of SW Montana. M.Sc. Thesis. Bozeman, MT: Montana State University. 48 p.
- Clark, D. 1991. The effect of fire on Yellowstone ecosystem seed banks. M.Sc. Thesis. Montana State University, Bozeman. 115 pp.
- _… 49 more_

## 15. Provenance summary

| Source | Available for this species? | Has* flag |
|---|---|---|
| `usda:profile` | ✅ yes |  |
| `usda:characteristics` | ✅ yes | true |
| `usda:wildlife` | ✅ yes | true |
| `usda:wetland` | ✅ yes | true |
| `usda:pollinator` | ❌ no | false |
| `usda:synonyms` | ❌ no | false |
| `usda:subordinate_taxa` | ✅ yes | true |
| `usda:legal_status` | ✅ yes | true |
| `usda:invasive_status` | ❌ no | false |
| `usda:noxious_status` | ❌ no | false |
| `usda:ethnobotany` | ❌ no | false |
| `usda:classification` | ✅ yes |  |
| `usda:related_links` | ✅ yes | true |
| `usda:documentation` | ✅ yes | true |
| `usda:mapserver` | ✅ yes |  |
| `usda_hardiness:2023` | ✅ yes |  |
| `mt_field_guide` | ✅ yes |  |
| `mt_field_guide:obs_chart` | ✅ yes |  |
| `xerces` | ❌ no |  |
