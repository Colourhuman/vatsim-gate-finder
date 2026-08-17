# VATSIM Gate Finder v8

## Why v8

The critical previous bug was that v7 ignored OSM `aeroway=parking_position`
ways. OSM documents that parking positions can be mapped as nodes OR ways,
and for a way the last node is the nose-wheel stop position.

v8 parses:
- parking_position nodes
- parking_position ways
- gate nodes
- gate ways

For parking_position ways, the final member node is used as the physical stand
anchor.

## Occupancy model

VATSIM positions are checked against the physical parking-position anchor, not
the passenger terminal gate marker.

Approximate tolerance:
- stopped: aircraft-size-aware, 45m minimum
- slow movement: 34m
- taxiing: 18m

A one-to-one assignment prevents one aircraft from occupying multiple stands.

## Sources

- VATSIM public Data API v3 for live lat/lon/groundspeed/aircraft_short/flightplan
- IFATC for gate list and size class
- OpenStreetMap API for exact physical parking-position anchors

No gates.json required.

## Render

Build:
npm install

Start:
npm start

Debug:
GET /api/health
GET /api/gates?icao=EDDK&airline=EWG&aircraft=A320
GET /api/refresh/EDDK
