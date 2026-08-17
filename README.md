# VATSIM Gate Finder v7

## Exact stand occupancy

The important change in v7 is that VATSIM occupancy is NOT checked against the
passenger terminal gate marker.

Instead:

1. IFATC supplies the gate/stand name and size class.
2. The server looks for the matching OSM `aeroway=parking_position`.
3. That parking-position coordinate becomes the physical stand anchor.
4. An OSM `aeroway=gate` node is used only as a fallback.
5. VATSIM latitude/longitude is checked against that physical anchor.
6. Groundspeed changes the radius:
   - stopped: 45 m
   - slow movement: 28 m
   - taxiing: 14 m
7. A global one-to-one assignment ensures a pilot can occupy exactly one stand.

The VATSIM feed provides latitude, longitude, groundspeed, aircraft_short and
flight plan departure/arrival.

## Gate data

Gate metadata comes from IFATC. OSM supplies physical coordinates.
No gates.json is required.

## Render

Build:
npm install

Start:
npm start

Optional environment variables:
PARKED_RADIUS_M=45
SLOW_RADIUS_M=28
TAXI_RADIUS_M=14

## Debug

`/api/health`

`/api/gates?icao=EDDK&airline=EWG&aircraft=A320`

Force fresh gate coordinates:
`/api/refresh/EDDK`
