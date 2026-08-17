# VATSIM Gate Finder – Automated

Diese Variante entfernt die manuelle Gate-Pflege als Voraussetzung für den Betrieb.

## Datenquellen

- Gate-/Standpositionen: OpenStreetMap via Overpass
- Live-VATSIM-Belegung: `https://data.vatsim.net/v3/vatsim-data.json`
- VATSIM-Livefeed wird von VATSIM alle 15 Sekunden neu erzeugt.

## Belegungslogik

Ein Gate gilt als belegt, wenn sich ein VATSIM-Pilot innerhalb von `OCCUPANCY_RADIUS_M`
befindet. Standard: 90 m.

Render Environment Variable:
`OCCUPANCY_RADIUS_M=90`

## Render

Node.js Web Service, Start:

`npm install && node server.js`

Node 18+ empfohlen (für eingebautes `fetch`).

## Wichtige Grenze

OpenStreetMap kann Positionen sehr gut liefern, aber Airline-Zuordnungen sind nicht
an jedem Flughafen vollständig gepflegt. Deshalb gilt:

1. Gate mit Airline-Tag -> Airline muss passen.
2. Gate ohne Airline-Tag -> als allgemein nutzbar behandeln.
3. Aircraft-Kompatibilität -> ICAO-Code -> Kategorie / Spannweite.
4. VATSIM-Belegung -> geografische Distanz.

Damit braucht der Betreiber keine vollständige `gates.json` mehr.
