# VATSIM Gate Finder v10

## Was in v10 behoben wurde

### 1. Kein Fuzzy-Gate-Matching mehr
Die alte Version konnte z. B. durch Suffix-Matching `D11` mit `11` oder einem
anderen ähnlichen Stand verwechseln. v10 akzeptiert physische OSM-Anker nur noch
bei einem **exakten Stand-Token**. Dadurch werden falsche Gate-Koordinaten nicht
mehr aus Namensähnlichkeit erzeugt.

Wenn ein IFATC-Gate keinen eindeutigen physischen OSM-Anker besitzt, bleibt es
unverankert statt auf ein anderes Gate gesetzt zu werden.

### 2. Ein physischer Stand = maximal ein Gate
Wenn mehrere IFATC-Einträge auf denselben OSM-Parkpunkt zeigen, wird der
Parkpunkt nicht mehr doppelt dargestellt.

### 3. VATSIM-Belegung
Die Belegung wird global als 1:1-Zuordnung berechnet:
- ein VATSIM-Flugzeug kann nur ein Gate belegen
- ein Gate kann nur von einem Flugzeug belegt werden
- stehende Flugzeuge haben Priorität
- schnell rollende Flugzeuge werden nur mit kleinerem Radius berücksichtigt

Aktuelle Standardradien:
- 0–2 kt: 35 m
- 2–8 kt: 22 m
- >8 kt: 13 m

### 4. Airline-Regeln werden wirklich verwendet
Die alte Version hat die eingegebene Airline praktisch nicht zur Gate-Auswahl
verwendet. v10 normalisiert ICAO, IATA und Namen und wendet danach
flughafenspezifische Regeln an.

Beispiele:
- `CFG`, `DE`, `Condor` → CFG
- `EWG`, `EW`, `Eurowings` → EWG
- `DLH`, `LH`, `Lufthansa` → DLH

### 5. Aircraft-Kompatibilität
ICAO- und IATA-Aircraft-Codes werden normalisiert. Gate-Code und, falls OSM
vorhanden, maximale Spannweite werden berücksichtigt.

### 6. Airport-Regeln
`airport-rules.json` enthält getrennte Regeln für:
- Terminal
- Airline
- Gate-/Standbereiche
- Sonderstände
- Aircraft-Größe

Aktuell besonders berücksichtigt:
- EDDK Köln/Bonn
- EDDF Frankfurt/Main

Die Regeln sind bewusst in einer separaten JSON-Datei, damit weitere Airports
ohne Änderung der Matching-Engine ergänzt werden können.

## EDDF

Die Frankfurt-Regeln orientieren sich an der aktuellen VATSIM-Germany
Knowledgebase:
- A-Stands: überwiegend Lufthansa/Star Alliance
- A50–A69: Lufthansa
- B/C: Star Alliance / entsprechende Langstreckenbereiche
- D/E: Terminal 2
- J: Terminal 3, aktuelle Non-Schengen-Airlines
- F/V: Remote-/Sonderbereiche
- Condor: Terminal 1 / B-Bereich bis zum geplanten Umzug in T3 im Sommer 2027

## EDDK

Die Regeln berücksichtigen:
- Terminal 1: A/B/C
- Terminal 2: D
- Cargo: E/F/W
- Maintenance: U
- GA/Cargo: V
- Sonderzuordnungen für BAW, THY, MSR und DLH
- Eurowings/Ryanair können A–D nutzen, weil die reale Gate-Nutzung nicht
  ausschließlich aus dem Check-in-Terminal abgeleitet werden darf.

## Datenquellen

- VATSIM live data
- IFATC gate data
- OpenStreetMap aeroway parking positions
- Airport-spezifische Regeln in `airport-rules.json`

## Start

```bash
npm install
npm start
```

Render:
- Build command: `npm install`
- Start command: `npm start`

Node.js >= 18.
