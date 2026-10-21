# Fire-Watch: full build plan
**Resource Allocation Planner for WA DNR, built on 1970–2007 fire history, weather, and fire stations**

---

## 1. Context and goal
- **Event:** Seattle Kiro Buildathon, "Where does Washington burn?" It runs about 2 hours.
- **Judging:** a real official with a real need; it works end to end; we understand it; it looks professional; there's a creative insight; and we have an answer for "what's next."
  - The insight must be deterministic (counts, math, comparisons), not runtime AI.
  - Real WA wildfire data must be on screen.
  - Ground rule: never point blame at named individuals.
- **Team decisions:**
  - The user is an official doing **resource allocation**.
  - The app shows **historical trends plus weather**, with **fire stations** for coverage gaps.
  - The **main dataset is DNR Fire Statistics 1970–2007** (geo.wa.gov item `9252f966a4ef403d90cb8abeebd50703_3`).

### Persona
"Dana," a WA DNR Wildfire Division resource coordinator. Every spring Dana decides **where** to stage crews and engines across DNR's 6 regions, **when** to staff up, and **which areas are thin on coverage**.

### The one problem
"I have a fixed number of crews. Where and when do they matter most this season?"

### Demo one-liner
"38 years of DNR fire history matched with weather and today's fire stations. It tells Dana where fire demand has been, when it peaks, how weather shifts it, and where coverage is thin. We then checked that those patterns still hold in 2008–2026."

---

## 2. Data inventory (verified)

### 2a. Main dataset: DNR Fire Statistics 1970–2007
- **REST:** `https://gis.dnr.wa.gov/site3/rest/services/Public_Wildfire/WADNR_PUBLIC_WD_WildFire_Data/MapServer/3/query`
- **Size:** 38,116 points. maxRecordCount is 2000, so we page with `resultOffset`.
- **Fields:**
  - `FIREEVNT_NM` (name, often null)
  - `COUNTY_LABEL_NM`
  - `FIREGCAUSE_LABEL_NM`
  - `ACRES_BURNED`
  - `START_DT` (epoch ms)
  - `FIREEVNT_CLASS_LABEL_NM`
  - point geometry
- **Cause values (n / acres):**
  - Debris Burn 9,447 / 57.5k
  - Miscellaneou(s) 7,918 / 242.7k
  - Recreation 6,337 / 23.1k
  - Lightning 5,490 / 274.8k
  - Children 3,315 / 12.3k
  - Arson 1,969 / 43.7k
  - Smoker 1,637 / 18.8k
  - Railroad 964 / 5.4k
  - Logging 658 / 9.1k
  - None 381 / **297.7k** (a few huge fires with no cause recorded)
- **Classes:** Classified 36,101; Unclassified 1,571; Other Agency 441; Out of State 3.
- **Counties:** 39 values plus 3 nulls. The busiest are Spokane 5,151, Stevens 4,534, Thurston 2,644, Okanogan 2,628, and Klickitat 2,057.
  - Ag counties are near zero (Adams 2, Benton 2, Franklin 4, Grant 6).
  - **Caveat:** the dataset covers **DNR-protected lands only**, so we label the app that way and never imply statewide totals.
- **What it lacks:** region, escape reason, and control or out times.

### 2b. "Did it hold?" check data: 2008–present (local)
- **File:** `Data/DNR_Fire_Statistics_2008_-_Present.csv`, about 30.5k rows.
- **Fields we use:** COUNTY_LABEL_NM, REGION_NAME, FIREGCAUSE_LABEL_NM, ACRES_BURNED, DSCVR_DT, LAT_COORD, LON_COORD, PROTECTION_TYPE.
- **Filter:** keep `PROTECTION_TYPE` values that start with "DNR Protection" so the comparison is like-for-like.
- **Also used:** this file provides the **county → DNR region lookup** (NORTHEAST, SOUTHEAST, PACIFIC CASC, SO PUGET, NORTHWEST, OLYMPIC).

### 2c. Weather: Open-Meteo Historical Archive (free, no key)
- **Request:** `https://archive-api.open-meteo.com/v1/archive?latitude=..&longitude=..&start_date=1970-01-01&end_date=<yesterday>&daily=precipitation_sum,temperature_2m_max,relative_humidity_2m_min,wind_gusts_10m_max&timezone=America/Los_Angeles`
- **Locations:** one call per county, using the **median lat/lon of that county's fires** (weather where fires happen, not the geographic center). That's 39 calls, cached to disk.

### 2d. Fire stations
- **Primary:** HIFLD Open, `maps.nccs.nasa.gov/.../hifld_open/emergency_services/FeatureServer/4`. It **timed out when we tested**, so don't depend on it.
- **Fallback, likely what we use:** OpenStreetMap Overpass, which is free and reliable. POST to `https://overpass-api.de/api/interpreter`:
  `[out:json][timeout:90];area["ISO3166-2"="US-WA"]->.a;nwr["amenity"="fire_station"](area.a);out center;`
- **Caveat:** these are current stations, which is intentional ("today's network vs. historic demand"). They are mostly municipal and district stations, not DNR crew bases. We say so in the app.

