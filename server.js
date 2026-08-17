const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.static(__dirname));
app.use(express.json());

const AIRPORT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const VATSIM_CACHE_TTL_MS = 12 * 1000;

// Tune this on Render if you want to be stricter/looser.
const OCCUPANCY_RADIUS_M = Number(process.env.OCCUPANCY_RADIUS_M || 90);

const airportCache = new Map();
let vatsimCache = { timestamp: 0, pilots: [] };

// ICAO aircraft designators -> ICAO aerodrome reference code.
// This intentionally covers the common VATSIM fleet; unknown types fall back
// to wingspan data where available.
const AIRCRAFT_CATEGORY = {
  A318: "C", A319: "C", A320: "C", A321: "C", A20N: "C", A21N: "C",
  B737: "C", B731: "C", B732: "C", B733: "C", B734: "C", B735: "C",
  B736: "C", B737: "C", B738: "C", B739: "C", B38M: "C", B39M: "C",
  E170: "C", E175: "C", E190: "C", E195: "C", E290: "C", E295: "C",
  CRJ7: "C", CRJ9: "C", CRJX: "C", DH8D: "C", AT72: "C",
  B752: "D", B753: "D", A310: "D", A300: "D", A30B: "D",
  A332: "E", A333: "E", A339: "E", A350: "E", A359: "E", A35K: "E",
  B762: "E", B763: "E", B764: "E", B772: "E", B77L: "E", B77W: "E",
  B788: "E", B789: "E", B78X: "E", B748: "E", B744: "E",
  A388: "F"
};

const AIRCRAFT_WINGSPAN_M = {
  A318: 34.1, A319: 35.8, A320: 35.8, A321: 35.8, A20N: 35.8, A21N: 35.8,
  B737: 35.8, B738: 35.8, B739: 35.9, B38M: 35.9, B39M: 35.9,
  E170: 26.0, E175: 28.7, E190: 28.7, E195: 28.7, E290: 33.7, E295: 33.7,
  CRJ7: 24.9, CRJ9: 26.2, CRJX: 26.2,
  B752: 38.5, B753: 38.5, A300: 44.8, A310: 44.8,
  A332: 64.0, A333: 64.0, A339: 64.0, A359: 64.8, A35K: 64.8, A350: 64.8,
  B762: 47.6, B763: 51.8, B764: 51.8, B772: 60.9, B77L: 64.8, B77W: 64.8,
  B788: 60.1, B789: 60.1, B78X: 60.1, B744: 64.4, B748: 68.4,
  A388: 79.8
};

// Lightweight ICAO airline normalization. Gate data from OSM often uses
// ICAO codes, names, or IATA codes, so matching is intentionally fuzzy.
const AIRLINE_ALIASES = {
  EWG: ["EWG", "EW", "EUROWINGS"],
  DLH: ["DLH", "LH", "LUFTHANSA"],
  RYR: ["RYR", "FR", "RYANAIR"],
  WZZ: ["WZZ", "W6", "WIZZAIR"],
  EZY: ["EZY", "U2", "EASYJET"],
  TUI: ["TUI", "TOM", "TUIFLY", "TUIFLY NORDIC"],
  CFG: ["CFG", "DE", "CONDOR"],
  OAW: ["OAW", "8Q", "CHALAIR"],
  AUA: ["AUA", "OS", "AUSTRIAN"],
  SWR: ["SWR", "LX", "SWISS"],
  KLM: ["KLM", "KL"],
  AFR: ["AFR", "AF", "AIRFRANCE"],
  BAW: ["BAW", "BA", "BRITISH AIRWAYS"],
  TAP: ["TAP", "TP", "TAP AIR PORTUGAL"],
  SAS: ["SAS", "SK", "SCANDINAVIAN AIRLINES"]
};

const ALLOWED_OPERATOR_KEYS = ["airline", "operator", "operators", "network", "brand"];

function normalizeAircraft(raw) {
  if (!raw) return "";
  return String(raw).split("/")[0].trim().toUpperCase();
}

function aircraftCategory(type) {
  const t = normalizeAircraft(type);
  if (AIRCRAFT_CATEGORY[t]) return AIRCRAFT_CATEGORY[t];
  // Family fallback for common VATSIM variants.
  const family = t.replace(/[0-9]+$/, "");
  if (["A31", "A32", "A33", "A3?"].includes(family)) return "C";
  if (t.startsWith("B73")) return "C";
  if (t.startsWith("E19")) return "C";
  if (t.startsWith("CRJ")) return "C";
  if (t.startsWith("B75") || t.startsWith("A30") || t.startsWith("A31")) return "D";
  if (t.startsWith("B76") || t.startsWith("B77") || t.startsWith("B78") || t.startsWith("A33") || t.startsWith("A35")) return "E";
  if (t.startsWith("A38")) return "F";
  return "";
}

