const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Safely load gates.json if present
let gatesData = { airports: {}, aircraftCategories: {} };
try {
  if (fs.existsSync('./gates.json')) {
    gatesData = JSON.parse(fs.readFileSync('./gates.json', 'utf8'));
  }
} catch (err) {
  console.error('Hinweis: gates.json konnte nicht geladen werden:', err.message);
}

let vatsimCache = null;
let lastFetch = 0;

async function getVatsimData() {
  const now = Date.now();
  if (vatsimCache && (now - lastFetch < 15000)) {
    return vatsimCache;
  }
  try {
    const response = await fetch('https://data.vatsim.net/v3/vatsim-data.json');
    vatsimCache = await response.json();
    lastFetch = now;
    return vatsimCache;
  } catch (err) {
    console.error('Fehler beim Abrufen der VATSIM Daten:', err);
    return vatsimCache || { pilots: [] };
  }
}

function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

app.get('/api/config', (req, res) => {
  res.json({
    airports: Object.keys(gatesData.airports || {}),
    aircraftTypes: Object.keys(gatesData.aircraftCategories || {})
  });
});

app.get('/api/find-gate', async (req, res) => {
  const { airport, aircraftType, airline } = req.query;

  if (!airport || !gatesData.airports || !gatesData.airports[airport.toUpperCase()]) {
    return res.status(400).json({ error: 'Unbekannter Flughafen in gates.json' });
  }

  const reqAirport = airport.toUpperCase();
  const reqAirline = airline ? airline.toUpperCase() : null;
  const reqAircraft = aircraftType ? aircraftType.toUpperCase() : null;

  const reqCategory = (gatesData.aircraftCategories && gatesData.aircraftCategories[reqAircraft]) || 'C';

  const gates = gatesData.airports[reqAirport];
  const vatsimData = await getVatsimData();
  const pilots = vatsimData.pilots || [];
  const groundPilots = pilots.filter(p => p.groundspeed < 15);

  const evaluatedGates = gates.map(gate => {
    const occupiedBy = groundPilots.find(pilot => {
      const dist = calculateDistanceMeters(gate.lat, gate.lon, pilot.latitude, pilot.longitude);
      return dist < 40;
    });

    const isOccupied = !!occupiedBy;
    const catPriority = { "C": 1, "D": 2, "E": 3, "F": 4 };
    const fitsCategory = catPriority[gate.category] >= catPriority[reqCategory];
    const fitsAirline = !reqAirline || (gate.airlines && gate.airlines.includes(reqAirline));

    return {
      name: gate.name,
      category: gate.category,
      airlines: gate.airlines,
      isOccupied,
      occupiedByCallsign: occupiedBy ? occupiedBy.callsign : null,
      fitsCategory,
      fitsAirline,
      isPerfectMatch: !isOccupied && fitsCategory && fitsAirline
    };
  });

  res.json({
    airport: reqAirport,
    requestedAircraft: reqAircraft,
    requestedCategory: reqCategory,
    requestedAirline: reqAirline,
    gates: evaluatedGates
  });
});

// Live-Abfrage aller Gates & Standplätze über OpenStreetMap
app.get('/api/gates', async (req, res) => {
  const icao = req.query.icao ? req.query.icao.toUpperCase() : null;

  if (!icao) {
    return res.status(400).json({ error: 'Bitte gib einen ICAO-Code an, z.B. ?icao=EDDF' });
  }

  // Falls Flughafen bereits in gates.json lokal vorhanden ist, sofort antworten!
  if (gatesData.airports && gatesData.airports[icao]) {
    const localGates = gatesData.airports[icao].map(g => ({
      name: g.name,
      type: 'Gate',
      lat: g.lat,
      lon: g.lon
    }));
    return res.json({
      icao: icao,
      total_gates: localGates.length,
      gates: localGates,
      source: 'local'
    });
  }

  const overpassUrls = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
  ];

  // Optimierte Abfrage nach ICAO-Gebiet
  const query = `
    [out:json][timeout:15];
    (
      area["icao"="${icao}"];
      area["ICAO"="${icao}"];
    )->.a;
    (
      node["aeroway"="parking_position"](area.a);
      node["aeroway"="gate"](area.a);
    );
    out body;
  `;

  let data = null;
  let lastError = null;

  for (const url of overpassUrls) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 Sekunden Limit

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
        data = await response.json();
        if (data && data.elements) break;
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (!data || !data.elements) {
    console.error('Fehler beim Abrufen der Gates:', lastError);
    return res.status(500).json({ error: 'Fehler beim Laden der Gate-Daten. Bitte erneut versuchen.' });
  }

  const gates = data.elements
    .map(item => ({
      name: item.tags?.ref || item.tags?.name || 'Unbenannt',
      type: item.tags?.aeroway === 'gate' ? 'Gate' : 'Standplatz',
      lat: item.lat,
      lon: item.lon
    }))
    .filter(g => g.name !== 'Unbenannt');

  res.json({
    icao: icao,
    total_gates: gates.length,
    gates: gates,
    source: 'live'
  });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
