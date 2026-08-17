# VATSIM Gate Finder 2.1

## Änderungen gegenüber der ersten Version

- Airport wird zuerst per ICAO aus OSM ermittelt.
- Kein OSM-`area`-Lookup mehr.
- Gate-Daten werden anschließend im Umkreis des Airport-Zentrums gesucht.
- `aeroway=parking_position` wird als Node UND Way verarbeitet.
- `aeroway=gate` wird ebenfalls verarbeitet.
- Overpass-Anfragen nutzen GET und bis zu 35 Sekunden Client-Timeout.
- Mehrere Overpass-Server sind als Fallback hinterlegt.
- VATSIM-Ausfall verhindert nicht mehr das Laden der Gate-Liste.
- OSM-Ergebnisse werden 24 h serverseitig gecacht.
- VATSIM wird maximal alle 12 Sekunden neu geladen.
- `OVERPASS_RADIUS_M` und `OCCUPANCY_RADIUS_M` können über Render Environment Variables angepasst werden.

## Render

Build:
npm install

Start:
npm start

Optional:
OVERPASS_RADIUS_M=5000
OCCUPANCY_RADIUS_M=90
