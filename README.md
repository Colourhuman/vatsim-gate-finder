# VATSIM Gate Finder 3.0

## Warum diese Version schneller/stabiler ist

Render hatte wiederholt Timeouts bei öffentlichen Overpass-Instanzen. Deshalb:

- Kein sequentielles Abfragen von drei Overpass-Servern.
- Airport-Koordinaten kommen aus OurAirports (tägliche Open-Data-Aktualisierung).
- Gate-Daten kommen über den HPI Overpass Reverse Proxy.
- Gate-Daten werden serverseitig 7 Tage gecacht.
- VATSIM-Live-Daten bleiben dynamisch und werden höchstens alle 12 Sekunden neu geladen.

## Render

Build:
npm install

Start:
npm start

Optional:
OCCUPANCY_RADIUS_M=90
OSM_RADIUS_M=5000

## Test

/ api / health
/ api / gates ? icao=LDSP&airline=EWG&aircraft=A320

(Leerzeichen in den Pfaden natürlich entfernen.)
