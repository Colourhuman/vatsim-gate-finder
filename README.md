# VATSIM Gate Finder v12

This version fixes two major classes of problems:

1. **Airline rules were not actually connected to gate compatibility.**
   The project now contains `airport-rules.json` with airline aliases and airport-specific terminal/apron rules. Gate cards show the airline assignment and the reason a gate is incompatible.
2. **Live VATSIM aircraft could disappear or be assigned to the wrong stand.**
   Occupancy now uses a stable one-to-one proposal algorithm instead of a simple greedy nearest-gate assignment. The search radius also accounts for the difference between a VATSIM aircraft reference position and an OSM parking-position anchor.

## Live data

VATSIM's public Data API regenerates its live network feed every 15 seconds. The feed contains pilot coordinates, groundspeed, callsign and filed aircraft/route information. The server refreshes this feed every 10 seconds, so it normally sees the newest VATSIM snapshot within one feed interval. See https://vatsim.dev/api/data-api/get-network-data/.

## Airline rules

`airport-rules.json` contains:

- airline ICAO/IATA/callsign aliases
- airport-specific terminal/apron rules
- gate/pier regexes
- airline restrictions
- labels displayed in the UI

Current airport rule sets include: EDDF, EDDK, EDDL, EDDS, EDDM, EDDB, EGLL, EHAM and LFPG.

If an airport has no rule set, the tool does **not** invent an airline restriction. It still uses the live physical gate data and aircraft-size compatibility.

## Frankfurt example

The EDDF rules deliberately do not mark Terminal 3 as universally valid for Condor. VATSIM Germany's current Frankfurt guidance lists a specific set of non-Star Alliance airlines for Pier J, while Condor is not in that list. See https://knowledgebase.vatsim-germany.org/books/airports-langen-fir-edgg/page/general and the EDDF apron guidance.

## Occupancy

The aircraft-to-stand matching uses:

- parked aircraft: 85 m
- slow aircraft: 55 m
- taxiing aircraft: 32 m

These are configurable with `PARKED_RADIUS_M`, `SLOW_RADIUS_M` and `TAXI_RADIUS_M`.

Every aircraft can occupy at most one stand and every stand can be occupied by at most one aircraft. If two aircraft compete for the same stand, the lower-cost assignment wins and the displaced aircraft tries its next-best stand.

## Endpoints

- `GET /api/gates?icao=EDDF&airline=CFG&aircraft=A320`
- `GET /api/airlines`
- `GET /api/health`
- `GET /api/refresh/EDDF`

The `/api/gates` response contains a `debug` section with:

- aircraft inside the airport boundary
- assigned aircraft
- aircraft that were inside but could not be mapped to a stand
- exact distance/radius for each assignment
- failed OSM tiles

## Render

Build command:

`npm install`

Start command:

`npm start`

No `gates.json` is required.
