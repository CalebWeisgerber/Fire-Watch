"""Download daily weather (1970 -> yesterday) per county from the Open-Meteo archive.

One location per county: the median lat/lon of that county's 1970-2007 fires, so the
weather is sampled where fires actually happen. Results are cached; existing files are skipped.
"""
import datetime as dt
import json
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIRES = ROOT / "Data" / "raw" / "fires_1970_2007.geojson"
OUT = ROOT / "Data" / "raw" / "weather"
URL = "https://archive-api.open-meteo.com/v1/archive"
DAILY = "precipitation_sum,temperature_2m_max"


def county_points():
    pts = defaultdict(list)
    for f in json.loads(FIRES.read_text())["features"]:
        c = f["properties"]["COUNTY_LABEL_NM"]
        if c and f["geometry"]:
            lon, lat = f["geometry"]["coordinates"]
            pts[c].append((lat, lon))
    return {c: [round(statistics.median(p[0] for p in v), 4), round(statistics.median(p[1] for p in v), 4)]
            for c, v in sorted(pts.items())}


def fetch(lat, lon, end):
    params = {"latitude": lat, "longitude": lon, "start_date": "1970-01-01", "end_date": end,
              "daily": DAILY, "timezone": "America/Los_Angeles"}
    url = URL + "?" + urllib.parse.urlencode(params)
    for attempt in range(6):
        try:
            with urllib.request.urlopen(url, timeout=180) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            wait = 65 if e.code == 429 else 5 * (attempt + 1)
            print(f"  HTTP {e.code}; waiting {wait}s")
            time.sleep(wait)
        except Exception as e:
            print(f"  retry {attempt + 1}: {e}")
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"failed: {url}")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    points = county_points()
    (OUT / "_points.json").write_text(json.dumps(points, indent=1))
    end = (dt.date.today() - dt.timedelta(days=2)).isoformat()
    for county, (lat, lon) in points.items():
        path = OUT / f"{county}.json"
        if path.exists():
            continue
        print(f"{county} ({lat}, {lon})")
        data = fetch(lat, lon, end)
        path.write_text(json.dumps({"county": county, "lat": lat, "lon": lon, "daily": data["daily"]}))
        time.sleep(2)
    print(f"done: {len(list(OUT.glob('[A-Z]*.json')))} counties cached")


if __name__ == "__main__":
    main()
