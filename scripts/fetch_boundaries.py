"""Download WA DNR boundary layers (regions, counties, protection zones, dispatch) as simplified GeoJSON."""
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "raw" / "boundaries"
BASE = "https://gis.dnr.wa.gov/site3/rest/services"
LAYERS = {
    "dnr_regions": "Public_Boundaries/WADNR_PUBLIC_Cadastre_OpenData/MapServer/3",
    "counties": "Public_Boundaries/WADNR_PUBLIC_Cadastre_OpenData/MapServer/11",
    "forest_protection_zones": "Public_Wildfire/WADNR_PUBLIC_Wildfire_Administrative_Boundaries/MapServer/0",
    "dispatch_boundaries": "Public_Wildfire/WADNR_PUBLIC_Wildfire_Administrative_Boundaries/MapServer/1",
}
PAGE = 500


def query(layer, params):
    url = f"{BASE}/{layer}/query?" + urllib.parse.urlencode(params)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=180) as r:
                return json.load(r)
        except Exception as e:
            print(f"  retry {attempt + 1}: {e}")
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"failed: {url}")


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, layer in LAYERS.items():
        total = query(layer, {"where": "1=1", "returnCountOnly": "true", "f": "json"})["count"]
        features = []
        for offset in range(0, total, PAGE):
            features += query(layer, {
                "where": "1=1", "outFields": "*", "outSR": 4326, "f": "geojson",
                # ~200 m simplification keeps files small enough for a web map
                "maxAllowableOffset": 0.002, "geometryPrecision": 5,
                "resultOffset": offset, "resultRecordCount": PAGE,
            })["features"]
        out = OUT_DIR / f"{name}.geojson"
        out.write_text(json.dumps({"type": "FeatureCollection", "features": features}))
        print(f"{name}: {len(features)}/{total} features, {out.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