### 2e. DNR live pages (links only, no API)
- The current-incident page and the investigations page offer **no machine-readable data**.
- We use them as **link-outs** in a "Right now" panel:
  - DNR Fire Dashboard: `https://experience.arcgis.com/experience/6cdda73cf6154949a1fae76ccb2900a0`
  - Burn Risk Map: `https://fortress.wa.gov/dnr/protection/firedanger/`
  - IFPL levels: `https://fortress.wa.gov/dnr/protection/ifpl/`
  - NWCC briefings: `http://gacc.nifc.gov/nwcc/`
- **Validation hook:** DNR's investigations page states "about 85% of WA wildfires are human-caused." We compute the human-caused share from our data and show it next to that statement.
- We do **not** use any investigation or case content, per the ground rule.

---

## 3. Data normalization

### Unified fire record
| field | 1970–2007 source | 2008+ source |
|---|---|---|
| `id` | OBJECTID | OBJECTID |
| `era` | "1970-2007" | "2008-present" |
| `date` | START_DT ms → ISO | DSCVR_DT → ISO |
| `year`, `month`, `week` | derived | derived |
| `county` | COUNTY_LABEL_NM | COUNTY_LABEL_NM |
| `region` | lookup from 2008+ | REGION_NAME |
| `cause_raw` | FIREGCAUSE_LABEL_NM | FIREGCAUSE_LABEL_NM |
| `cause_group` | crosswalk ↓ | crosswalk ↓ |
| `human` | true unless the group is Lightning or Unknown | same |
| `acres` | ACRES_BURNED | ACRES_BURNED |
| `lat`, `lon` | geometry (outSR=4326) | LAT_COORD / LON_COORD |

### Cause crosswalk (shared groups)
| group | 1970–2007 values | 2008+ values |
|---|---|---|
| Lightning | Lightning | Natural |
| Debris burning | Debris Burn | Debris Burn |
| Recreation / Campfire | Recreation | Celebration (campfire), Recreation |
| Smoking | Smoker | Smoking |
| Equipment / Rail / Logging | Logging, Railroad | Equip/Vehicle, Power Gen, Railroad |
| Arson | Arson | Arson |
| Children | Children | Under 18 / Children (if present) |
| Fireworks | (not split out, so it falls into Misc) | Fireworks |
| Other / Unknown | Miscellaneou, None, null | Undetermine, Miscellaneous, DNR NOT RESPONSIBLE, blank |

The exact 2008+ values are confirmed during build by running a `Group-Object` on the CSV.

### Exclusions
- Drop the 3 null-county rows and the 3 "Out of State" rows.
- Drop rows with no geometry from the map views only, and keep them in the counts.

---

## 4. Analysis definitions (all precomputed in `scripts/analyze.py`)

1. **Demand by area.** For each county and region:
   - fire count, total acres, median acres, share of the state total
   - fires per decade (1970s, 80s, 90s, 2000s)
   - trend arrow, from the slope of yearly counts
2. **Season calendar.** For each region:
   - fires by ISO week, as a 52-bin histogram
   - peak week
   - season start and end, defined as the 10th and 90th percentile day-of-year, per decade (this shows whether the season is getting longer)
3. **Cause mix.** For each region and decade, the share of each cause group, plus the human-caused share.
4. **Weather link.**
   - For each county-year, compute:
     - `spring_rain_pct`: Apr–Jun precipitation ÷ that county's 1970–2007 Apr–Jun mean
     - `summer_tmax`: Jul–Aug mean of daily max temperature
     - `max_dry_streak`: the longest run of days with <1 mm of rain from Jun to Sep
   - Outcomes: Jul–Sep fire count and acres.
   - Per region, report Pearson r for each predictor.
   - Split years into **terciles** of spring_rain_pct (dry, normal, wet) and report median summer count and acres for each, plus the ratio dry ÷ wet.
5. **Coverage gap.**
   - For each fire, compute the haversine distance in miles to the nearest station, using a simple grid bucket for speed.
   - For each county, report median distance, the % of fires more than 10 mi from a station, and acres burned more than 10 mi from a station.
   - **Gap score** = acres beyond 10 mi × fire frequency rank.
6. **Did it hold? (1970–2007 vs. 2008+)**
   - Spearman rank correlation of county fire counts between the eras.
   - Peak-week shift for each region.
   - Change in human-caused share.
   - Whether dry-spring years still have more summer acres (rerun step 4 on 2008+).
