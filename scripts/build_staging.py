"""Staging & prevention data from the 2008-present CSV -> web/data/staging.json.

Uses the lifecycle and impact columns the 1970-2007 layer lacks:
  HOURS_TO_CONTROL = (CONTROL_DT + CONTROL_TM) - (DSCVR_DT + DSCVR_TM)
  TIMBER_ACRES_LOST = BURN_MERCH_AREA + BURN_REPROD_AREA
  IA failure = HOURS_TO_CONTROL > 24 or ACRES_BURNED > 100 (escaped initial attack)
Filters: DNR-protected only, no false alarms, no "DNR NOT RESPONSIBLE", valid WA coordinates.
Output is one compact row per fire; no names or incident numbers are exported.
"""
import csv
import datetime as dt
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSV = ROOT / "Data" / "DNR_Fire_Statistics_2008_-_Present.csv"
OUT = ROOT / "web" / "data" / "staging.json"
MAX_HOURS = 24 * 60          # anything longer is a data-entry error, not a fire
FALSE_ALARM = {"False Alarm", "FA"}
PACIFIC = dt.timedelta(hours=7)   # DSCVR_DT/CONTROL_DT are local midnight stored as UTC (07:00/08:00Z)
DNR_OWNERS = {"DNR"}


def local_dt(date_str, tm):
    """Local wall-clock datetime from 'YYYY/MM/DD HH:MM:SS+00' + 'HHMM'."""
    if not date_str:
        return None
    utc = dt.datetime.strptime(date_str[:19], "%Y/%m/%d %H:%M:%S")
    day = (utc - PACIFIC).date()
    tm = (tm or "").strip()
    if len(tm) == 4 and tm.isdigit() and int(tm[:2]) < 24 and int(tm[2:]) < 60:
        return dt.datetime(day.year, day.month, day.day, int(tm[:2]), int(tm[2:])), True
    return dt.datetime(day.year, day.month, day.day, 12), False


def num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return 0.0


def main():
    regions, causes, escapes, owners = [], [], [], []
    idx = lambda lst, v: lst.index(v) if v in lst else (lst.append(v) or len(lst) - 1)
    rows = []
    skipped = Counter()
    with CSV.open(encoding="utf-8-sig", newline="") as fh:
        for r in csv.DictReader(fh):
            if not r["PROTECTION_TYPE"].startswith("DNR Protection"):
                skipped["not DNR-protected"] += 1
                continue
            if r["FIREEVNT_CLASS_LABEL_NM"] in FALSE_ALARM or r["FIREGCAUSE_LABEL_NM"] == "DNR NOT RESPONSIBLE":
                skipped["false alarm / not responsible"] += 1
                continue
            try:
                lat, lon = float(r["LAT_COORD"]), float(r["LON_COORD"])
            except ValueError:
                lat = lon = None
            if lat is None or not (45.5 < lat < 49.1 and -124.9 < lon < -116.9) or not r["REGION_NAME"]:
                skipped["bad coordinates / region"] += 1
                continue
            disc = local_dt(r["DSCVR_DT"], r["DSCVR_TM"])
            if not disc or disc[0].year < 2008:
                skipped["no / pre-2008 discovery date"] += 1
                continue
            d, has_time = disc
            hours = None
            ctl = local_dt(r["CONTROL_DT"], r["CONTROL_TM"])
            if ctl and has_time and ctl[1]:
                h = (ctl[0] - d).total_seconds() / 3600
                hours = round(h, 1) if 0 <= h <= MAX_HOURS else None
            acres = num(r["ACRES_BURNED"])
            timber = num(r["BURN_MERCH_AREA"]) + num(r["BURN_REPROD_AREA"])
            elev = int(num(r["SITE_ELEV"])) if r["SITE_ELEV"] else None
            owner = r["START_OWNER_AGENCY_NM"] or "Unknown"
            juris = r["START_JURISDICTION_AGENCY_NM"] or ""
            rows.append([
                idx(regions, r["REGION_NAME"].strip()),
                d.year, d.month, d.weekday(),             # 0 = Monday
                d.hour if has_time else None,
                round(lat, 4), round(lon, 4),
                idx(causes, r["FIREGCAUSE_LABEL_NM"] or "Unknown"),
                round(acres, 2), round(min(timber, acres) if acres else timber, 2),
                hours, elev,
                idx(escapes, r["BURNESCAPE_RSN_LABEL_NM"] or ""),
                idx(owners, owner),
                0 if juris == "DNR" else 1,               # 1 = shared / non-DNR jurisdiction
            ])
    out = {
        "fields": ["region", "year", "month", "dow", "hour", "lat", "lon", "cause", "acres",
                   "timber", "hours", "elev", "escape", "owner", "shared"],
        "regions": regions, "causes": causes, "escapes": escapes, "owners": owners,
        "ia_fail": {"hours": 24, "acres": 100},
        "human_exclude": ["Natural", "Undetermine", "Miscellaneous", "Unknown"],
        "rows": rows,
    }
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    with_hours = sum(1 for r in rows if r[10] is not None)
    fails = sum(1 for r in rows if (r[10] or 0) > 24 or r[8] > 100)
    print(f"{len(rows)} fires kept; skipped {dict(skipped)}")
    print(f"hours-to-control known for {with_hours}; IA failures {fails}; "
          f"timber-loss fires {sum(1 for r in rows if r[9] > 0)}")
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
