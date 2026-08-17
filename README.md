# VATSIM Gate Finder – Final

## What this version does

### Gate source strategy

1. If `gates.json` contains the requested airport, those curated positions are used.
   This is the high-accuracy source for airports you already verified.
2. If an airport is not present in `gates.json`, the service automatically discovers
   `aeroway=gate` and `aeroway=parking_position` nodes from OpenStreetMap through the
   HPI Overpass proxy.
3. Duplicate positions are collapsed by normalized stand name and distance.

This means you do NOT have to manually enter every new airport. Your existing
`gates.json` can remain as a high-confidence airport overlay, while unknown
airports are discovered automatically.

### Live VATSIM occupancy

VATSIM's public Data API v3 is queried separately and cached for 10 seconds.
The feed itself is regenerated every 15 seconds.

A pilot is assigned to at most one gate:
- parked aircraft: up to 70 m
- slow taxi: up to 65 m
- faster taxi: up to 32 m

The assignment is one-to-one, so the same aircraft cannot mark four gates as
occupied.

### Aircraft recognition

The service refreshes a public aircraft reference dataset every 7 days. It
supports ICAO and IATA designators and gets:
- aircraft name
- manufacturer
- wingspan
- inferred aerodrome reference category A-F

Examples:
A320, 320, A20N, 32N, B38M, 7M8, B738, etc.

### Airline recognition

A public airline reference dataset is refreshed every 7 days. Airline input can
be:
- ICAO code
- IATA code
- airline name
- telephony/callsign

The live VATSIM airline is resolved from the callsign prefix, with a fallback to
the raw three-letter prefix for virtual airlines or uncommon callsigns.

## Important limitation

VATSIM's live feed does not contain a "this aircraft is parked at stand X"
field. Occupancy must therefore be inferred from the aircraft's live latitude,
longitude and ground speed.

Likewise, a globally authoritative public database containing every airport's
current airline-to-stand restrictions does not exist. The service therefore uses
the verified `gates.json` data when available and OSM as a discovery fallback.
Unknown OSM restrictions are never invented.

## Render

Build Command:
`npm install`

Start Command:
`npm start`

Optional Environment Variables:
- `OCCUPANCY_RADIUS_M=65`
- `PARKED_RADIUS_M=70`
- `TAXI_RADIUS_M=32`
- `OSM_RADIUS_M=5000`

## Keep gates.json

Do NOT delete your existing `gates.json`.
It is now an automatic high-accuracy override for airports you have already
verified. You do not need to add every future airport to it.

## API

`GET /api/gates?icao=EDDK&airline=EWG&aircraft=A320`

`GET /api/health`
