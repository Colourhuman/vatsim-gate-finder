const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// Statische Dateien (Frontend / HTML / JS) bereitstellen
app.use(express.static(__dirname));
app.use(express.json());

// Arbeitsspeicher-Cache für Gate-Daten
const gateCache = new Map();

// ==========================================
// GATE-ABFRAGE API
// ==========================================
app.get('/api/gates', async (req, res) => {
    const icao = req.query.icao ? req.query.icao.toUpperCase().trim() : null;

    if (!icao || icao.length < 3) {
        return res.status(400).json({ error: 'Bitte gib einen gültigen ICAO-Code an, z.B. ?icao=EDDF' });
    }

    // 1. Aus dem Cache laden (0,01 Sekunden!)
    if (gateCache.has(icao)) {
        console.log(`[CACHE] Daten für ${icao} geladen.`);
        return res.json(gateCache.get(icao));
    }

    // 2. Reserve-Server
    const overpassUrls = [
        'https://overpass-api.de/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter',
        'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
    ];

    const query = `
        [out:json][timeout:10];
        nwr["aeroway"="aerodrome"]["icao"="${icao}"]->.apt;
        (
          node["aeroway"="parking_position"](around.apt:4500);
          node["aeroway"="gate"](around.apt:4500);
        );
        out body;
    `;

    let rawData = null;

    // 3. Server nacheinander anfragen
    for (const url of overpassUrls) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 6000);

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'VATSIM-Gate-Finder-App/1.0'
                },
                body: 'data=' + encodeURIComponent(query),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (response.ok) {
                rawData = await response.json();
                if (rawData && rawData.elements && rawData.elements.length > 0) {
                    break;
                }
            }
        } catch (err) {
            console.log(`Server ${url} fehlgeschlagen, versuche nächsten...`);
        }
    }

    // 4. Absicherung falls keine Antwort kommt
    if (!rawData || !rawData.elements || rawData.elements.length === 0) {
        return res.status(503).json({
            error: 'Die Gate-Datenbank ist kurz überlastet. Bitte Seite in wenigen Sekunden neu laden.',
            icao: icao,
            total_gates: 0,
            gates: []
        });
    }

    // 5. Daten filtern
    const gates = rawData.elements
        .map(item => ({
            name: item.tags?.ref || item.tags?.name || 'Unbenannt',
            type: item.tags?.aeroway === 'gate' ? 'Gate' : 'Standplatz',
            lat: item.lat,
            lon: item.lon
        }))
        .filter(g => g.name !== 'Unbenannt');

    const result = {
        icao: icao,
        total_gates: gates.length,
        gates: gates
    };

    // 6. Speichern
    if (gates.length > 0) {
        gateCache.set(icao, result);
    }

    res.json(result);
});

// Server starten (Hört auf Render-Port)
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server läuft mit Frontend auf Port ${PORT}`);
});
