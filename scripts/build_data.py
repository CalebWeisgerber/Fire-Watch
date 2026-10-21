"""Normalize both fire eras into one compact table -> web/data/fires.json.

Era 0 = 1970-2007 (DNR Fire Statistics layer 3, main dataset)
Era 1 = 2008-present (local CSV, DNR-protected fires only, false alarms removed)
"""
import csv
import datetime as dt
import json
import shutil
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "Data" / "raw"
OLD = RAW / "fires_1970_2007.geojson"
NEW = ROOT / "Data" / "DNR_Fire_Statistics_2008_-_Present.csv"
WEB = ROOT / "web" / "data"

CAUSE_GROUPS = [
    "Lightning", "Debris burning", "Recreation / Campfire", "Smoking",
    "Equipment / Rail / Logging", "Arson", "Children", "Fireworks / Firearms", "Other / Unknown",
]
UNKNOWN = CAUSE_GROUPS.index("Other / Unknown")
CROSSWALK = {
    # 1970-2007 values
    "Lightning": "Lightning", "Debris Burn": "Debris burning", "Recreation": "Recreation / Campfire",
    "Smoker": "Smoking", "Logging": "Equipment / Rail / Logging", "Railroad": "Equipment / Rail / Logging",
    "Arson": "Arson", "Children": "Children", "Miscellaneou": "Other / Unknown",
    "Miscellaneous": "Other / Unknown",
    # 2008+ values
    "Natural": "Lightning", "Celebration": "Recreation / Campfire", "Smoking": "Smoking",
    "Equip/Vehicle": "Equipment / Rail / Logging", "Power Gen": "Equipment / Rail / Logging",
    "Minor with Fire": "Children", "Fireworks": "Fireworks / Firearms", "Firearms": "Fireworks / Firearms",
    "Undetermine": "Other / Unknown", "DNR NOT RESPONSIBLE": "Other / Unknown",
}
FALSE_ALARM = {"False Alarm", "FA"}


def cause_idx(raw):
    return CAUSE_GROUPS.index(CROSSWALK.get(raw or "", "Other / Unknown"))


def doy(d):
    return d.timetuple().tm_yday


def load_new():
    rows, region_votes = [], defaultdict(Counter)
    with NEW.open(encoding="utf-8-sig", newline="") as fh:
        for r in csv.DictReader(fh):
            county = r["COUNTY_LABEL_NM"].strip()
            if county == "NO DATA":
                county = ""
            if county and r["REGION_NAME"]:
                region_votes[county][r["REGION_NAME"].strip()] += 1
            if not r["PROTECTION_TYPE"].startswith("DNR Protection"):
                continue
            if r["FIREEVNT_CLASS_LABEL_NM"] in FALSE_ALARM or not county or not r["DSCVR_DT"]:
                continue
            # stored as UTC (local midnight = 07:00/08:00Z); shift to Pacific before taking the date
            d = (dt.datetime.strptime(r["DSCVR_DT"][:19], "%Y/%m/%d %H:%M:%S") - dt.timedelta(hours=7)).date()
            if d.year < 2008:
                continue
            try:
                lat, lon = round(float(r["LAT_COORD"]), 4), round(float(r["LON_COORD"]), 4)
                if not (45 < lat < 49.1 and -125 < lon < -116.8):
                    lat = lon = None
            except ValueError:
                lat = lon = None
            rows.append((1, d, county, cause_idx(r["FIREGCAUSE_LABEL_NM"]),
                         float(r["ACRES_BURNED"] or 0), lat, lon))
    region_of = {c: v.most_common(1)[0][0] for c, v in region_votes.items()}
    return rows, region_of


def load_old():
    rows = []
    for f in json.loads(OLD.read_text())["features"]:
        p = f["properties"]
        county = p["COUNTY_LABEL_NM"]
        if not county or p["FIREEVNT_CLASS_LABEL_NM"] == "Out of State" or not p["START_DT"]:
            continue
        d = dt.datetime.fromtimestamp(p["START_DT"] / 1000, dt.UTC).date()
        lat = lon = None
        if f["geometry"]:
            lon, lat = (round(x, 4) for x in f["geometry"]["coordinates"])
        rows.append((0, d, county, cause_idx(p["FIREGCAUSE_LABEL_NM"]),
                     float(p["ACRES_BURNED"] or 0), lat, lon))
    return rows


AGENCY_REGION = {"NE": "NORTHEAST", "SE": "SOUTHEAST", "PC": "PACIFIC CASC", "NW": "NORTHWEST",
                 "OLY": "OLYMPIC", "SPS": "SO PUGET"}


def build_large_fires():
    """DNR large-fire perimeters (1973-2025) -> web/data/large_fires.geojson with compact props.
    Fire names are dropped (aggregates only, per the ground rule)."""
    src = RAW / "large_fires_dnr.geojson"
    if not src.exists():
        return 0
    feats = []
    for f in json.loads(src.read_text())["features"]:
        p = f["properties"]
        if not f.get("geometry") or not p.get("YEAR"):
            continue
        code = (p.get("AGENCY") or "").split("-")[-1].replace("REGION", "").strip()
        cause = (p.get("CAUSE") or "UNKNOWN").strip().title()
        feats.append({"type": "Feature", "geometry": f["geometry"], "properties": {
            "y": int(p["YEAR"]), "ac": round(p.get("ACRES") or 0), "c": cause if cause else "Unknown",
            "r": AGENCY_REGION.get(code)}})
    (WEB / "large_fires.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                                                        separators=(",", ":")))
    return len(feats)


def main():
    new, region_of = load_new()
    old = load_old()
    rows = old + new
    counties = sorted({r[2] for r in rows})
    missing = [c for c in counties if c not in region_of]
    if missing:
        raise SystemExit(f"no DNR region for counties: {missing}")
    regions = sorted(set(region_of[c] for c in counties))
    ci = {c: i for i, c in enumerate(counties)}
    out = {
        "fields": ["era", "year", "doy", "county", "cause", "acres", "lat", "lon"],
        "eras": ["1970-2007", "2008-present"],
        "causes": CAUSE_GROUPS,
        "human": [i not in (0, UNKNOWN) for i in range(len(CAUSE_GROUPS))],
        "counties": counties,
        "regions": regions,
        "county_region": [regions.index(region_of[c]) for c in counties],
        "rows": [[e, d.year, doy(d), ci[c], k, round(a, 2), la, lo] for e, d, c, k, a, la, lo in rows],
    }
    WEB.mkdir(parents=True, exist_ok=True)
    (WEB / "fires.json").write_text(json.dumps(out, separators=(",", ":")))

    # Stations and (optional) boundaries are passed through for the map.
    stations = json.loads((RAW / "stations.json").read_text())
    (WEB / "stations.json").write_text(json.dumps(
        [[round(s["lat"], 4), round(s["lon"], 4)] for s in stations], separators=(",", ":")))
    large = build_large_fires()
    for name in ("dnr_regions", "counties"):
        src = RAW / "boundaries" / f"{name}.geojson"
        if src.exists():
            shutil.copy(src, WEB / f"{name}.geojson")

    print(f"1970-2007: {len(old)} fires | 2008+: {len(new)} DNR-protected fires")
    print(f"{len(counties)} counties, {len(regions)} regions, {len(stations)} stations, {large} DNR large-fire perimeters")
    print(f"wrote {WEB / 'fires.json'} ({(WEB / 'fires.json').stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
