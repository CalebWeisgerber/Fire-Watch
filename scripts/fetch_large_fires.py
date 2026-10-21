"""Download DNR's Washington Large Fires 1973-2025 perimeters (MapServer layer 0), DNR-protected only.

Source item: geo.wa.gov 6f31b076628d4f8ca5a964cbefd2cccc ("Washington Large Fires 1973-2025").
The layer mixes every agency (USFS, BLM, BIA, NPS, ...). We keep perimeters whose AGENCY is a
WA DNR region, which matches the app's DNR-protected-lands scope.
"""
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

URL = ("https://gis.dnr.wa.gov/site3/rest/services/Public_Wildfire/"
       "WADNR_PUBLIC_WD_WildFire_Data/MapServer/0/query")
OUT = Path(__file__).resolve().parent.parent / "Data" / "raw" / "large_fires_dnr.geojson"
WHERE = "AGENCY LIKE '%DNR%'"
PAGE = 200


def query(params):
    url = URL + "?" + urllib.parse.urlencode(params)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=180) as r:
                return json.load(r)
        except Exception as e:
            print(f"  retry {attempt + 1}: {e}")
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"failed: {url}")


def main():
    total = query({"where": WHERE, "returnCountOnly": "true", "f": "json"})["count"]
    print(f"expecting {total} DNR large-fire perimeters")
    feats = []
    for offset in range(0, total, PAGE):
        feats += query({
            "where": WHERE, "outFields": "OBJECTID,AGENCY,YEAR,STARTDATE,ACRES,CAUSE",
            "outSR": 4326, "f": "geojson", "orderByFields": "OBJECTID",
            # ~100 m simplification keeps the file web-sized
            "maxAllowableOffset": 0.001, "geometryPrecision": 4,
            "resultOffset": offset, "resultRecordCount": PAGE,
        })["features"]
        print(f"  {len(feats)}/{total}")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"type": "FeatureCollection", "features": feats}))
    print(f"wrote {len(feats)} perimeters to {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
