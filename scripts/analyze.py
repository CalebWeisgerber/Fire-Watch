"""Precompute every number the web app shows -> web/data/*.json.

All metrics are deterministic (counts, medians, correlations). Each output file is keyed by
area: "ALL" (all DNR-protected lands), each DNR region, and each county.
Run after build_data.py. Re-run whenever more weather files land in Data/raw/weather.
"""
import datetime as dt
import json
import math
import statistics as st
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web" / "data"
WEATHER = ROOT / "Data" / "raw" / "weather"

FAR_MI = 10
YEARS = list(range(1970, 2027))
ERA0 = range(1970, 2008)
THIS_YEAR = 2026
BOOST = 0.15           # coverage-gap boost for top-quartile regions
MULT_RANGE = (0.6, 1.8)  # clamp on the weather multiplier so one odd tercile can't dominate
# CSV region codes -> official names (match JURISDICT_LABEL_NM in the DNR regions layer)
REGION_NAMES = {"NORTHEAST": "Northeast", "SOUTHEAST": "Southeast", "PACIFIC CASC": "Pacific Cascade",
                "OLYMPIC": "Olympic", "NORTHWEST": "Northwest", "SO PUGET": "South Puget Sound"}


# ---------- small math helpers ----------
def pct(xs, q):
    xs = sorted(xs)
    if not xs:
        return None
    k = (len(xs) - 1) * q
    lo, hi = math.floor(k), math.ceil(k)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def pearson(xs, ys):
    pairs = [(x, y) for x, y in zip(xs, ys) if x is not None and y is not None]
    if len(pairs) < 5:
        return None
    xs, ys = zip(*pairs)
    mx, my = st.fmean(xs), st.fmean(ys)
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    sy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if sx == 0 or sy == 0:
        return None
    return round(sum((x - mx) * (y - my) for x, y in pairs) / (sx * sy), 3)


def ranks(xs):
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    r = [0.0] * len(xs)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        for k in range(i, j + 1):
            r[order[k]] = (i + j) / 2 + 1
        i = j + 1
    return r


def spearman(xs, ys):
    return pearson(ranks(xs), ranks(ys))


def slope(xs, ys):
    mx, my = st.fmean(xs), st.fmean(ys)
    den = sum((x - mx) ** 2 for x in xs)
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den if den else 0.0


