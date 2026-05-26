"""Dump every field rootfast has on one species, as a Markdown table.

Reads from the raw caches (USDA + Field Guide + hardiness), not the built
plants.json — the goal is to show the full data surface available, not
just what v1 currently exposes.

Usage:
    python scripts/dump_species_example.py [USDA_SYMBOL] [OUT_MD_PATH]
Defaults: JUCO6 → docs/EXAMPLE_SPECIES_JUCO6.md
"""

from __future__ import annotations

import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

# scripts/X.py → etl/scripts → etl/  (repo_root/sources/usda-plants/etl/)
ETL_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = ETL_ROOT.parents[2]  # → repo root

USDA_FULL = ETL_ROOT / "raw" / "mt_plants_full.json"
# Cross-source peeks (optional — show non-USDA data alongside USDA's).
# These will fail gracefully if the sibling pipelines aren't populated yet.
FG_FULL       = REPO_ROOT / "experimental" / "montana" / "field_guide" / "raw" / "mt_field_guide_full.json"
HARDINESS_CSV = REPO_ROOT / "sources" / "usda-hardiness" / "etl" / "raw" / "mt_county_zones.csv"

_TAG = re.compile(r"<[^>]+>")
_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]


def _strip(s: str | None) -> str:
    if not s: return ""
    return _TAG.sub("", s).strip()


def _md_escape(s: str) -> str:
    return (s or "").replace("|", "\\|").replace("\n", " ")


def _row(label: str, value: str, source: str = "") -> str:
    return f"| {_md_escape(label)} | {_md_escape(value)} | {_md_escape(source)} |"


