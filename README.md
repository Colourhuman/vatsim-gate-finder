# VATSIM Gate Finder STABLE-6

## Key change

This build no longer depends on Overpass.

Gate metadata:
- IFATC gate list: gate/stand names and aircraft width class A-F
- OpenStreetMap standard Map API: node coordinates for `aeroway=gate` and `aeroway=parking_position`
- VATSIM Data API v3: live occupancy

OSM is accessed with small bbox tiles around the airport instead of Overpass.
The airport never fails solely because an Overpass instance is unavailable.

## Render

Build:
npm install

Start:
npm start

No special environment variables required.

## Notes

IFATC does not provide a universal current airline-to-stand mapping. The finder
therefore never invents one. Airline is retained as the selected operating
context while aircraft compatibility is checked from the IFATC A-F gate class.

VATSIM occupancy is inferred from aircraft position + flightplan departure/arrival
+ ground speed. Each VATSIM pilot can occupy only one gate.