def haversine(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 3958.8 * 2 * math.asin(math.sqrt(a))


def r1(x):
    return None if x is None else round(x, 1)


def decade(y):
    return f"{y // 10 * 10}s"


def iso_week(year, doy):
    return min(52, (dt.date(year, 1, 1) + dt.timedelta(days=doy - 1)).isocalendar().week)


# ---------- load ----------
def load():
    d = json.loads((WEB / "fires.json").read_text())
    fires = [dict(zip(d["fields"], r)) for r in d["rows"]]
    return d, fires


def build_areas(d):
    areas = {"ALL": {"name": "All DNR-protected lands", "type": "state",
                     "counties": set(range(len(d["counties"])))}}
    for ri, reg in enumerate(d["regions"]):
        areas[reg] = {"name": REGION_NAMES.get(reg, reg.title()), "type": "region",
                      "counties": {i for i, r in enumerate(d["county_region"]) if r == ri}}
    for ci, c in enumerate(d["counties"]):
        areas[c] = {"name": c.title(), "type": "county", "counties": {ci},
                    "region": d["regions"][d["county_region"][ci]]}
    return areas


def load_weather(counties):
    """Per county-year: Apr-Jun rain, Jul-Aug mean Tmax, longest Jun-Sep dry streak."""
    out = {}
    for ci, c in enumerate(counties):
        path = WEATHER / f"{c}.json"
        if not path.exists():
            continue
        daily = json.loads(path.read_text())["daily"]
        by_year = defaultdict(lambda: {"rain": 0.0, "rain_n": 0, "tmax": [], "streak": 0, "run": 0})
        for t, p, tx in zip(daily["time"], daily["precipitation_sum"], daily["temperature_2m_max"]):
            y, m = int(t[:4]), int(t[5:7])
            b = by_year[y]
            if 4 <= m <= 6 and p is not None:
                b["rain"] += p
                b["rain_n"] += 1
            if m in (7, 8) and tx is not None:
                b["tmax"].append(tx)
            if 6 <= m <= 9 and p is not None:
                b["run"] = b["run"] + 1 if p < 1 else 0
                b["streak"] = max(b["streak"], b["run"])
        years = {}
        for y, b in by_year.items():
            if b["rain_n"] < 85:      # need a (nearly) complete spring
                continue
            years[y] = {"rain": b["rain"], "tmax": st.fmean(b["tmax"]) if len(b["tmax"]) > 50 else None,
                        "streak": b["streak"] if b["tmax"] else None}
        base = [v["rain"] for y, v in years.items() if y in ERA0]
        if not base:
            continue
        mean = st.fmean(base)
        for v in years.values():
            v["rain_pct"] = 100 * v["rain"] / mean if mean else None
        out[ci] = years
    return out


# ---------- per-area metrics ----------
def era_stats(fs, total_count, total_acres, d):
    acres = [f["acres"] for f in fs]
    known = [f for f in fs if f["cause"] != len(d["causes"]) - 1]
    human = [f for f in known if d["human"][f["cause"]]]
    return {
        "count": len(fs), "acres": round(sum(acres)),
        "median_acres": r1(st.median(acres)) if acres else None,
        "share_count": r1(100 * len(fs) / total_count) if total_count else None,
        "share_acres": r1(100 * sum(acres) / total_acres) if total_acres else None,
        "human_share": r1(100 * len(human) / len(known)) if known else None,
        "known_cause": len(known),
    }


def demand_block(fs, totals, d):
    eras = {}
    for e in (0, 1):
        sub = [f for f in fs if f["era"] == e]
        eras[e] = era_stats(sub, *totals[e], d)
    count_by_year = defaultdict(int)
    acres_by_year = defaultdict(float)
    for f in fs:
        count_by_year[f["year"]] += 1
        acres_by_year[f["year"]] += f["acres"]
    old = [count_by_year[y] for y in ERA0]
    s = slope(list(ERA0), old)
    mean_old = st.fmean(old) or 1
    per_decade_pct = r1(100 * s * 10 / mean_old)
    decades = defaultdict(lambda: {"count": 0, "acres": 0.0})
    for f in fs:
        decades[decade(f["year"])]["count"] += 1
        decades[decade(f["year"])]["acres"] += f["acres"]
    return {
        "eras": eras,
        "yearly": {"years": YEARS, "count": [count_by_year[y] for y in YEARS],
                   "acres": [round(acres_by_year[y]) for y in YEARS]},
        "decades": {k: {"count": v["count"], "acres": round(v["acres"])} for k, v in sorted(decades.items())},
        "trend_pct_per_decade": per_decade_pct,
        "trend": "up" if per_decade_pct > 10 else "down" if per_decade_pct < -10 else "flat",
    }


def calendar_block(fs):
    weeks = {e: [0] * 52 for e in (0, 1)}
    by_dec = defaultdict(list)
    for f in fs:
        weeks[f["era"]][iso_week(f["year"], f["doy"]) - 1] += 1
        by_dec[decade(f["year"])].append(f["doy"])
    peak = {e: (w.index(max(w)) + 1 if max(w) else None) for e, w in weeks.items()}
    season = {}
    for dec, ds in sorted(by_dec.items()):
        if len(ds) >= 20:
            a, b = pct(ds, 0.10), pct(ds, 0.90)
            season[dec] = {"start": round(a), "end": round(b), "days": round(b - a), "n": len(ds)}
    return {"weeks": weeks, "peak_week": peak, "season": season}


def causes_block(fs, d):
    decs = sorted({decade(f["year"]) for f in fs})
    share, human = [], []
    for dec in decs:
        sub = [f for f in fs if decade(f["year"]) == dec]
        n = len(sub) or 1
        share.append([r1(100 * sum(1 for f in sub if f["cause"] == k) / n) for k in range(len(d["causes"]))])
        known = [f for f in sub if f["cause"] != len(d["causes"]) - 1]
        human.append(r1(100 * sum(1 for f in known if d["human"][f["cause"]]) / len(known)) if known else None)
    return {"decades": decs, "share": share, "human_share": human}


def tercile_summary(rows, cuts):
    groups = {"dry": [], "normal": [], "wet": []}
    for r in rows:
        if r["rain_pct"] is None:
            continue
        g = "dry" if r["rain_pct"] <= cuts[0] else "wet" if r["rain_pct"] > cuts[1] else "normal"
        groups[g].append(r)
    out = {}
    for g, rs in groups.items():
        out[g] = {"years": len(rs),
                  "median_count": r1(st.median([r["count"] for r in rs])) if rs else None,
                  "median_acres": r1(st.median([r["acres"] for r in rs])) if rs else None,
                  "mean_acres": r1(st.fmean([r["acres"] for r in rs])) if rs else None}
    dry, wet = out["dry"]["median_acres"], out["wet"]["median_acres"]
    out["dry_vs_wet_acres"] = r1(dry / wet) if dry is not None and wet else None
    dc, wc = out["dry"]["median_count"], out["wet"]["median_count"]
    out["dry_vs_wet_count"] = r1(dc / wc) if dc is not None and wc else None
    return out


def weather_block(area, fs, weather, weights):
    """Area-year table: fire-weighted mean weather of member counties vs Jul-Sep fires."""
    members = [c for c in area["counties"] if c in weather]
    if not members:
        return None
    summer = defaultdict(lambda: [0, 0.0])
    for f in fs:
        if 182 <= f["doy"] <= 273:      # ~Jul 1 - Sep 30
            summer[f["year"]][0] += 1
            summer[f["year"]][1] += f["acres"]
    rows = []
    for y in YEARS:
        vals = {}
        for key in ("rain_pct", "tmax", "streak"):
            pts = [(weather[c][y][key], max(weights.get(c, 0), 1)) for c in members
                   if y in weather[c] and weather[c][y].get(key) is not None]
            vals[key] = sum(v * w for v, w in pts) / sum(w for _, w in pts) if pts else None
        rows.append({"year": y, "rain_pct": r1(vals["rain_pct"]), "tmax": r1(vals["tmax"]),
                     "dry_streak": r1(vals["streak"]), "count": summer[y][0], "acres": round(summer[y][1])})
    old = [r for r in rows if r["year"] in ERA0]
    new = [r for r in rows if 2008 <= r["year"] < THIS_YEAR]
    log_acres = lambda rs: [math.log1p(r["acres"]) for r in rs]
    corr = {}
    for key in ("rain_pct", "tmax", "dry_streak"):
        corr[key] = {"count": pearson([r[key] for r in old], [r["count"] for r in old]),
                     "log_acres": pearson([r[key] for r in old], log_acres(old))}
    rp = [r["rain_pct"] for r in old if r["rain_pct"] is not None]
    cuts = [r1(pct(rp, 1 / 3)), r1(pct(rp, 2 / 3))] if len(rp) >= 9 else None
    this = next(r for r in rows if r["year"] == THIS_YEAR)
    this_terc = None
    if cuts and this["rain_pct"] is not None:
        this_terc = "dry" if this["rain_pct"] <= cuts[0] else "wet" if this["rain_pct"] > cuts[1] else "normal"
    return {
        "counties_with_weather": len(members), "counties_total": len(area["counties"]),
        "rows": rows, "r": corr, "cuts": cuts,
        "terciles": tercile_summary(old, cuts) if cuts else None,
        "terciles_2008": tercile_summary(new, cuts) if cuts else None,
        "this_year": {"year": THIS_YEAR, "rain_pct": this["rain_pct"], "tercile": this_terc},
    }


# ---------- coverage ----------
def nearest_station_miles(fires, stations, cell=0.25):
    grid = defaultdict(list)
    for la, lo in stations:
        grid[(int(la // cell), int(lo // cell))].append((la, lo))
    min_cell_mi = cell * 69.0 * math.cos(math.radians(49.5))   # smallest cell edge in WA, miles
    out = []
    for f in fires:
        if f["lat"] is None:
            out.append(None)
            continue
        gx, gy = int(f["lat"] // cell), int(f["lon"] // cell)
        best, ring = float("inf"), 0
        while ring < 40:
            for dx in range(-ring, ring + 1):
                for dy in range(-ring, ring + 1):
                    if max(abs(dx), abs(dy)) != ring:
                        continue
                    for la, lo in grid.get((gx + dx, gy + dy), ()):
                        best = min(best, haversine(f["lat"], f["lon"], la, lo))
            if best <= ring * min_cell_mi:
                break
            ring += 1
        out.append(best)
    return out


def coverage_block(fs):
    located = [f for f in fs if f["dist"] is not None]
    if not located:
        return None
    far = [f for f in located if f["dist"] > FAR_MI]
    return {"fires_located": len(located), "median_mi": r1(st.median(f["dist"] for f in located)),
            "pct_far": r1(100 * len(far) / len(located)), "fires_far": len(far),
            "acres_far": round(sum(f["acres"] for f in far)),
            "acres_far_share": r1(100 * sum(f["acres"] for f in far) / (sum(f["acres"] for f in located) or 1))}


def add_gap_scores(cov, keys):
    """Gap score 0-100 = percentile rank of acres burned >10 mi out x percentile rank of fire count."""
    keys = [k for k in keys if cov.get(k)]
    if len(keys) < 2:
        return
    ra = ranks([cov[k]["acres_far"] for k in keys])
    rc = ranks([cov[k]["fires_located"] for k in keys])
    n = len(keys)
    for k, a, c in zip(keys, ra, rc):
        cov[k]["gap_score"] = round(100 * (a / n) * (c / n))


# ---------- main ----------
def main():
    d, fires = load()
    areas = build_areas(d)
    stations = json.loads((WEB / "stations.json").read_text())
    for f, dist in zip(fires, nearest_station_miles(fires, stations)):
        f["dist"] = dist
    weather = load_weather(d["counties"])
    weights = defaultdict(int)
    for f in fires:
        if f["era"] == 0:
            weights[f["county"]] += 1

    totals = {e: (sum(1 for f in fires if f["era"] == e), sum(f["acres"] for f in fires if f["era"] == e))
              for e in (0, 1)}
    by_county = defaultdict(list)
    for f in fires:
        by_county[f["county"]].append(f)

    demand, calendar, causes, wlink, coverage = {}, {}, {}, {}, {}
    for key, area in areas.items():
        fs = [f for c in area["counties"] for f in by_county[c]]
        meta = {k: v for k, v in area.items() if k != "counties"}
        demand[key] = {**meta, **demand_block(fs, totals, d)}
        calendar[key] = calendar_block(fs)
        causes[key] = causes_block(fs, d)
        wlink[key] = weather_block(area, fs, weather, weights)
        coverage[key] = coverage_block(fs)
    add_gap_scores(coverage, d["counties"])
    add_gap_scores(coverage, d["regions"])

    # ----- did it hold? -----
    cs = d["counties"]
    old_counts = [demand[c]["eras"][0]["count"] for c in cs]
    new_counts = [demand[c]["eras"][1]["count"] for c in cs]
    holdout = {
        "county_rank_spearman": spearman(old_counts, new_counts),
        "region_rank_spearman": spearman([demand[r]["eras"][0]["count"] for r in d["regions"]],
                                         [demand[r]["eras"][1]["count"] for r in d["regions"]]),
        "top5_old": [c for _, c in sorted(zip(old_counts, cs), reverse=True)[:5]],
        "top5_new": [c for _, c in sorted(zip(new_counts, cs), reverse=True)[:5]],
        "areas": {},
    }
    for key in ["ALL"] + d["regions"]:
        w = wlink[key]
        holdout["areas"][key] = {
            "peak_week": calendar[key]["peak_week"],
            "peak_shift_weeks": (calendar[key]["peak_week"][1] - calendar[key]["peak_week"][0])
            if None not in calendar[key]["peak_week"].values() else None,
            "human_share": [demand[key]["eras"][0]["human_share"], demand[key]["eras"][1]["human_share"]],
            "dry_vs_wet_acres": [w["terciles"]["dry_vs_wet_acres"], w["terciles_2008"]["dry_vs_wet_acres"]]
            if w and w["terciles"] else None,
        }

    # ----- allocation for this season -----
    alloc = []
    reg_gap = {r: (coverage[r] or {}).get("gap_score", 0) for r in d["regions"]}
    gap_cut = pct(list(reg_gap.values()), 0.75)
    for r in d["regions"]:
        e0 = demand[r]["eras"][0]
        hist = 0.5 * e0["share_count"] + 0.5 * e0["share_acres"]
        w = wlink[r]
        mult, terc, rain = 1.0, None, None
        if w and w["terciles"] and w["this_year"]["tercile"]:
            terc, rain = w["this_year"]["tercile"], w["this_year"]["rain_pct"]
            t = w["terciles"]
            base = t["normal"]["median_acres"]
            if base:
                mult = t[terc]["median_acres"] / base
            mult = min(max(mult, MULT_RANGE[0]), MULT_RANGE[1])
        boost = BOOST if reg_gap[r] >= gap_cut and reg_gap[r] > 0 else 0.0
        alloc.append({"region": r, "name": areas[r]["name"], "hist_share": r1(hist),
                      "share_count": e0["share_count"], "share_acres": e0["share_acres"],
                      "rain_pct": rain, "tercile": terc, "weather_mult": round(mult, 2),
                      "gap_score": reg_gap[r], "gap_boost": boost,
                      "raw": hist * mult * (1 + boost)})
    total = sum(a["raw"] for a in alloc)
    for a in alloc:
        a["pct"] = r1(100 * a.pop("raw") / total)
    drift = round(100 - sum(a["pct"] for a in alloc), 1)
    max(alloc, key=lambda a: a["pct"])["pct"] = r1(max(a["pct"] for a in alloc) + drift)
    alloc.sort(key=lambda a: -a["pct"])
    allocation = {"year": THIS_YEAR, "boost": BOOST, "mult_range": MULT_RANGE,
                  "weather_counties": len(weather), "total_counties": len(cs), "regions": alloc}

    meta = {"generated": dt.datetime.now().isoformat(timespec="minutes"),
            "far_miles": FAR_MI, "stations": len(stations),
            "areas": [{"key": k, "name": a["name"], "type": a["type"], "region": a.get("region")}
                      for k, a in areas.items()],
            "causes": d["causes"], "human": d["human"]}
    for name, obj in {"meta": meta, "demand": demand, "calendar": calendar, "causes": causes,
                      "weather_link": wlink, "coverage": coverage, "holdout": holdout,
                      "allocation": allocation}.items():
        (WEB / f"{name}.json").write_text(json.dumps(obj, separators=(",", ":")))

    a = demand["ALL"]["eras"]
    print(f"fires: {a[0]['count']} (1970-2007) + {a[1]['count']} (2008+); weather for {len(weather)}/{len(cs)} counties")
    print(f"human-caused share (known causes): {a[0]['human_share']}% -> {a[1]['human_share']}%")
    print(f"county rank Spearman 1970-2007 vs 2008+: {holdout['county_rank_spearman']}")
    print("allocation:", ", ".join(f"{x['region']} {x['pct']}%" for x in alloc), f"(sum {sum(x['pct'] for x in alloc):.1f})")


if __name__ == "__main__":
    main()
