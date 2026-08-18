# VATSIM Gate Finder v14

The gate inventory is no longer limited to OpenStreetMap `aeroway=parking_position` objects.

Sources:
- IFATC airport gate inventory: complete named airport positions where available.
- OpenStreetMap: physical coordinates and additional gate/parking-position objects.
- VATSIM live data: current aircraft occupancy.

The inventory is merged by normalized stand reference, so a stand present in both sources appears once. IFATC-only stands remain visible even if OSM has no coordinate; such stands cannot be spatially matched to a live aircraft until a coordinate exists in OSM.

No airline-to-gate allocation is invented.
