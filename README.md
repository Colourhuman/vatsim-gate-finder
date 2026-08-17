# VATSIM Gate Finder 4.0

## Fixes

### 1. Doppelte Gates
V4 fragt für einzelne Stand-/Gate-Positionen nur noch OSM-Nodes ab.
`parking_position`-Ways sind Park-/Taxi-Spuren und wurden vorher als einzelne Gates
interpretiert. Zusätzlich werden gleich benannte Positionen innerhalb von 35 m
dedupliziert.

### 2. Ein Flugzeug belegt nur ein Gate
Die alte Logik prüfte jedes Gate separat. Deshalb konnte ein einzelnes Flugzeug
mehrere Gates rot machen.

V4 weist zuerst jedem VATSIM-Flug genau EIN nächstgelegenes Gate zu. Ein Gate kann
anschließend ebenfalls nur einen belegenden Flug bekommen.

### 3. Taxiende Flugzeuge werden nicht mehr als Gate-Belegung gezählt
Standard:
- Belegungsradius: 55 m
- maximale Groundspeed: 20 kt
- Ausnahme: innerhalb von 25 m darf ein Flugzeug auch etwas schneller sein.

### 4. Aircraft-Größe
V4 kennt für häufige ICAO-Typen:
- ICAO Aerodrome Reference Code A-F
- ungefähre Spannweite

Die ausgewählte Aircraft-Größe wird oben angezeigt.

### 5. Airline
Die Airline des VATSIM-Flugs wird aus dem Callsign-Präfix erkannt.
Gate-spezifische Airline-Regeln werden nur dann gesetzt, wenn die OSM-Gate-Daten
ein airline/operator/network/brand-Tag liefern. Ohne solche Daten gilt das Gate
als allgemein nutzbar.

## Render Environment Variables

Optional:
OCCUPANCY_RADIUS_M=55
OCCUPANCY_MAX_GROUNDSPEED_KTS=20
DIRECT_GATE_RADIUS_M=25
OSM_RADIUS_M=5000
