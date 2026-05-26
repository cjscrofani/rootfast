# Example species: `PIPO` — *Pinus ponderosa Lawson & C. Lawson* (ponderosa pine)

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
| USDA symbol | PIPO | usda:profile |
| Scientific name | Pinus ponderosa Lawson & C. Lawson | usda:profile |
| Common name | ponderosa pine | usda:profile |
| Other common names | — | usda:profile |
| Family | Pinaceae Spreng. ex Rudolphi | usda:profile |
| Group | Gymnosperm | usda:profile |
| Rank | Species | usda:profile |
| Plant master id | 15527 | usda:profile |
| Field Guide ELCODE | PGPIN040S0 | mt_field_guide |
| USDA crosswalk via | direct | derived |
| Accepted symbol | (this taxon is the accepted name) | usda:profile |
| Synonym symbol | — | usda:profile |
| Durations | Perennial | usda:profile |
| Growth habits | Tree | usda:profile |

## 2. Taxonomy (ancestor chain)

| Rank | Name |
|---|---|
| Division | *Coniferophyta* |
| Family | *Pinaceae Spreng. ex Rudolphi* |
| Order | *Pinales* |
| Class | *Pinopsida* |
| Genus | *Pinus L.* |
| Species | *Pinus ponderosa Lawson & C. Lawson* |
| Kingdom | *Plantae* |
| Superdivision | *Spermatophyta* |
| Subkingdom | *Tracheobionta* |
| **Species** | ***Pinus ponderosa Lawson & C. Lawson*** |

_Subordinate taxa (5):_  `PIPOB2` *Pinus ponderosa Lawson & C. Lawson var. benthamiana (Hartw.) Vasey*, `PIPOB3` *Pinus ponderosa Lawson & C. Lawson var. brachyptera (Engelm.) Lemmon*, `PIPOP` *Pinus ponderosa Lawson & C. Lawson var. ponderosa C. Lawson*, `PIPOS` *Pinus ponderosa Lawson & C. Lawson var. scopulorum Engelm.*, `PIPOW2` *Pinus ponderosa Lawson & C. Lawson var. washoensis (H. Mason & Stockw.) J.R. Haller & Vivrette*

## 3. Native status (regional)

| Region | Status | Type |
|---|---|---|
| CAN | N | Native |
| L48 | N | Native |

Regions: AK=Alaska, CAN=Canada, GL=Greenland, HI=Hawaii, L48=Lower 48, PB=Pacific Basin, PR=Puerto Rico, SPM=St. Pierre & Miquelon, VI=US Virgin Is.

## 4. Montana county presence

Recorded in **22 of 56** Montana counties.
Per-county hardiness zone is joined from the USDA 2023 hardiness map.

| FIPS | County | Nativity | County hardiness zone |
|---|---|---|---|
| 30003 | Big Horn | Native | 4b |
| 30007 | Broadwater | Native | 4b |
| 30011 | Carter | Native | 4a |
| 30013 | Cascade | Native | 4a |
| 30017 | Custer | Native | 4a |
| 30027 | Fergus | Native | 4b |
| 30029 | Flathead | Native | 4b |
| 30031 | Gallatin | Native | 5a |
| 30033 | Garfield | Native | 4a |
| 30047 | Lake | Native | 5b |
| 30053 | Lincoln | Native | 5a |
| 30061 | Mineral | Native | 6a |
| 30063 | Missoula | Native | 6a |
| 30065 | Musselshell | Native | 4b |
| 30069 | Petroleum | Native | 4a |
| 30071 | Phillips | Native | 3b |
| 30075 | Powder River | Native | 4a |
| 30087 | Rosebud | Native | 4a |
| 30095 | Stillwater | Native | 4b |
| 30103 | Treasure | Native | 4a |
| 30105 | Valley | Native | 4a |
| 30111 | Yellowstone | Native | 4b |

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
| Fire Resistant | Yes | usda:characteristics |
| Flower Color | Yellow | usda:characteristics |
| Flower Conspicuous | No | usda:characteristics |
| Foliage Color | Green | usda:characteristics |
| Foliage Porosity Summer | Dense | usda:characteristics |
| Foliage Porosity Winter | Dense | usda:characteristics |
| Foliage Texture | Medium | usda:characteristics |
| Fruit/Seed Color | Brown | usda:characteristics |
| Fruit/Seed Conspicuous | No | usda:characteristics |
| Growth Form | Single Stem | usda:characteristics |
| Growth Rate | Moderate | usda:characteristics |
| Height at 20 Years, Maximum (feet) | 40 | usda:characteristics |
| Height, Mature (feet) | 223.0 | usda:characteristics |
| Known Allelopath | No | usda:characteristics |
| Leaf Retention | Yes | usda:characteristics |
| Lifespan | Long | usda:characteristics |
| Low Growing Grass | No | usda:characteristics |
| Nitrogen Fixation | None | usda:characteristics |
| Resprout Ability | No | usda:characteristics |
| Shape and Orientation | Rounded | usda:characteristics |
| Toxicity | None | usda:characteristics |

