const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.static(__dirname));
app.use(express.json());

// Arbeitsspeicher-Cache
const gateCache = new Map();

// Hauptseite ausliefern
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send('index.html nicht gefunden.');
    }
});

// API Route für Gates mit Airline & Aircraft-Support
app.get('/api/gates', async (req, res) => {
    const icao = req.query.icao ? req.query.icao.toUpperCase().trim() : null;
    const airline = req.query.airline ? req.query.airline.toUpperCase().trim() : '';
    const aircraftCategory = req.query.category ? req.query.category.toUpperCase().trim() : '';

    if (!icao || icao.length < 3) {
        return res.status(400).json({ error: 'Bitte gib einen gültigen ICAO-Code ein (z.B. EDDF, LDSP).' });
    }

    let airportData = null;

    // 1. Wenn Flughafen im Cache -> Direkt nutzen
    if (gateCache.has(icao)) {
        airportData = gateCache.get(icao);
    } else {
        // 2. Direkt über Overpass suchen (kein flakiges Nominatim mehr!)
        const queryArea = `
            [out:json][timeout:15];
            area["aeroway"="aerodrome"]["icao"="${icao}"]->.a;
            (
              node["aeroway"="parking_position"](area.a);
              node["aeroway"="gate"](area.a);
            );
            out body;
        `;

        const queryRadius = `
            [out:json][timeout:15];
            nwr["aeroway"="aerodrome"]["icao"="${icao}"]->.apt;
            (
              node["aeroway"="parking_position"](around.apt:6000);
              node["aeroway"="gate"](around.apt:6000);
            );
            out body;
        `;

        const overpassUrls = [
            'https://overpass-api.de/api/interpreter',
            'https://overpass.kumi.systems/api/interpreter',
            'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
        ];

        let rawData = null;

        for (const url of overpassUrls) {
            try {
                // Versuch 1: Über Area
                rawData = await fetchOverpass(url, queryArea);
                if (rawData && rawData.elements && rawData.elements.length > 0) break;

                // Versuch 2: Über Radius
                rawData = await fetchOverpass(url, queryRadius);
                if (rawData && rawData.elements && rawData.elements.length > 0) break;
            } catch (e) {
                console.log(`Server ${url} fehlgeschlagen...`);
            }
        }

        if (!rawData || !rawData.elements || rawData.elements.length === 0) {
            return res.status(404).json({
                error: `Keine Gate-Daten für ${icao} gefunden. Bitte prüfe den ICAO-Code oder versuche es gleich erneut.`,
                icao: icao,
                total_gates: 0,
                gates: []
            });
        }

        // Gates aufbereiten
        const gates = rawData.elements
            .map(item => ({
                name: item.tags?.ref || item.tags?.name || 'Unbenannt',
                type: item.tags?.aeroway === 'gate' ? 'Gate' : 'Standplatz',
                maxspan: item.tags?.maxspan || item.tags?.['wingspan'] || 'k.A.',
                maxcat: item.tags?.['aircraft:size'] || item.tags?.['code'] || 'Alle',
                airline: item.tags?.airline || item.tags?.operator || 'Alle Airlines',
                lat: item.lat,
                lon: item.lon
            }))
            .filter(g => g.name !== 'Unbenannt');

        gates.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

        airportData = {
            icao: icao,
            total_gates: gates.length,
            gates: gates
        };

        if (gates.length > 0) {
            gateCache.set(icao, airportData);
        }
    }

    // 3. Nach Airline und Aircraft-Kategorie filtern
    let filteredGates = airportData.gates;

    if (airline) {
        filteredGates = filteredGates.filter(g => 
            g.airline === 'Alle Airlines' || g.airline.toUpperCase().includes(airline)
        );
    }

    if (aircraftCategory && aircraftCategory !== 'ALL') {
        filteredGates = filteredGates.filter(g => 
            g.maxcat === 'Alle' || g.maxcat.toUpperCase().includes(aircraftCategory)
        );
    }

    return res.json({
        icao: airportData.icao,
        total_gates: airportData.total_gates,
        filtered_count: filteredGates.length,
        gates: filteredGates
    });
});

async function fetchOverpass(url, query) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'VATSIM-Gate-Finder/1.0'
        },
        body: 'data=' + encodeURIComponent(query),
        signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (response.ok) {
        return await response.json();
    }
    return null;
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server läuft auf Port ${PORT}`);
});
