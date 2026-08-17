const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.static(__dirname));
app.use(express.json());

const AIRPORT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const VATSIM_CACHE_TTL_MS = 12 * 1000;
const OCCUPANCY_RADIUS_M = Number(process.env.OCCUPANCY_RADIUS_M || 90);
const OVERPASS_RADIUS_M = Number(process.env.OVERPASS_RADIUS_M || 5000);

const airportCache = new Map();
let vatsimCache = { timestamp: 0, pilots: [] };

const AIRCRAFT_CATEGORY = {
  A318:"C",A319:"C",A320:"C",A321:"C",A20N:"C",A21N:"C",
  B737:"C",B731:"C",B732:"C",B733:"C",B734:"C",B735:"C",B736:"C",B737:"C",B738:"C",B739:"C",B38M:"C",B39M:"C",
  E170:"C",E175:"C",E190:"C",E195:"C",E290:"C",E295:"C",
  CRJ7:"C",CRJ9:"C",CRJX:"C",DH8D:"C",AT72:"C",
  B752:"D",B753:"D",A310:"D",A300:"D",A30B:"D",
  A332:"E",A333:"E",A339:"E",A350:"E",A359:"E",A35K:"E",
  B762:"E",B763:"E",B764:"E",B772:"E",B77L:"E",B77W:"E",
  B788:"E",B789:"E",B78X:"E",B748:"E",B744:"E",A388:"F"
};

const AIRCRAFT_WINGSPAN_M = {
  A318:34.1,A319:35.8,A320:35.8,A321:35.8,A20N:35.8,A21N:35.8,
  B737:35.8,B738:35.8,B739:35.9,B38M:35.9,B39M:35.9,
  E170:26,E175:28.7,E190:28.7,E195:28.7,E290:33.7,E295:33.7,
  CRJ7:24.9,CRJ9:26.2,CRJX:26.2,B752:38.5,B753:38.5,
  A300:44.8,A310:44.8,A332:64,A333:64,A339:64,A359:64.8,A35K:64.8,
  B762:47.6,B763:51.8,B764:51.8,B772:60.9,B77L:64.8,B77W:64.8,
  B788:60.1,B789:60.1,B78X:60.1,B744:64.4,B748:68.4,A388:79.8
};

const AIRLINE_ALIASES = {
  EWG:["EWG","EW","EUROWINGS"], DLH:["DLH","LH","LUFTHANSA"],
  RYR:["RYR","FR","RYANAIR"], WZZ:["WZZ","W6","WIZZAIR"],
  EZY:["EZY","U2","EASYJET"], TUI:["TUI","TUIFLY"],
  CFG:["CFG","DE","CONDOR"], AUA:["AUA","OS","AUSTRIAN"],
  SWR:["SWR","LX","SWISS"], KLM:["KLM","KL"],
  AFR:["AFR","AF","AIRFRANCE"], BAW:["BAW","BA","BRITISH AIRWAYS"],
  TAP:["TAP","TP","TAP AIR PORTUGAL"], SAS:["SAS","SK"]
};

function normalizeAircraft(raw) {
  return String(raw || "").split("/")[0].trim().toUpperCase();
}

function aircraftCategory(type) {
  const t = normalizeAircraft(type);
  if (AIRCRAFT_CATEGORY[t]) return AIRCRAFT_CATEGORY[t];
  if (/^A3(18|19|20|21|20N|21N)$/.test(t) || /^B73/.test(t) || /^E19/.test(t) || /^CRJ/.test(t)) return "C";
  if (/^(B75|A30|A31)/.test(t)) return "D";
  if (/^(B76|B77|B78|A33|A35)/.test(t)) return "E";
  if (/^A38/.test(t)) return "F";
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
  for (const key of ["airline","operator","operators","network","brand"]) {
    if (tags[key]) return String(tags[key]).split(/[;,|]/).map(v => v.trim()).filter(Boolean);
  }
  return [];
}

function centerOfElement(el) {
  if (Number.isFinite(el.lat) && Number.isFinite(el.lon)) return {lat: el.lat, lon: el.lon};
  if (el.center && Number.isFinite(el.center.lat) && Number.isFinite(el.center.lon)) {
    return {lat: el.center.lat, lon: el.center.lon};
  }
  return null;
}

function parseGate(el, airport) {
  const tags = el.tags || {};
  if (!["gate","parking_position"].includes(tags.aeroway)) return null;
  const point = centerOfElement(el);
  if (!point) return null;

  const name = tags.ref || tags.name || tags["stand:ref"] || tags["parking:ref"];
  if (!name) return null;

  const rawCategory = String(
    tags["aircraft:size"] || tags.code || tags["aeroway:ref"] || tags["aircraft:reference_code"] || ""
  ).toUpperCase();
  const category = ["A","B","C","D","E","F"].includes(rawCategory) ? rawCategory : null;

  const rawWingspan = tags.maxspan || tags.max_wingspan || tags.wingspan || tags["aircraft:max_wingspan"] || tags["max:wingspan"];
  const wingspan = Number.parseFloat(String(rawWingspan).replace(",", "."));

  return {
    name: String(name),
    type: tags.aeroway === "gate" ? "Gate" : "Standplatz",
    category,
    maxWingspanM: Number.isFinite(wingspan) ? wingspan : null,
    airlines: getGateOperators(tags),
    lat: point.lat,
    lon: point.lon,
    osmType: el.type,
    osmId: el.id,
    airport: airport
  };
}