### 5.2 Growth Requirements

| Attribute | Value | Source |
|---|---|---|
| Adapted to Coarse Textured Soils | Yes | usda:characteristics |
| Adapted to Fine Textured Soils | No | usda:characteristics |
| Adapted to Medium Textured Soils | Yes | usda:characteristics |
| Anaerobic Tolerance | None | usda:characteristics |
| CaCO3 Tolerance | Low | usda:characteristics |
| Cold Stratification Required | Yes | usda:characteristics |
| Drought Tolerance | High | usda:characteristics |
| Fertility Requirement | Low | usda:characteristics |
| Fire Tolerance | High | usda:characteristics |
| Frost Free Days, Minimum | 150 | usda:characteristics |
| Hedge Tolerance | Low | usda:characteristics |
| Moisture Use | Medium | usda:characteristics |
| Planting Density per Acre, Maximum | 1200 | usda:characteristics |
| Planting Density per Acre, Minimum | 430 | usda:characteristics |
| Precipitation, Maximum | 25 | usda:characteristics |
| Precipitation, Minimum | 15 | usda:characteristics |
| Root Depth, Minimum (inches) | 20 | usda:characteristics |
| Salinity Tolerance | Medium | usda:characteristics |
| Shade Tolerance | High | usda:characteristics |
| Temperature, Minimum (°F) | -36 | usda:characteristics |
| pH, Maximum | 9.0 | usda:characteristics |
| pH, Minimum | 5.0 | usda:characteristics |

### 5.3 Reproduction

| Attribute | Value | Source |
|---|---|---|
| Bloom Period | Mid Spring | usda:characteristics |
| Commercial Availability | Routinely Available | usda:characteristics |
| Fruit/Seed Abundance | High | usda:characteristics |
| Fruit/Seed Period Begin | Summer | usda:characteristics |
| Fruit/Seed Period End | Fall | usda:characteristics |
| Fruit/Seed Persistence | No | usda:characteristics |
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
| Seed per Pound | 12000 | usda:characteristics |
| Seedling Vigor | High | usda:characteristics |
| Small Grain | No | usda:characteristics |
| Vegetative Spread Rate | None | usda:characteristics |

### 5.4 Suitability/Use

| Attribute | Value | Source |
|---|---|---|
| Berry/Nut/Seed Product | No | usda:characteristics |
| Christmas Tree Product | No | usda:characteristics |
| Fodder Product | No | usda:characteristics |
| Fuelwood Product | Medium | usda:characteristics |
| Lumber Product | Yes | usda:characteristics |
| Naval Store Product | Yes | usda:characteristics |
| Nursery Stock Product | Yes | usda:characteristics |
| Palatable Browse Animal | Low | usda:characteristics |
| Palatable Graze Animal | Low | usda:characteristics |
| Palatable Human | No | usda:characteristics |
| Post Product | Yes | usda:characteristics |
| Protein Potential | Low | usda:characteristics |
| Pulpwood Product | Yes | usda:characteristics |
| Veneer Product | Yes | usda:characteristics |

## 6. Wildlife value

_(no USDA Wildlife data for this species)_

## 7. Wetland indicator (USDA regional)

| Region | Sub-region | Code |
|---|---|---|
| Arid West | — | FACU |
| Western Mountains, Valleys, and Coast | — | FACU |
| Great Plains | — | UPL |
| Northcentral & Northeast | — | UPL |

Codes: OBL=Obligate Wetland, FACW=Facultative Wetland, FAC=Facultative, FACU=Facultative Upland, UPL=Obligate Upland, NL=Not Listed.

_Source: `usda:wetland`._

## 8. Pollinator value

_USDA `HasPollinator` is `false` for this species. Xerces Society Rocky
Mountains list is the natural fill-in but ingestion is **backlogged**
pending permission (Xerces publications are © All Rights Reserved)._

## 9. Conservation / regulatory status

_(no `legal_status` data)_

_(no `invasive_status` data)_

_(no `noxious_status` data)_

