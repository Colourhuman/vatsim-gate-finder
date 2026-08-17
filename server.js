const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let gatesData = JSON.parse(fs.readFileSync('./gates.json', 'utf8'));

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
    airports: Object.keys(gatesData.airports),
    aircraftTypes: Object.keys(gatesData.aircraftCategories)
  });
});

app.get('/api/find-gate', async (req, res) => {
  const { airport, aircraftType, airline } = req.query;

  if (!airport || !gatesData.airports[airport.toUpperCase()]) {
    return res.status(400).json({ error: 'Unbekannter Flughafen' });
  }

  const reqAirport = airport.toUpperCase();
  const reqAirline = airline ? airline.toUpperCase() : null;
  const reqAircraft = aircraftType ? aircraftType.toUpperCase() : null;

  const reqCategory = gatesData.aircraftCategories[reqAircraft] || 'C';

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
    const fitsAirline = !reqAirline || gate.airlines.includes(reqAirline);

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

const PORT = process.env.PORT || 3000;
// Route: Holt automatisch alle Gates & Standplätze für einen ICAO-Code
app.get('/api/gates', async (req, res) => {
    const icao = req.query.icao ? req.query.icao.toUpperCase() : null;

    if (!icao) {
        return res.status(400).json({ error: 'Bitte gib einen ICAO-Code an, z.B. ?icao=EDDF' });
    }

    // Overpass API-Abfrage für OpenStreetMap
    const overpassUrl = 'https://overpass-api.de/api/interpreter';
    const query = `
        [out:json];
        area["icao"="${icao}"]->.searchArea;
        (
          node["aeroway"="parking_position"](area.searchArea);
          node["aeroway"="gate"](area.searchArea);
        );
        out body;
    `;

    try {
        const response = await fetch(overpassUrl, {
            method: 'POST',
            body: 'data=' + encodeURIComponent(query)
        });

        const data = await response.json();

        // Daten sauber aufbereiten
        const gates = data.elements.map(item => ({
            name: item.tags?.ref || item.tags?.name || 'Unbenannt',
            type: item.tags?.aeroway === 'gate' ? 'Gate' : 'Standplatz',
            lat: item.lat,
            lon: item.lon
        }));

        res.json({
            icao: icao,
            total_gates: gates.length,
            gates: gates
        });

    } catch (error) {
        console.error('Fehler beim Abrufen der Gates:', error);
        res.status(500).json({ error: 'Fehler beim Laden der Gate-Daten.' });
    }
});
app.listen(PORT, () => {
  console.log(`Server läuft mit Frontend auf http://localhost:${PORT}`);
});