async function overpassRequest(query) {
  const encoded = encodeURIComponent(query);
  const endpoints = [
    `https://overpass-api.de/api/interpreter?data=${encoded}`,
    `https://overpass.kumi.systems/api/interpreter?data=${encoded}`,
    `https://overpass.private.coffee/api/interpreter?data=${encoded}`
  ];

  let lastError = null;

  for (const url of endpoints) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 35000);
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": "VATSIM-Gate-Finder/2.1 (+https://vatsim-gate-finder.onrender.com)",
          "Accept": "application/json",
          "Accept-Encoding": "gzip, deflate"
        },
        signal: controller.signal
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      console.warn(`[Overpass] ${url.split("?")[0]}: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error("No Overpass endpoint available");
}

async function fetchAirportGates(icao) {
  const cached = airportCache.get(icao);
  if (cached && Date.now() - cached.timestamp < AIRPORT_CACHE_TTL_MS) return cached.data;

  // Step 1: locate the airport itself. We do NOT use an OSM area object,
  // because not every airport's area relation behaves consistently.
  const airportQuery = `
    [out:json][timeout:30];
    nwr["aeroway"="aerodrome"]["icao"="${icao}"];
    out center tags;
  `;

  const airportData = await overpassRequest(airportQuery);
  const airport = airportData.elements?.find(e => centerOfElement(e));

  if (!airport) {
    const result = {icao,total_gates:0,gates:[],error:`Airport ${icao} not found in OpenStreetMap`};
    airportCache.set(icao,{timestamp:Date.now(),data:result});
    return result;
  }

  const center = centerOfElement(airport);

  // Step 2: search both nodes and ways. OSM explicitly allows
  // parking_position as a node or a way.
  const gateQuery = `
    [out:json][timeout:60];
    (
      nwr["aeroway"="parking_position"](around:${OVERPASS_RADIUS_M},${center.lat},${center.lon});
      nwr["aeroway"="gate"](around:${OVERPASS_RADIUS_M},${center.lat},${center.lon});
    );
    out center tags;
  `;

  const gateData = await overpassRequest(gateQuery);
  const gates = (gateData.elements || [])
    .map(e => parseGate(e, icao))
    .filter(Boolean)
    .filter(g => haversineMeters(center.lat,center.lon,g.lat,g.lon) <= OVERPASS_RADIUS_M + 100)
    .sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:"base"}));

  // De-duplicate identical named positions within a few meters.
  const deduped = [];
  for (const gate of gates) {
    const duplicate = deduped.find(g =>
      g.name === gate.name &&
      haversineMeters(g.lat,g.lon,gate.lat,gate.lon) < 10
    );
    if (!duplicate) deduped.push(gate);
  }

  const result = {icao,total_gates:deduped.length,gates:deduped};
  airportCache.set(icao,{timestamp:Date.now(),data:result});
  return result;
}

async function fetchVatsimPilots() {
  if (Date.now() - vatsimCache.timestamp < VATSIM_CACHE_TTL_MS) return vatsimCache.pilots;

  const response = await fetch("https://data.vatsim.net/v3/vatsim-data.json", {
    headers: {"User-Agent":"VATSIM-Gate-Finder/2.1"}
  });
  if (!response.ok) throw new Error(`VATSIM HTTP ${response.status}`);

  const data = await response.json();
  vatsimCache = {
    timestamp: Date.now(),
    pilots: Array.isArray(data.pilots) ? data.pilots : []
  };
  return vatsimCache.pilots;
}

function haversineMeters(lat1,lon1,lat2,lon2) {
  const R=6371000, rad=x=>x*Math.PI/180;
  const dLat=rad(lat2-lat1), dLon=rad(lon2-lon1);
  const a=Math.sin(dLat/2)**2+Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

function getArrivalAirport(p) {
  return p?.flight_plan?.arrival?.toUpperCase?.() || "";
}
function getDepartureAirport(p) {
  return p?.flight_plan?.departure?.toUpperCase?.() || "";
}

function getOccupantForGate(gate,pilots) {
  let closest=null;

  for (const pilot of pilots) {
    if (!Number.isFinite(Number(pilot.latitude)) || !Number.isFinite(Number(pilot.longitude))) continue;

    const nearAirport =
      getArrivalAirport(pilot) === gate.airport ||
      getDepartureAirport(pilot) === gate.airport;

    if (!nearAirport) continue;

    const distance=haversineMeters(gate.lat,gate.lon,Number(pilot.latitude),Number(pilot.longitude));
    if (distance>OCCUPANCY_RADIUS_M) continue;

    const groundspeed=Number(pilot.groundspeed||0);
    const score=distance+Math.min(groundspeed,80)*0.4;

    if (!closest || score<closest.score) {
      closest={
        score,
        callsign:pilot.callsign,
        aircraft:normalizeAircraft(pilot.flight_plan?.aircraft_short || pilot.flight_plan?.aircraft),
        cid:pilot.cid,
        distanceM:Math.round(distance),
        groundspeed
      };
    }
  }
  return closest;
}

function airlineMatchesGate(gate,requestedAirline) {
  if (!requestedAirline || !gate.airlines?.length) return true;
  const aliases=normalizeAirline(requestedAirline);
  return gate.airlines.some(op=>{
    const s=String(op).toUpperCase();
    return aliases.some(alias=>s===alias || s.includes(alias));
  });
}

function aircraftMatchesGate(gate,aircraft) {
  const type=normalizeAircraft(aircraft);
  if (!type) return true;

  const cat=aircraftCategory(type);
  if (gate.category && cat) {
    return "ABCDEF".indexOf(cat)<="ABCDEF".indexOf(gate.category);
  }

  const wingspan=AIRCRAFT_WINGSPAN_M[type];
  if (gate.maxWingspanM && wingspan) return wingspan <= gate.maxWingspanM + 0.5;

  return true;
}

app.get("/api/health", async (_req,res)=>{
  res.json({
    ok:true,
    timestamp:new Date().toISOString(),
    vatsimFeedAgeSeconds:vatsimCache.timestamp ? Math.round((Date.now()-vatsimCache.timestamp)/1000) : null,
    occupancyRadiusM:OCCUPANCY_RADIUS_M,
    overpassRadiusM:OVERPASS_RADIUS_M
  });
});

app.get("/api/gates", async (req,res)=>{
  try {
    const icao=String(req.query.icao||"").trim().toUpperCase();
    const airline=String(req.query.airline||"").trim().toUpperCase();
    const aircraft=normalizeAircraft(req.query.aircraft||req.query.type||"");

    if (!/^[A-Z0-9]{4}$/.test(icao)) {
      return res.status(400).json({error:"Bitte einen gültigen 4-stelligen ICAO-Code angeben."});
    }

    // Independent requests: a VATSIM outage should not prevent the airport
    // gate list from loading.
    const airportPromise=fetchAirportGates(icao);
    const vatsimPromise=fetchVatsimPilots().catch(error=>{
      console.warn(`[VATSIM] ${error.message}`);
      return [];
    });

    const [airportData,pilots]=await Promise.all([airportPromise,vatsimPromise]);

    if (!airportData.gates.length) {
      return res.status(404).json({
        error:`Keine Gate-/Stand-Daten für ${icao} gefunden.`,
        hint:"Airport wurde möglicherweise gefunden, aber OSM enthält dort keine benannten gate/parking_position-Elemente im Suchradius.",
        icao,total_gates:0,gates:[]
      });
    }

    const gates=airportData.gates.map(gate=>{
      const occupant=getOccupantForGate(gate,pilots);
      const airlineOk=airlineMatchesGate(gate,airline);
      const aircraftOk=aircraftMatchesGate(gate,aircraft);
      const occupied=Boolean(occupant);

      return {
        ...gate,
        compatible:airlineOk&&aircraftOk,
        occupied,
        available:airlineOk&&aircraftOk&&!occupied,
        occupant:occupant||null
      };
    });

    gates.sort((a,b)=>{
      const rank=g=>g.available?0:(!g.occupied?1:2);
      return rank(a)-rank(b)||a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:"base"});
    });

    res.setHeader("Cache-Control","no-store");
    res.json({
      icao,
      requestedAirline:airline||null,
      requestedAircraft:aircraft||null,
      occupancyRadiusM:OCCUPANCY_RADIUS_M,
      overpassRadiusM:OVERPASS_RADIUS_M,
      source:"OpenStreetMap + VATSIM live feed",
      vatsimFeedTimestamp:vatsimCache.timestamp?new Date(vatsimCache.timestamp).toISOString():null,
      total_gates:gates.length,
      available_count:gates.filter(g=>g.available).length,
      occupied_count:gates.filter(g=>g.occupied).length,
      incompatible_count:gates.filter(g=>!g.compatible).length,
      gates
    });
  } catch(error) {
    console.error(error);
    res.status(502).json({
      error:"Gate-Daten konnten gerade nicht abgerufen werden.",
      details:error.message
    });
  }
});

app.listen(PORT,"0.0.0.0",()=>{
  console.log(`VATSIM Gate Finder 2.1 läuft auf Port ${PORT}`);
});