## 10. Field Guide narrative (MT Natural Heritage)

| Field | Value | Source |
|---|---|---|
| ELCODE | PGPIN040S0 | mt_field_guide |
| Scientific name (FG) | Pinus ponderosa | mt_field_guide |
| Common name (FG title) | — | mt_field_guide |
| Distribution header | Montana Range Range Descriptions Native | mt_field_guide |
| General description (truncated) | Large trees to 65 m tall with an open, rounded crown and spreading branches. Bark of old trees thick, furrowed, covered with scales that resemble pieces of a jigsaw puzzle. Leaves yellow-green, 7–25 cm long, 2–3 per fascicle, clustered on branch ends. Seed cones broadly ovoid, 7–… | mt_field_guide |
| Habitat narrative | Drier forests as well as rocky exposures (especially sandstone) associated with grasslands; plains, valleys to montane ( Lesica et al. 2012. Manual of Montana Vascular Plants. BRIT Press. Fort Worth, TX ). | mt_field_guide |

### 10.1 MT range statistics

| Statistic | Value |
|---|---|
| Range MT Pct | 100% |
| Suitable MT Pct | 52% |
| Suitable Range Pct | 52% |
| Total Range Acres | 93,692,325 |
| Total Range km2 | 379,168 |
| Total Suitable Acres | 48,955,096 |
| Total Suitable km2 | 198,119 |

### 10.2 Range by land owner

| Owner | Classes |
|---|---|
| Federal | Total Suitable=34%; Optimal Suitability=<1%; Moderate Suitability=17%; Low Suitability=17% |
| State | Total Suitable=6%; Optimal Suitability=<1%; Moderate Suitability=3%; Low Suitability=3% |
| Local | Total Suitable=<1%; Optimal Suitability=; Moderate Suitability=<1%; Low Suitability=<1% |
| Conservation Lands/Easements | Total Suitable=5%; Optimal Suitability=<1%; Moderate Suitability=2%; Low Suitability=3% |
| Private/Tribal/Unknown | Total Suitable=54%; Optimal Suitability=<1%; Moderate Suitability=21%; Low Suitability=33% |


## 11. Phenology (citizen observations by month)

| Month | Observations | Bar |
|---|---:|---|
| Jan | 23 | `` |
| Feb | 13 | `` |
| Mar | 29 | `` |
| Apr | 175 | `#` |
| May | 1025 | `###########` |
| Jun | 1852 | `####################` |
| Jul | 1460 | `###############` |
| Aug | 1026 | `###########` |
| Sep | 812 | `########` |
| Oct | 442 | `####` |
| Nov | 56 | `` |
| Dec | 19 | `` |
| **Total** | **6932** | |

_Derived bloom proxy (peak observation month): **month 6** — LOW confidence. Source: `derived` from `mt_field_guide:obs_chart`._

## 12. Hardiness zone fit (per-species)

| Field | Value | Source |
|---|---|---|
| Temperature, Minimum (°F) | -36 | usda:characteristics |
| Hardiest zone this species tolerates | 3a | derived |

_Plant will likely survive in zones at or warmer than this derived zone._

## 13. Curated notes from USDA

_(all PlantNotes fields are empty for this species)_

## 14. Citations & external links

### 14.1 Related links (26 entries)

| Link text | URL |
|---|---|
| BorealForest.org (PIPO) | <http://www.borealforest.org/world/trees/ponderosa_pine.htm> |
| Canada-British Columbia-Tree Book (PIPO) | <http://www.for.gov.bc.ca/hfd/library/documents/treebook/ponderosapine.htm> |
| CO-Southwest Colorado Wildflowers (PIPO) | <http://www.swcoloradowildflowers.com/Tree%20Enlarged%20Photo%20Pages/pinus%20ponderosa.htm> |
| Flora of North America Pinaceae (PIPO) | <http://www.efloras.org/florataxon.aspx?flora_id=1&taxon_id=10691> |
| Forestry Images (PIPO) | <http://www.forestryimages.org/browse/subimages.cfm?sub=2217> |
| Gymnosperm Database (PIPO) | <http://www.botanik.uni-bonn.de/conifers/pi/pin/ponderosa.htm> |
| KS-Kansas Forest Service (PIPO) | <http://www.kansasforests.org/conservation/evergreens/ponderosapine.shtml> |
| MN-Minnesota Power (PIPO) | <http://www.mnpower.com/treebook/fact70.html> |
| MT-State Plants (PIPO) | <http://www.netstate.com/states/symb/mt_symb.htm> |
| MT-State Tree (PIPO) | <http://montanakids.com/activitiesandgames/printandplay/coloring_book/montana_tree.htm> |
| NC-Plant Fact Sheets (PIPO) | <http://www.ces.ncsu.edu/depts/hort/consumer/factsheets/trees-new/pinus_ponderosa.html> |
| Nearctica-Native Conifers of North America (PIPO) | <http://www.nearctica.com/trees/conifer/pinus/Ppond.htm> |
| OK-Oklahoma Biological Survey (PIPO) | <http://www.biosurvey.ou.edu/shrub/pipo.htm> |
| USDA Forest Service-Silvics of North America (PIPO) | <http://www.na.fs.fed.us/spfo/pubs/silvics_manual/table_of_contents.htm> |
| UT-Utah State University Extension (PIPO) | <http://extension.usu.edu/forestry/UtahForests/TreeID/Pipo.htm> |
| … | _11 more_ |

