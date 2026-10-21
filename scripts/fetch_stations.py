"""Download Washington fire stations: HIFLD first, OpenStreetMap Overpass as fallback."""
import json
import urllib.parse
import urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data" / "raw" / "stations.json"
HIFLD = ("https://maps.nccs.nasa.gov/mapping/rest/services/hifld_open/"
         "emergency_services/FeatureServer/4/query")
OVERPASS = "https://overpass-api.de/api/interpreter"
OVERPASS_QUERY = """[out:json][timeout:120];
area["ISO3166-2"="US-WA"]->.a;
nwr["amenity"="fire_station"](area.a);
out center;"""


def from_hifld():
    params = {"where": "STATE='WA'", "outFields": "*", "outSR": 4326, "f": "geojson"}
    with urllib.request.urlopen(HIFLD + "?" + urllib.parse.urlencode(params), timeout=60) as r:
        feats = json.load(r)["features"]
    return [{"name": f["properties"].get("NAME"), "lat": f["geometry"]["coordinates"][1],
             "lon": f["geometry"]["coordinates"][0], "source": "HIFLD"} for f in feats]


def from_overpass():
    data = urllib.parse.urlencode({"data": OVERPASS_QUERY}).encode()
    req = urllib.request.Request(OVERPASS, data=data, headers={"User-Agent": "fire-watch-buildathon"})
    with urllib.request.urlopen(req, timeout=180) as r:
        elements = json.load(r)["elements"]
    out = []
    for e in elements:
        lat = e.get("lat") or e.get("center", {}).get("lat")
        lon = e.get("lon") or e.get("center", {}).get("lon")
        if lat is not None:
            out.append({"name": e.get("tags", {}).get("name"), "lat": lat, "lon": lon, "source": "OSM"})
    return out


def main():
    try:
        stations = from_hifld()
        if not stations:
            raise RuntimeError("HIFLD returned no stations")
    except Exception as e:
        print(f"HIFLD failed ({e}); using Overpass")
        stations = from_overpass()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(stations))
    print(f"wrote {len(stations)} stations ({stations[0]['source']}) to {OUT}")


if __name__ == "__main__":
    main()
