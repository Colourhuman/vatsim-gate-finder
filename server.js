const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.static(__dirname));
app.use(express.json());

// Arbeitsspeicher-Cache
const gateCache = new Map();

// ==========================================
// HAUPTSEITE (INDEX.HTML AUSLIEFERN)
// ==========================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// GATE-ABFRAGE API
// ==========================================
app.get('/api/gates', async (req, res) => {
    const icao = req.query.icao ? req.query.icao.toUpperCase().trim() : null;

    if (!icao || icao.length < 3) {
        return res.status(400).json({ error: 'Bitte gib einen gültigen ICAO-Code ein (z.B. EDDF, LDSP).' });
    }

    // 1. Aus dem Cache laden
    if (gateCache.has(icao)) {
        console.log(`[CACHE] Daten für ${icao} direkt geliefert.`);
        return res.json(gateCache.get(icao));
    }

    try {
        // 2. Genaues Zentrum des Flughafens via Nominatim bestimmen
        const geoUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(icao)}&format=json&limit=1`;
        const geoRes = await fetch(geoUrl, {
            headers: { 'User-Agent': 'VATSIM-Gate-Finder-App/1.0' }
        });
        const geoData = await geoRes.json();

        if (!geoData || geoData.length === 0) {
            return res.status(404).json({ error: `Flughafen ${icao} wurde nicht gefunden.` });
        }

        const lat = geoData[0].lat;
        const lon = geoData[0].lon;

        // 3. Overpass Radius-Suche um die GPS-Koordinaten (3,5 km Umkreis)
        const query = `
            [out:json][timeout:15];
            (
              node["aeroway"="parking_position"](around:3500,${lat},${lon});
              node["aeroway"="gate"](around:3500,${lat},${lon});
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
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 7000);

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
                    if (rawData && rawData.elements) break;
                }
            } catch (e) {
                // Nächsten Server probieren
            }
        }

        if (!rawData || !rawData.elements || rawData.elements.length === 0) {
            return res.status(404).json({
                error: `Keine Gate-Daten für ${icao} gefunden.`,
                icao: icao,
                total_gates: 0,
                gates: []
            });
        }

        // 4. Daten filtern und sortieren
        const gates = rawData.elements
            .map(item => ({
                name: item.tags?.ref || item.tags?.name || 'Unbenannt',
                type: item.tags?.aeroway === 'gate' ? 'Gate' : 'Standplatz',
                lat: item.lat,
                lon: item.lon
            }))
            .filter(g => g.name !== 'Unbenannt');

        gates.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

        const result = {
            icao: icao,
            total_gates: gates.length,
            gates: gates
        };

        if (gates.length > 0) {
            gateCache.set(icao, result);
        }

        return res.json(result);

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Fehler beim Laden der Flughafen-Daten.' });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server läuft auf Port ${PORT}`);
});
