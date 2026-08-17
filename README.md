# VATSIM Gate Finder STABLE

## Fix for "This operation was aborted"

The old build used the HPI Overpass proxy and aborted after 8.5 seconds.
This build removes that dependency.

Gate lookup now:
- uses the airport `icao` relation/area directly
- queries only OSM `gate` and `parking_position` nodes
- uses POST
- runs the global Private.coffee and overpass-api.de instances in parallel
- accepts the first useful response
- caches airport gate data for 7 days

Private.coffee explicitly documents its Overpass endpoint for application use and recommends POST for queries. The public Overpass directory lists it and overpass-api.de as global instances.

VATSIM occupancy remains separate and is updated independently.

## Render

Build Command:
npm install

Start Command:
npm start

No environment variables are required.
