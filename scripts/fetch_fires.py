"""Download DNR Fire Statistics 1970-2007 (MapServer layer 3) as GeoJSON."""
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

URL = ("https://gis.dnr.wa.gov/site3/rest/services/Public_Wildfire/"
       "WADNR_PUBLIC_WD_WildFire_Data/MapServer/3/query")
OUT = Path(__file__).resolve().parent.parent / "data" / "raw" / "fires_1970_2007.geojson"
PAGE = 2000


def query(params):
    url = URL + "?" + urllib.parse.urlencode(params)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return json.load(r)
        except Exception as e:
            print(f"  retry {attempt + 1}: {e}")
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"failed: {url}")


def main():
    total = query({"where": "1=1", "returnCountOnly": "true", "f": "json"})["count"]
    print(f"expecting {total} fires")
    features = []
    for offset in range(0, total, PAGE):
        page = query({
            "where": "1=1", "outFields": "*", "outSR": 4326, "f": "geojson",
            "orderByFields": "OBJECTID", "resultOffset": offset, "resultRecordCount": PAGE,
        })
        features += page["features"]
        print(f"  {len(features)}/{total}")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"type": "FeatureCollection", "features": features}))
    print(f"wrote {len(features)} features to {OUT}")


if __name__ == "__main__":
    main()
