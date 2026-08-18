# VATSIM Gate Finder v15

Clean gate finder architecture:
- Gate/parking geometry: OpenStreetMap `aeroway=parking_position` only.
- Live occupancy: official VATSIM Data API.
- No IFATC data and no guessed airline/gate assignments.
- Airline and aircraft are searchable dark comboboxes, matching the ICAO input style.
- Aircraft compatibility is only marked when a real maximum wingspan/reference-code value exists in the source; unknown is never guessed.

Important limitation: VATSIM's live feed provides aircraft/callsign/position, not real-world gate assignments. OpenStreetMap also does not guarantee airline or gate-size metadata. Therefore the application never invents those values.
