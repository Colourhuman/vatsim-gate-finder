// ==========================================
// FINALE & STABILE GATE-ABFRAGE MIT CACHE
// ==========================================

// Speicher im Server (Damit geladene Flughäfen ab dem 2. Mal SOFORT laden)
const gateCache = new Map();

app.get('/api/gates', async (req, res) => {
    const icao = req.query.icao ? req.query.icao.toUpperCase().trim() : null;

    if (!icao || icao.length < 3) {
        return res.status(400).json({ error: 'Bitte gib einen gültigen ICAO-Code an, z.B. ?icao=EDDF' });
    }

    // 1. Wenn der Flughafen schon im Speicher liegt -> Sofort antworten (0,01 Sekunden!)
    if (gateCache.has(icao)) {
        console.log(`[CACHE HIT] Daten für ${icao} direkt aus dem Speicher geliefert.`);
        return res.json(gateCache.get(icao));
    }

    // 2. Drei globale Daten-Server als Reserve
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

    // 3. Server nacheinander probieren
    for (const url of overpassUrls) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 6000); // Max 6 Sekunden Warten

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
                    break; // Erfolgreich! Schleife abbrechen.
                }
            }
        } catch (err) {
            console.log(`Server ${url} fehlgeschlagen, versuche nächsten...`);
        }
    }

    // 4. Falls kein Server geantwortet hat oder geblockt wurde
    if (!rawData || !rawData.elements || rawData.elements.length === 0) {
        return res.status(503).json({
            error: 'Die Gate-Datenbank reagiert gerade nicht. Bitte lade die Seite in wenigen Sekunden neu.',
            icao: icao,
            total_gates: 0,
            gates: []
        });
    }

    // 5. Daten aufräumen & Unbenannte entfernen
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

    // 6. Im Speicher ablegen für zukünftige Aufrufe
    if (gates.length > 0) {
        gateCache.set(icao, result);
    }

    res.json(result);
});
