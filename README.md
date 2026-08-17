# VATSIM Gate Finder v9

## Main fix

v8 still assumed a small area around the airport reference point. That is not
safe for large airports like Heathrow.

v9 first resolves the airport's real OpenStreetMap bounding box through
Nominatim, then tiles the COMPLETE airport bbox and reads all OSM
`parking_position` nodes and ways.

For parking-position ways the final member node is used as the nose-wheel stop
anchor.

## Occupancy

The VATSIM aircraft is considered at the airport based on spatial position,
NOT only on the flight-plan arrival/departure.

This fixes missing aircraft with:
- changed/incorrect flightplans
- blank flightplan airport fields
- unusual/virtual callsigns

Flightplan departure/arrival is only used as a sanity filter for fast-moving
aircraft outside the airport.

Every VATSIM aircraft is assigned to at most one physical stand.

Radii:
- stopped: 55 m
- 0-8 kt: 34 m
- >8 kt taxi: 18 m

## Debug

`/api/gates?icao=EGLL`

The JSON includes:
- `VATSIMAircraftInsideAirportBounds`
- `assignedAircraft`
- exact gate assignments with aircraft position and distance
- number of physical gate anchors

## Render

Build:
npm install

Start:
npm start

No Overpass and no gates.json are required.