def render(symbol: str) -> str:
    usda = json.loads(USDA_FULL.read_bytes())
    fg_all = json.loads(FG_FULL.read_bytes())
    hardiness: dict[str, dict] = {}
    if HARDINESS_CSV.exists():
        with HARDINESS_CSV.open() as f:
            for r in csv.DictReader(f):
                hardiness[r["county_id"]] = r

    rec = usda.get(symbol)
    if not rec:
        sys.exit(f"USDA symbol {symbol!r} not found in {USDA_FULL}")
    fg = next((r for r in fg_all.values() if r.get("usda_symbol") == symbol), None)
    tabs = rec.get("tabs") or {}

    L: list[str] = []
    L.append(f"# Example species: `{symbol}` — *{rec['scientific_name']}* ({rec.get('common_name') or '—'})")
    L.append("")
    L.append(f"This file shows **every data point** rootfast has on one species across all")
    L.append(f"ingested sources, with provenance. It is a snapshot of the *available* data;")
    L.append(f"only a subset is currently surfaced through the built `data/processed/plants.json`.")
    L.append("")
    L.append("Sources cited per row use these short keys:")
    L.append("")
    L.append("- `usda:profile` — USDA PLANTS PlantProfile response")
    L.append("- `usda:characteristics` — USDA PLANTS PlantCharacteristics tab")
    L.append("- `usda:wildlife` — USDA PLANTS PlantWildlife tab")
    L.append("- `usda:wetland` — USDA PLANTS PlantWetland tab")
    L.append("- `usda:synonyms` / `usda:subordinate_taxa` — USDA taxonomic relations")
    L.append("- `usda:legal_status` / `usda:invasive_status` / `usda:noxious_status` — USDA status tabs")
    L.append("- `usda:classification` — USDA classification ancestor chain")
    L.append("- `usda:documentation` / `usda:related_links` — USDA citation + external links")
    L.append("- `usda:mapserver` — USDA PLANTS ArcGIS MapServer (county-level distribution)")
    L.append("- `usda_hardiness:2023` — USDA 2023 Plant Hardiness Zone Map (FeatureServer)")
    L.append("- `mt_field_guide` — fieldguide.mt.gov species page (`#gen`, `#habt`, etc.)")
    L.append("- `mt_field_guide:obs_chart` — monthly observation counts (phenology proxy)")
    L.append("- `derived` — computed field (e.g. observation-peak month, zone from min temp)")
    L.append("")

    # === Identification =================================================
    L.append("## 1. Identification")
    L.append("")
    L.append("| Field | Value | Source |")
    L.append("|---|---|---|")
    L.append(_row("USDA symbol",       symbol, "usda:profile"))
    L.append(_row("Scientific name",   _strip(rec.get("scientific_name")), "usda:profile"))
    L.append(_row("Common name",       rec.get("common_name") or "—", "usda:profile"))
    L.append(_row("Other common names", ", ".join(rec.get("other_common_names") or []) or "—", "usda:profile"))
    L.append(_row("Family",            _strip(rec.get("family")), "usda:profile"))
    L.append(_row("Group",             rec.get("group") or "—", "usda:profile"))
    L.append(_row("Rank",              rec.get("rank") or "—", "usda:profile"))
    L.append(_row("Plant master id",   str(rec.get("plant_master_id")), "usda:profile"))
    if fg:
        L.append(_row("Field Guide ELCODE", fg.get("elcode") or "—", "mt_field_guide"))
        L.append(_row("USDA crosswalk via", fg.get("usda_match_via") or "—", "derived"))
    L.append(_row("Accepted symbol",   rec.get("accepted_symbol") or "(this taxon is the accepted name)", "usda:profile"))
    L.append(_row("Synonym symbol",    rec.get("synonym_symbol") or "—", "usda:profile"))
    L.append(_row("Durations",         ", ".join(rec.get("durations") or []), "usda:profile"))
    L.append(_row("Growth habits",     ", ".join(rec.get("growth_habits") or []), "usda:profile"))
    L.append("")

    # === Taxonomy chain =================================================
    L.append("## 2. Taxonomy (ancestor chain)")
    L.append("")
    L.append("| Rank | Name |")
    L.append("|---|---|")
    classif = tabs.get("classification") or {}
    for anc in classif.get("Ancestors") or []:
        L.append(f"| {anc.get('Rank','')} | *{_strip(anc.get('ScientificName',''))}* |")
    L.append(f"| **{rec.get('rank','')}** | ***{_strip(rec.get('scientific_name',''))}*** |")
    L.append("")
    sub = tabs.get("subordinate_taxa") or {}
    subs = sub.get("SubordinateTaxa") or []
    if subs:
        L.append(f"_Subordinate taxa ({len(subs)}):_  " + ", ".join(
            f"`{s.get('Symbol')}` *{_strip(s.get('ScientificName',''))}*" for s in subs[:8]
        ) + (" …" if len(subs) > 8 else ""))
        L.append("")
    syns = tabs.get("synonyms") or []
    if syns:
        L.append(f"_USDA synonyms ({len(syns)}):_  " + ", ".join(
            f"`{s.get('Symbol')}` *{_strip(s.get('ScientificName',''))}*" for s in syns[:8]
        ) + (" …" if len(syns) > 8 else ""))
        L.append("")

    # === Native status & distribution ===================================
    L.append("## 3. Native status (regional)")
    L.append("")
    L.append("| Region | Status | Type |")
    L.append("|---|---|---|")
    for ns in rec.get("native_statuses") or []:
        L.append(f"| {ns.get('Region','')} | {ns.get('Status','')} | {ns.get('Type','')} |")
    L.append("")
    L.append("Regions: AK=Alaska, CAN=Canada, GL=Greenland, HI=Hawaii, L48=Lower 48, "
             "PB=Pacific Basin, PR=Puerto Rico, SPM=St. Pierre & Miquelon, VI=US Virgin Is.")
    L.append("")

    L.append("## 4. Montana county presence")
    L.append("")
    L.append(f"Recorded in **{len(rec.get('mt_counties') or [])} of 56** Montana counties.")
    L.append("Per-county hardiness zone is joined from the USDA 2023 hardiness map.")
    L.append("")
    L.append("| FIPS | County | Nativity | County hardiness zone |")
    L.append("|---|---|---|---|")
    counties_sorted = sorted(rec.get("mt_counties") or [], key=lambda c: c["county_name"])
    for c in counties_sorted:
        cid = str(c["county_id"])
        zone_row = hardiness.get(cid, {})
        zone = zone_row.get("predominant_zone", "?")
        fips = zone_row.get("fips", "—")
        L.append(f"| {fips} | {c['county_name']} | {c['nativity']} | {zone} |")
    L.append("")
    L.append("_Source: `usda:mapserver` for presence + nativity; `usda_hardiness:2023` for zones._")
    L.append("")

    # === Cultivation (USDA characteristics) =============================
    chars = tabs.get("characteristics") or []
    if chars:
        by_cat: dict[str, dict[str, str]] = defaultdict(dict)
        for c in chars:
            if c.get("CultivarName"):
                continue  # wild-type only
            cat = c.get("PlantCharacteristicCategory") or "Other"
            name = c.get("PlantCharacteristicName")
            val  = c.get("PlantCharacteristicValue")
            if name and name not in by_cat[cat]:
                by_cat[cat][name] = val or ""

        L.append("## 5. Cultivation characteristics (USDA)")
        L.append("")
        L.append("Wild-type values only (cultivar rows excluded).")
        L.append("")
        for cat in ["Morphology/Physiology", "Growth Requirements", "Reproduction", "Suitability/Use"]:
            if cat not in by_cat:
                continue
            L.append(f"### 5.{['Morphology/Physiology','Growth Requirements','Reproduction','Suitability/Use'].index(cat)+1} {cat}")
            L.append("")
            L.append("| Attribute | Value | Source |")
            L.append("|---|---|---|")
            for name in sorted(by_cat[cat]):
                L.append(_row(name, by_cat[cat][name], "usda:characteristics"))
            L.append("")
    else:
        L.append("## 5. Cultivation characteristics")
        L.append("")
        L.append("_(no USDA Characteristics data for this species — `HasCharacteristics=false`)_")
        L.append("")

    # === Wildlife =======================================================
    L.append("## 6. Wildlife value")
    L.append("")
    wl = tabs.get("wildlife") or {}
    food = wl.get("Food") or []
    cover = wl.get("Cover") or []
    if food or cover:
        if food:
            L.append("### 6.1 Food value")
            L.append("")
            L.append("| Source ref | Large mammals | Small mammals | Water birds | Terrestrial birds |")
            L.append("|---|---|---|---|---|")
            for f in food:
                L.append(f"| {f.get('Source','')} | {f.get('LargeMammals','—') or '—'} | {f.get('SmallMammals','—') or '—'} | {f.get('WaterBirds','—') or '—'} | {f.get('TerrestrialBirds','—') or '—'} |")
            L.append("")
        if cover:
            L.append("### 6.2 Cover value")
            L.append("")
            L.append("| Source ref | Large mammals | Small mammals | Water birds | Terrestrial birds |")
            L.append("|---|---|---|---|---|")
            for c in cover:
                L.append(f"| {c.get('Source','')} | {c.get('LargeMammals','—') or '—'} | {c.get('SmallMammals','—') or '—'} | {c.get('WaterBirds','—') or '—'} | {c.get('TerrestrialBirds','—') or '—'} |")
            L.append("")
        L.append("_Source: `usda:wildlife`._")
    else:
        L.append("_(no USDA Wildlife data for this species)_")
    L.append("")

    # === Wetland indicators =============================================
    L.append("## 7. Wetland indicator (USDA regional)")
    L.append("")
    wet = tabs.get("wetland") or []
    rows: list[tuple[str,str,str]] = []
    for entry in wet:
        for d in entry.get("WetlandDesignations") or []:
            rows.append((d.get("Region",""), d.get("SubRegion","") or "—", d.get("WetlandCode","")))
    if rows:
        L.append("| Region | Sub-region | Code |")
        L.append("|---|---|---|")
        for r in rows:
            L.append(f"| {r[0]} | {r[1]} | {r[2]} |")
        L.append("")
        L.append("Codes: OBL=Obligate Wetland, FACW=Facultative Wetland, FAC=Facultative, "
                 "FACU=Facultative Upland, UPL=Obligate Upland, NL=Not Listed.")
    else:
        L.append("_(no wetland indicator records)_")
    L.append("")
    L.append("_Source: `usda:wetland`._")
    L.append("")

    # === Pollinator value ===============================================
    L.append("## 8. Pollinator value")
    L.append("")
    poll = tabs.get("pollinator")
    if poll:
        L.append("```json")
        L.append(json.dumps(poll, indent=2)[:800])
        L.append("```")
    else:
        L.append("_USDA `HasPollinator` is `false` for this species. Xerces Society Rocky")
        L.append("Mountains list is the natural fill-in but ingestion is **backlogged**")
        L.append("pending permission (Xerces publications are © All Rights Reserved)._")
    L.append("")

    # === Legal / invasive / noxious / protected =========================
    L.append("## 9. Conservation / regulatory status")
    L.append("")
    def _status_table(tab_key: str, status_field: str, label: str) -> list[str]:
        payload = tabs.get(tab_key) or []
        if not payload:
            return [f"_(no `{tab_key}` data)_", ""]
        out = [f"### {label}", "", "| State / locality | Statuses |", "|---|---|"]
        for entry in payload:
            states = entry.get(status_field) or []
            rendered: list[str] = []
            for s in states:
                if isinstance(s, str):
                    rendered.append(s)
                elif isinstance(s, dict):
                    bits = [f"{k}={v}" for k, v in s.items() if v not in (None, "", [])]
                    rendered.append("{" + ", ".join(bits) + "}")
            out.append(f"| {entry.get('LocalityName','')} | {', '.join(rendered) or '—'} |")
        out.append("")
        return out

    L.extend(_status_table("legal_status",    "ConservationStatuses", "9.1 Legal / conservation status (per state)"))
    L.extend(_status_table("invasive_status", "InvasiveStatuses",     "9.2 Invasive status (per state)"))
    L.extend(_status_table("noxious_status",  "NoxiousStatuses",      "9.3 Noxious weed status (per state)"))

    # === Field Guide narrative ==========================================
    L.append("## 10. Field Guide narrative (MT Natural Heritage)")
    L.append("")
    if fg:
        L.append("| Field | Value | Source |")
        L.append("|---|---|---|")
        L.append(_row("ELCODE", fg.get("elcode") or "—", "mt_field_guide"))
        L.append(_row("Scientific name (FG)", fg.get("scientific_name") or "—", "mt_field_guide"))
        L.append(_row("Common name (FG title)", fg.get("common_name") or "—", "mt_field_guide"))
        L.append(_row("Distribution header", (fg.get("distribution") or "—")[:120], "mt_field_guide"))
        L.append(_row("General description (truncated)", (fg.get("general") or "—")[:280] + ("…" if (fg.get("general") or "") and len(fg["general"]) > 280 else ""), "mt_field_guide"))
        L.append(_row("Habitat narrative", (fg.get("habitat") or "—"), "mt_field_guide"))
        L.append("")
        rs = fg.get("range_stats") or {}
        if rs:
            L.append("### 10.1 MT range statistics")
            L.append("")
            L.append("| Statistic | Value |")
            L.append("|---|---|")
            for k, v in rs.items():
                L.append(f"| {k} | {v} |")
            L.append("")
        owners = fg.get("owners") or []
        if owners:
            L.append("### 10.2 Range by land owner")
            L.append("")
            L.append("| Owner | Classes |")
            L.append("|---|---|")
            for o in owners:
                cls = "; ".join(f"{c.get('ClassDesc')}={c.get('Percent')}" for c in o.get("Classes") or [])
                L.append(f"| {o.get('OwnerDesc','')} | {cls} |")
            L.append("")
    else:
        L.append("_(no Field Guide crosswalk match)_")
    L.append("")

    # === Phenology (FG ObsChart) ========================================
    L.append("## 11. Phenology (citizen observations by month)")
    L.append("")
    obs = (fg or {}).get("monthly_obs") or {}
    if obs:
        L.append("| Month | Observations | Bar |")
        L.append("|---|---:|---|")
        max_v = max(obs.get(m, 0) for m in _MONTHS) or 1
        for m in _MONTHS:
            v = obs.get(m, 0)
            bar = "#" * int(20 * v / max_v) if v else ""
            L.append(f"| {m} | {v} | `{bar}` |")
        L.append(f"| **Total** | **{obs.get('Total', sum(obs.get(m,0) for m in _MONTHS))}** | |")
        L.append("")
        # Derived peak
        peak = max(((obs.get(m,0), i+1) for i, m in enumerate(_MONTHS)), default=(0,0))
        if peak[0] > 0:
            L.append(f"_Derived bloom proxy (peak observation month): **month {peak[1]}** — LOW confidence. Source: `derived` from `mt_field_guide:obs_chart`._")
    else:
        L.append("_(no monthly observation data)_")
    L.append("")

    # === Hardiness (derived) ============================================
    L.append("## 12. Hardiness zone fit (per-species)")
    L.append("")
    temp_min = None
    for c in chars:
        if c.get("CultivarName"):
            continue
        if c.get("PlantCharacteristicName") == "Temperature, Minimum (°F)":
            temp_min = c.get("PlantCharacteristicValue")
            break
    if temp_min is not None:
        try:
            t = float(temp_min)
        except ValueError:
            t = None
        # Hardiness zone mapping by min temperature (°F):
        bands = [
            (-60,-55,"1a"),(-55,-50,"1b"),(-50,-45,"2a"),(-45,-40,"2b"),
            (-40,-35,"3a"),(-35,-30,"3b"),(-30,-25,"4a"),(-25,-20,"4b"),
            (-20,-15,"5a"),(-15,-10,"5b"),(-10,-5,"6a"),(-5,0,"6b"),
            (0,5,"7a"),(5,10,"7b"),(10,15,"8a"),(15,20,"8b"),(20,25,"9a"),(25,30,"9b"),
        ]
        derived_zone = None
        if t is not None:
            for lo, hi, name in bands:
                if lo <= t < hi:
                    derived_zone = name
                    break
        L.append("| Field | Value | Source |")
        L.append("|---|---|---|")
        L.append(_row("Temperature, Minimum (°F)", str(temp_min), "usda:characteristics"))
        L.append(_row("Hardiest zone this species tolerates", derived_zone or "?", "derived"))
        L.append("")
        L.append("_Plant will likely survive in zones at or warmer than this derived zone._")
    else:
        L.append("_(no `Temperature, Minimum` in USDA characteristics — cannot derive per-species zone fit)_")
    L.append("")

    # === Notes ==========================================================
    L.append("## 13. Curated notes from USDA")
    L.append("")
    notes = rec.get("plant_notes") or {}
    has_any = any(v for v in notes.values())
    if has_any:
        L.append("| Note section | Value |")
        L.append("|---|---|")
        for k, v in notes.items():
            if v:
                L.append(f"| {k} | {_md_escape(_strip(v))} |")
        L.append("")
    else:
        L.append("_(all PlantNotes fields are empty for this species)_")
    L.append("")

    # === Citations + links ==============================================
    L.append("## 14. Citations & external links")
    L.append("")
    rl = tabs.get("related_links") or []
    if rl:
        L.append(f"### 14.1 Related links ({len(rl)} entries)")
        L.append("")
        L.append("| Link text | URL |")
        L.append("|---|---|")
        for link in rl[:15]:
            url = link.get("Url","")
            txt = link.get("LinkText","")
            L.append(f"| {_md_escape(txt)} | <{url}> |")
        if len(rl) > 15:
            L.append(f"| … | _{len(rl)-15} more_ |")
        L.append("")
    doc = tabs.get("documentation") or {}
    ds = doc.get("DataSources") or []
    if ds:
        L.append(f"### 14.2 USDA documentation / data sources ({len(ds)} entries)")
        L.append("")
        for d in ds[:8]:
            L.append(f"- {_md_escape(d.get('DataSourceString',''))}  _[{d.get('DataSourceType','')}, {d.get('DataSourceLocalityString','')}]_")
        if len(ds) > 8:
            L.append(f"- _… {len(ds)-8} more_")
        L.append("")
    if fg and fg.get("citations"):
        cits = fg["citations"]
        L.append(f"### 14.3 Field Guide citations ({len(cits)} entries)")
        L.append("")
        for cit in cits[:8]:
            L.append(f"- {_md_escape(cit)}")
        if len(cits) > 8:
            L.append(f"- _… {len(cits)-8} more_")
        L.append("")

    # === Provenance footer ==============================================
    L.append("## 15. Provenance summary")
    L.append("")
    L.append("| Source | Available for this species? | Has* flag |")
    L.append("|---|---|---|")
    flags = rec.get("has_flags") or {}
    flag_map = [
        ("usda:profile", True, None),
        ("usda:characteristics", "characteristics" in tabs, "HasCharacteristics"),
        ("usda:wildlife", "wildlife" in tabs, "HasWildlife"),
        ("usda:wetland", "wetland" in tabs, "HasWetlandData"),
        ("usda:pollinator", "pollinator" in tabs, "HasPollinator"),
        ("usda:synonyms", "synonyms" in tabs, "HasSynonyms"),
        ("usda:subordinate_taxa", "subordinate_taxa" in tabs, "HasSubordinateTaxa"),
        ("usda:legal_status", "legal_status" in tabs, "HasLegalStatuses"),
        ("usda:invasive_status", "invasive_status" in tabs, "HasInvasiveStatuses"),
        ("usda:noxious_status", "noxious_status" in tabs, "HasNoxiousStatuses"),
        ("usda:ethnobotany", "ethnobotany" in tabs, "HasEthnobotany"),
        ("usda:classification", "classification" in tabs, None),
        ("usda:related_links", "related_links" in tabs, "HasRelatedLinks"),
        ("usda:documentation", "documentation" in tabs, "HasDocumentation"),
        ("usda:mapserver", bool(rec.get("mt_counties")), None),
        ("usda_hardiness:2023", True, None),
        ("mt_field_guide", fg is not None, None),
        ("mt_field_guide:obs_chart", bool((fg or {}).get("monthly_obs")), None),
        ("xerces", False, None),
    ]
    for src, available, flag in flag_map:
        f_val = flags.get(flag) if flag else None
        f_str = "" if flag is None else ("true" if f_val else "false")
        L.append(f"| `{src}` | {'✅ yes' if available else '❌ no'} | {f_str} |")
    L.append("")

    return "\n".join(L)


def main() -> None:
    symbol = sys.argv[1] if len(sys.argv) > 1 else "JUCO6"
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else REPO_ROOT / "sources" / "usda-plants" / "docs" / f"EXAMPLE_SPECIES_{symbol}.md"
    md = render(symbol)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(md)
    print(f"Wrote {out} ({len(md)/1024:.1f} KB)")


if __name__ == "__main__":
    main()
