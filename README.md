# VATSIM Gate Finder v14

The tool deliberately uses only two authoritative layers:
- OpenStreetMap `aeroway=parking_position` for physical stand positions.
- VATSIM live data for current aircraft occupancy.

It does **not** invent airline-to-gate assignments or gate sizes. A size is shown only when the OSM object explicitly provides an ICAO aircraft reference code. Duplicate physical positions are collapsed before display.

Airline input/rules from previous versions were removed because guessed allocations create false results. Real-world airline allocations vary by airport and operation and should not be inferred from a generic gate name.