function normalizeAirline(value) {
  const s = String(value || "").trim().toUpperCase();
  if (!s) return [];
  for (const [icao, aliases] of Object.entries(AIRLINE_ALIASES)) {
    if (aliases.some(a => s === a || s.includes(a))) return [icao, ...aliases];
  }
  return [s];
}

function getGateOperators(tags = {}) {
  for (const key of ALLOWED_OPERATOR_KEYS) {
    if (tags[key]) {
      return String(tags[key])
        .split(/[;,|]/)
        .map(v => v.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function parseGate(tags, lat, lon) {
  const name = tags.ref || tags.name || tags["stand:ref"] || tags["parking:ref"];
  if (!name) return null;

  const rawCategory = String(tags["aircraft:size"] || tags.code || tags["aeroway:ref"] || "").toUpperCase();
  const category = ["A","B","C","D","E","F"].includes(rawCategory) ? rawCategory : null;

  const rawWingspan =
    tags.maxspan || tags.max_wingspan || tags.wingspan ||
    tags["aircraft:max_wingspan"] || tags["max:wingspan"];

  const wingspan = Number.parseFloat(String(rawWingspan).replace(",", "."));

  return {
    name: String(name),
    type: tags.aeroway === "gate" ? "Gate" : "Standplatz",
    category,
    maxWingspanM: Number.isFinite(wingspan) ? wingspan : null,
    airlines: getGateOperators(tags),
    lat,
    lon
  };
}

async function fetchOverpass(endpoint, query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "VATSIM-Gate-Finder/2.0"
      },
      body: "data=" + encodeURIComponent(query),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Overpass HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAirportGates(icao) {
  const cached = airportCache.get(icao);
  if (cached && Date.now() - cached.timestamp < AIRPORT_CACHE_TTL_MS) {
    return cached.data;
  }

  const query = `
    [out:json][timeout:25];
    area["aeroway"="aerodrome"]["icao"="${icao}"]->.a;
    (
      node["aeroway"="parking_position"](area.a);
      node["aeroway"="gate"](area.a);
    );
    out body;
  `;

  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter"
  ];

  let data = null;
  for (const endpoint of endpoints) {
    try {
      data = await fetchOverpass(endpoint, query);
      if (data?.elements?.length) break;
    } catch (error) {
      console.warn(`[Overpass] ${endpoint}: ${error.message}`);
    }
  }

  if (!data?.elements?.length) {
    const empty = { icao, total_gates: 0, gates: [] };
    airportCache.set(icao, { timestamp: Date.now(), data: empty });
    return empty;
  }

  const gates = data.elements
    .map(item => parseGate(item.tags || {}, item.lat, item.lon))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

  const result = { icao, total_gates: gates.length, gates };
  airportCache.set(icao, { timestamp: Date.now(), data: result });
  return result;
}

async function fetchVatsimPilots() {
  if (Date.now() - vatsimCache.timestamp < VATSIM_CACHE_TTL_MS) {
    return vatsimCache.pilots;
  }

  const response = await fetch("https://data.vatsim.net/v3/vatsim-data.json", {
    headers: { "User-Agent": "VATSIM-Gate-Finder/2.0" }
  });
  if (!response.ok) throw new Error(`VATSIM HTTP ${response.status}`);

  const data = await response.json();
  vatsimCache = {
    timestamp: Date.now(),
    pilots: Array.isArray(data.pilots) ? data.pilots : [],
  };
  return vatsimCache.pilots;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function getArrivalAirport(pilot) {
  return pilot?.flight_plan?.arrival?.toUpperCase?.() || "";
}

function airlineMatchesGate(gate, requestedAirline) {
  if (!requestedAirline) return true;
  if (!gate.airlines?.length) return true;

  const aliases = normalizeAirline(requestedAirline);
  return gate.airlines.some(op => {
    const normalized = String(op).toUpperCase();
    return aliases.some(alias => normalized === alias || normalized.includes(alias));
  });
}

function aircraftMatchesGate(gate, aircraft) {
  const type = normalizeAircraft(aircraft);
  if (!type) return true;

  const cat = aircraftCategory(type);

  if (gate.category && cat) {
    return "ABCDEF".indexOf(cat) <= "ABCDEF".indexOf(gate.category);
  }

  const wingspan = AIRCRAFT_WINGSPAN_M[type];
  if (gate.maxWingspanM && wingspan) {
    return wingspan <= gate.maxWingspanM + 0.5;
  }

  return true;
}

function getOccupantForGate(gate, pilots) {
  let closest = null;

  for (const pilot of pilots) {
    const arrival = getArrivalAirport(pilot);
    if (!arrival) continue;

    // Prefer aircraft actually going to this airport.
    if (arrival !== gate._airport && getDepartureAirport(pilot) !== gate._airport) {
      continue;
    }

    if (!Number.isFinite(pilot.latitude) || !Number.isFinite(pilot.longitude)) continue;

    const distance = haversineMeters(gate.lat, gate.lon, pilot.latitude, pilot.longitude);
    if (distance > OCCUPANCY_RADIUS_M) continue;

    // Ground/taxi traffic gets a stronger "occupying" interpretation than
    // an aircraft flying over the stand.
    const groundspeed = Number(pilot.groundspeed || 0);
    const score = distance + Math.min(groundspeed, 80) * 0.4;

    if (!closest || score < closest.score) {
      closest = {
        score,
        callsign: pilot.callsign,
        aircraft: normalizeAircraft(pilot.flight_plan?.aircraft_short || pilot.flight_plan?.aircraft),
        cid: pilot.cid,
        distanceM: Math.round(distance),
        groundspeed
      };
    }
  }

  return closest;
}

function getDepartureAirport(pilot) {
  return pilot?.flight_plan?.departure?.toUpperCase?.() || "";
}

app.get("/api/health", async (_req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    vatsimFeedAgeSeconds: vatsimCache.timestamp ? Math.round((Date.now() - vatsimCache.timestamp) / 1000) : null,
    occupancyRadiusM: OCCUPANCY_RADIUS_M
  });
});

app.get("/api/gates", async (req, res) => {
  try {
    const icao = String(req.query.icao || "").toUpperCase().trim();
    const airline = String(req.query.airline || "").toUpperCase().trim();
    const aircraft = normalizeAircraft(req.query.aircraft || req.query.type || "");

    if (!/^[A-Z0-9]{3,4}$/.test(icao)) {
      return res.status(400).json({ error: "Bitte einen gültigen ICAO-Code angeben." });
    }

    const [airportData, pilots] = await Promise.all([
      fetchAirportGates(icao),
      fetchVatsimPilots()
    ]);

    if (!airportData.gates.length) {
      return res.status(404).json({
        error: `Keine Gate-/Stand-Daten für ${icao} gefunden.`,
        icao,
        total_gates: 0,
        gates: []
      });
    }

    const gates = airportData.gates.map(gate => {
      const gateWithAirport = { ...gate, _airport: icao };
      const occupant = getOccupantForGate(gateWithAirport, pilots);

      const airlineOk = airlineMatchesGate(gate, airline);
      const aircraftOk = aircraftMatchesGate(gate, aircraft);
      const occupied = Boolean(occupant);

      return {
        ...gate,
        compatible: airlineOk && aircraftOk,
        occupied,
        available: airlineOk && aircraftOk && !occupied,
        occupant: occupant || null
      };
    });

    // Best matches first: available compatible, then incompatible/free, then occupied.
    gates.sort((a, b) => {
      const rank = g => g.available ? 0 : (!g.occupied ? 1 : 2);
      return rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });

    res.setHeader("Cache-Control", "no-store");
    res.json({
      icao,
      requestedAirline: airline || null,
      requestedAircraft: aircraft || null,
      occupancyRadiusM: OCCUPANCY_RADIUS_M,
      source: "OpenStreetMap + VATSIM live feed",
      vatsimFeedTimestamp: vatsimCache.timestamp ? new Date(vatsimCache.timestamp).toISOString() : null,
      total_gates: gates.length,
      available_count: gates.filter(g => g.available).length,
      occupied_count: gates.filter(g => g.occupied).length,
      incompatible_count: gates.filter(g => !g.compatible).length,
      gates
    });
  } catch (error) {
    console.error(error);
    res.status(502).json({
      error: "Gate- oder VATSIM-Daten konnten gerade nicht abgerufen werden.",
      details: error.message
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`VATSIM Gate Finder läuft auf Port ${PORT}`);
});
