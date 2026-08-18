# VATSIM Gate Finder v15

Gate inventory: IFATC + OpenStreetMap.
Live occupancy: official VATSIM public data feed.

The occupancy matcher was revised to account for the fact that VATSIM aircraft coordinates do not necessarily fall exactly on the scenery stand coordinate. It uses speed-dependent stand radii and flight-plan airport relevance, while preventing one aircraft from occupying multiple stands.