### 14.2 USDA documentation / data sources (25 entries)

- 1985. Wassman Journal of Biology.   _[Distribution, California]_
- 1992. Journal of the Arizona-Nevada Academy of Science.   _[Distribution, Arizona]_
- 2000. CalFlora: Information on California plants for education, research and conservation. The CalFlora Database, Berkeley.   _[Distribution, California]_
- Abrams, L. 1960. An illustrated flora of the Pacific States. Stanford University Press, Stanford.   _[Distribution, Oregon]_
- Ahlenslager, K., and P. Miller. 1999. Establishment record for Halliday Fen Research Natural Area within the Colville National Forest. Pend Oreille County, Washington. USDA Forest Service.   _[Distribution, Washington]_
- B. Legler 11720 (WTU). Specimen at University of Washington, Seattle, Washington.  _[Distribution, Washington]_
- Bluhm, Wilbur. Personal communication to John Kartesz.   _[Distribution, Oregon]_
- Bluhm, Wilbur. Personal communication.   _[Distribution, Oregon]_
- _… 17 more_

### 14.3 Field Guide citations (63 entries)

- Literature Cited Above Legend: View Online Publication Lesica, P., M.T. Lavin, and P.F. Stickney. 2012. Manual of Montana Vascular Plants. Fort Worth, TX: BRIT Press. viii + 771 p.
- Lesica, P., M.T. Lavin, and P.F. Stickney. 2012. Manual of Montana Vascular Plants. Fort Worth, TX: BRIT Press. viii + 771 p.
- Additional References Legend: View Online Publication Do you know of a citation we're missing? Aldrich, D. F. 1978. Overwintering, springtime development and migration of some Aphidea, including Myzus persicae of Northwestern Montana. M.Sc. Thesis. Bozeman, Montana: Montana State University. 112 p. Anderson, N.L. 1962. Grasshopper-vegetation relationships on Montana grasslands. Ph.D Dissertation. 
- Aldrich, D. F. 1978. Overwintering, springtime development and migration of some Aphidea, including Myzus persicae of Northwestern Montana. M.Sc. Thesis. Bozeman, Montana: Montana State University. 112 p.
- Anderson, N.L. 1962. Grasshopper-vegetation relationships on Montana grasslands. Ph.D Dissertation. Bozeman, Montana: Montana State University. 73 p.
- Burkle L.A., M.P. Simanonok, J.S. Durney, J.A. Myers, and R.T. Belote. 2019. Wildfires influence abundance, diversity, and intraspecific and interspecific trait variation of native bees and flowering plants across burned and unburned landscapes. Frontiers in Ecology and Evolution 7(252):1-14.
- Cope, M.G. 1992. Distribution, habitat selection and survival of transplanted Columbian Sharp-tailed Grouse (Tympanuchus phasianellus columbianus) in the Tobacco Valley, Montana. M.Sc. Thesis. Bozeman, Montana: Montana State University. 60 p.
- DuBois, K.L. 1979. An inventory of the avifauna in the Long Pines of Southeastern Montana. M.Sc. Thesis. Bozeman, MT: Montana State University. 113 p.
- _… 55 more_

## 15. Provenance summary

| Source | Available for this species? | Has* flag |
|---|---|---|
| `usda:profile` | ✅ yes |  |
| `usda:characteristics` | ✅ yes | true |
| `usda:wildlife` | ❌ no | false |
| `usda:wetland` | ✅ yes | true |
| `usda:pollinator` | ❌ no | false |
| `usda:synonyms` | ❌ no | false |
| `usda:subordinate_taxa` | ✅ yes | true |
| `usda:legal_status` | ❌ no | false |
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