7. **This year and allocation.**
   - Compute 2026 Apr–Jun rain % from the archive and place it in each county's tercile.
   - For each region, demand = (historical acres share, 1970–2007) × (that tercile's median-acres ratio vs. normal).
   - Apply a small boost of +10–20% for regions in the top gap-score quartile.
   - Normalize to 100%.
   - Every number links to the view that explains it.

---

## 5. Website

**Stack:** static `index.html` + `app.js` + `styles.css`, with Leaflet, Leaflet.heat, and Chart.js from cdnjs. It's served with `python -m http.server`. There's no build step, so nothing can break in setup.

**Layout:**
- A header holds the title, a "DNR-protected lands" badge, and a region/county picker.
- Six tabs or stacked sections:
  1. **Overview:** KPI tiles (fires, acres, peak week, human-caused %, plus "DNR says ~85%" next to our number) and a Leaflet heat map of 1970–2007 fires with a decade slider.
  2. **Trends:** fires and acres per year from 1970 to 2026, with a shaded band separating the eras. A cause-mix stacked bar by decade.
  3. **Season:** a region × week heatmap and the season-length trend by decade.
  4. **Weather:** a spring-rain % vs. summer-acres scatter for the selected county with r. Tercile bars (dry, normal, wet).
  5. **Coverage:** station points with a fire heat layer and a ranked "thin coverage" county table.
  6. **Allocation:** the suggested % per region as a bar and table, a "why" line for each region, and the "Did it hold?" cards.
- A **Right now** sidebar links out to the DNR Fire Dashboard, Burn Risk Map, IFPL, and NWCC.

**Style:** a calm, official look with a dark slate header, ember-orange accents for fire data, a blue scale for rain, and readable sans-serif type. Every chart has a one-sentence takeaway above it.

---

## 6. Files
```
Fire-Watch/
  scripts/
    fetch_fires.py      # page layer 3 → data/raw/fires_1970_2007.geojson
    fetch_weather.py    # 39 county series → data/raw/weather/<county>.json
    fetch_stations.py   # HIFLD, else Overpass → data/raw/stations.json
    build_data.py       # normalize + crosswalk + join → web/data/fires.json (compact arrays)
    analyze.py          # → web/data/{demand,calendar,causes,weather_link,coverage,holdout,allocation}.json
  web/
    index.html  app.js  styles.css  data/
  Data/ (existing CSV/geojson/kml)
```
**Size:** about 68k fires as compact arrays is about 3–4 MB of JSON, which is fine locally. Ship the aggregates separately so the charts load instantly.

---

## 7. Two-hour timeline and roles (3–4 people)

| Time | Person A: data | Person B: analysis | Person C: front end | Person D: story and QA |
|---|---|---|---|---|
| 0:00–0:20 | `fetch_fires.py` (layer 3 paging) | `fetch_weather.py` (start the 39 calls) | Scaffold page, Leaflet map, picker | Write persona and pitch, check cause values |
| 0:20–0:45 | `fetch_stations.py`, `build_data.py` (normalize, crosswalk) | Demand, calendar, and cause metrics | **First win: real 1970–2007 points on the map plus KPI tiles** | Spot-check counts against REST stats |
| 0:45–1:15 | Help with joins | Weather link, coverage gap | Trends, Season, and Weather tabs | Draft the "Did it hold?" copy |
| 1:15–1:35 | — | Holdout and allocation | Coverage and Allocation tabs | QA every picker path |
| 1:35–1:50 | Freeze data | — | Polish, takeaways, mobile check | Rehearse the demo |
| 1:50–2:00 | **Feature freeze** | | | |

**Cut order if we're behind:**
1. Drop the decade slider.
2. Drop the season-length trend.
3. Drop the allocation boost from coverage gaps.
4. Drop the Coverage tab.

**Never cut:** the map, trends, weather link, and the allocation table.

---

## 8. Demo script (about 3 minutes)
1. "This is Dana, DNR's resource coordinator. Every spring Dana has to split a fixed number of crews across 6 regions."
2. **Allocation tab first**, the thing that works: "This year, NE gets X%. Here's why."
3. Click through the why:
   - demand history on the map and in the trends
   - the season peak weeks
   - weather: "dry springs meant N× more summer acres"
   - coverage gaps: "these counties burn far from any station"
4. "Is 1970s data still relevant? We checked. The county rankings held (ρ = …), and the season shifted by … weeks."
5. "Next: live DNR fire danger and IFPL levels, a 16-day forecast, and ICS-209 personnel data to convert acres into crew counts."

---

## 9. Risks and fallbacks
| Risk | Fallback |
|---|---|
| DNR REST slow or down | Fetch once early and commit the GeoJSON. The 2008+ local CSV keeps the demo alive. |
| HIFLD timeout (already seen) | Overpass query. If both fail, skip the Coverage tab. |
| Open-Meteo rate limits | Space the calls about 1 second apart, cache them, and fetch these first. |
| Weather correlation turns out weak | Show it honestly ("weak in the west, strong in the east"), which is still an insight, and weight allocation on history only. |
| Old-data critique | The "Did it hold?" panel. |
| Blame concerns | No fire names in the UI, only aggregates by county and region. |

---

## 10. Verification
- `fires_1970_2007` count = 38,116. The cause totals match the REST `outStatistics` numbers listed above.
- Spot-check Okanogan acres for one year: our total vs. a REST query with `where=COUNTY_LABEL_NM='OKANOGAN' AND START_DT between …` and `outStatistics` sum.
- One county-day of rain matches the Open-Meteo web UI.
- The WA station count is plausible (several hundred to about 1k), and one station sits on the map where it should.
- Allocation percentages sum to 100. Changing the picker updates every tab with no console errors.
- Run `python -m http.server` from `web/` and click through all tabs in a browser at laptop and phone widths.
