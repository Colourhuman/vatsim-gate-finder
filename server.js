const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.static(__dirname));
app.use(express.json());

const VATSIM_CACHE_TTL = 12_000;
const GATE_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const AIRPORT_DB_TTL = 24 * 60 * 60 * 1000;

// Gate occupancy tuning.
const OCCUPANCY_RADIUS_M = Number(process.env.OCCUPANCY_RADIUS_M || 55);
const OCCUPANCY_MAX_GROUNDSPEED_KTS = Number(process.env.OCCUPANCY_MAX_GROUNDSPEED_KTS || 20);
const DIRECT_GATE_RADIUS_M = Number(process.env.DIRECT_GATE_RADIUS_M || 25);

// The previous version timed out on the HPI proxy. The current public Overpass
// directory lists both endpoints below as global instances. Private.coffee
// specifically recommends POST for application queries.
const OVERPASS_ENDPOINTS = [
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass-api.de/api/interpreter"
];

const OUR_AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv";

const gateCache = new Map();
let vatsimCache = { timestamp: 0, pilots: [] };
let airportDB = { timestamp: 0, map: new Map() };
let airportDBPromise = null;

const AIRCRAFT_INFO = {
  A318:{cat:"C",span:34.1}, A319:{cat:"C",span:35.8}, A320:{cat:"C",span:35.8}, A321:{cat:"C",span:35.8},
  A20N:{cat:"C",span:35.8}, A21N:{cat:"C",span:35.8},
  B737:{cat:"C",span:35.8}, B731:{cat:"C",span:28.9}, B732:{cat:"C",span:28.9},
  B733:{cat:"C",span:28.9}, B734:{cat:"C",span:28.9}, B735:{cat:"C",span:29.0},
  B736:{cat:"C",span:34.3}, B738:{cat:"C",span:35.8}, B739:{cat:"C",span:35.8},
  B38M:{cat:"C",span:35.9}, B39M:{cat:"C",span:35.9},
  E170:{cat:"C",span:26.0}, E175:{cat:"C",span:28.7}, E190:{cat:"C",span:28.7}, E195:{cat:"C",span:28.7},
  E290:{cat:"C",span:33.7}, E295:{cat:"C",span:33.7},
  CRJ7:{cat:"C",span:24.9}, CRJ9:{cat:"C",span:26.2}, CRJX:{cat:"C",span:26.2},
  DH8D:{cat:"C",span:28.4}, AT72:{cat:"C",span:27.1},
  B752:{cat:"D",span:38.5}, B753:{cat:"D",span:38.5}, A300:{cat:"D",span:44.8}, A310:{cat:"D",span:44.8},
  A332:{cat:"E",span:64}, A333:{cat:"E",span:64}, A339:{cat:"E",span:64},
  A359:{cat:"E",span:64.8}, A35K:{cat:"E",span:64.8},
  B762:{cat:"E",span:47.6}, B763:{cat:"E",span:51.8}, B764:{cat:"E",span:51.8},
  B772:{cat:"E",span:60.9}, B77L:{cat:"E",span:64.8}, B77W:{cat:"E",span:64.8},
  B788:{cat:"E",span:60.1}, B789:{cat:"E",span:60.1}, B78X:{cat:"E",span:60.1},
  B744:{cat:"E",span:64.4}, B748:{cat:"E",span:68.4}, A388:{cat:"F",span:79.8}
};

const AIRLINE_ALIASES = {
  EWG:["EWG","EW","EUROWINGS"], DLH:["DLH","LH","LUFTHANSA"],
  RYR:["RYR","FR","RYANAIR"], WZZ:["WZZ","W6","WIZZAIR"],
  EZY:["EZY","U2","EASYJET"], TUI:["TUI","TOM","TUIFLY"],
  CFG:["CFG","DE","CONDOR"], AUA:["AUA","OS","AUSTRIAN"],
  SWR:["SWR","LX","SWISS"], KLM:["KLM","KL"], AFR:["AFR","AF","AIRFRANCE"],
  BAW:["BAW","BA","BRITISH AIRWAYS"], TAP:["TAP","TP","TAP AIR PORTUGAL"],
  SAS:["SAS","SK"], LOT:["LOT","LO"], FIN:["FIN","AY"], UAE:["UAE","EK"],
  QTR:["QTR","QR"], SIA:["SIA","SQ"], THY:["THY","TK"], ACA:["ACA","AC"],
  DAL:["DAL","DL"], UAL:["UAL","UA"], AAL:["AAL","AA"]
};

function normalizeAircraft(v) {
  return String(v || "").split("/")[0].trim().toUpperCase();
}

function aircraftInfo(v) {
  const t = normalizeAircraft(v);
  if (AIRCRAFT_INFO[t]) return AIRCRAFT_INFO[t];
  if (/^A31[89]$|^A32[0-1]$|^A2[01]N$|^B73\d$|^B3[89]M$|^E1[789]\d$|^E29\d$|^CRJ/.test(t)) {
    return {cat:"C", span:null};
  }
  if (/^B75|^A3[01]\d/.test(t)) return {cat:"D", span:null};
  if (/^B7[678]|^A33|^A35/.test(t)) return {cat:"E", span:null};
  if (/^A38/.test(t)) return {cat:"F", span:null};
  return {cat:"", span:null};
}

function normalizeAirline(v) {
  const s = String(v || "").trim().toUpperCase();
  if (!s) return [];
  for (const [icao, aliases] of Object.entries(AIRLINE_ALIASES)) {
    if (aliases.some(x => s === x || s.includes(x))) return [icao, ...aliases];
  }
  return [s];
}

function callsignAirline(callsign) {
  const prefix = String(callsign || "").toUpperCase().replace(/\d.*$/, "");
  for (const [icao, aliases] of Object.entries(AIRLINE_ALIASES)) {
    if (aliases.includes(prefix)) return icao;
  }
  return prefix || null;
}

function getOperators(tags) {
  for (const k of ["airline","operator","operators","network","brand"]) {
    if (tags[k]) return String(tags[k]).split(/[;,|]/).map(x => x.trim()).filter(Boolean);
  }
  return [];
}

function haversineMeters(a,b,c,d) {
  const R=6371000, rad=x=>x*Math.PI/180;
  const dLat=rad(c-a), dLon=rad(d-b);
  const q=Math.sin(dLat/2)**2 + Math.cos(rad(a))*Math.cos(rad(c))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(q));
}

async function fetchAirportDB() {
  if (airportDB.map.size && Date.now()-airportDB.timestamp < AIRPORT_DB_TTL) return airportDB.map;
  if (airportDBPromise) return airportDBPromise;

  airportDBPromise = (async () => {
    try {
      const r = await fetch(OUR_AIRPORTS_URL, {headers:{"User-Agent":"VATSIM-Gate-Finder/Stable/1.0"}});
      if (!r.ok) throw new Error(`OurAirports HTTP ${r.status}`);
      const csv = await r.text();

      const rows=[]; let row=[], cell="", quoted=false;
      for (let i=0;i<csv.length;i++) {
        const ch=csv[i];
        if (ch === '"' && csv[i+1] === '"' && quoted) { cell+='"'; i++; continue; }
        if (ch === '"') { quoted=!quoted; continue; }
        if (ch === ',' && !quoted) { row.push(cell); cell=""; continue; }
        if ((ch === '\n' || ch === '\r') && !quoted) {
          if (ch === '\r' && csv[i+1] === '\n') i++;
          row.push(cell); rows.push(row); row=[]; cell=""; continue;
        }
        cell += ch;
      }
      if (cell || row.length) { row.push(cell); rows.push(row); }

      const header=rows.shift();
      const idx=Object.fromEntries(header.map((x,i)=>[x,i]));
      const map=new Map();

      for (const r of rows) {
        const ident=String(r[idx.ident]||"").trim().toUpperCase();
        const lat=Number(r[idx.latitude_deg]), lon=Number(r[idx.longitude_deg]);
        if (/^[A-Z0-9]{4}$/.test(ident) && Number.isFinite(lat) && Number.isFinite(lon)) {
          map.set(ident,{lat,lon,name:r[idx.name]||ident});
        }
      }

      airportDB={timestamp:Date.now(),map};
      return map;
    } finally {
      airportDBPromise=null;
    }
  })();

  return airportDBPromise;
}

function parseGateElement(el) {
  const tags=el.tags||{};
  if (el.type!=="node") return null;
  if (tags.aeroway!=="parking_position" && tags.aeroway!=="gate") return null;

  const name=tags.ref||tags["stand:ref"]||tags["parking:ref"]||tags.name;
  if (!name) return null;

  const span=Number.parseFloat(String(
    tags.maxspan||tags.max_wingspan||tags.wingspan||""
  ).replace(",","." ));
  const category=String(
    tags["aircraft:reference_code"]||tags["aircraft:size"]||tags.code||""
  ).toUpperCase();

  return {
    name:String(name),
    type:tags.aeroway==="gate"?"Gate":"Standplatz",
    category:["A","B","C","D","E","F"].includes(category)?category:null,
    maxWingspanM:Number.isFinite(span)?span:null,
    airlines:getOperators(tags),
    lat:Number(el.lat),
    lon:Number(el.lon),
    osmId:el.id
  };
}

function dedupeGates(gates) {
  const unique=[];
  for (const gate of gates) {
    const key=gate.name.toUpperCase().replace(/\s+/g,"");
    const same=unique.find(g =>
      g.name.toUpperCase().replace(/\s+/g,"")===key &&
      haversineMeters(g.lat,g.lon,gate.lat,gate.lon)<35
    );

    if (!same) unique.push(gate);
    else if (same.type!=="Gate" && gate.type==="Gate") Object.assign(same,gate);
  }

  return unique.sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:"base"}));
}

/*
 * Area query instead of "around 5 km".
 *
 * This is a major stability improvement:
 * - no airport-coordinate guesswork
 * - no giant radius scan
 * - only nodes inside the airport polygon
 * - POST is preferred by Private.coffee
 */
function buildGateQuery(icao) {
  return `
[out:json][timeout:20];
area["aeroway"="aerodrome"]["icao"="${icao}"]->.airport;
(
  node["aeroway"="gate"](area.airport);
  node["aeroway"="parking_position"](area.airport);
);
out body;
`;
}

async function fetchOverpassEndpoint(endpoint, icao) {
  const controller=new AbortController();
  // 7.5 seconds per endpoint. The two endpoints run in parallel.
  const timeout=setTimeout(()=>controller.abort(),7500);

  try {
    const query=buildGateQuery(icao);

    const response=await fetch(endpoint,{
      method:"POST",
      headers:{
        "Content-Type":"application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent":"VATSIM-Gate-Finder/Stable/1.0 (https://vatsim-gate-finder.onrender.com)",
        "Accept":"application/json"
      },
      body:"data="+encodeURIComponent(query),
      signal:controller.signal
    });

    if (!response.ok) throw new Error(`${endpoint} HTTP ${response.status}`);

    const data=await response.json();
    const gates=(data.elements||[]).map(parseGateElement).filter(Boolean);
    return {
      endpoint,
      gates:dedupeGates(gates),
      osmTimestamp:data.osm3s?.timestamp_osm_base||null
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchGatesFromOSM(icao) {
  const jobs=OVERPASS_ENDPOINTS.map(endpoint=>fetchOverpassEndpoint(endpoint,icao));

  // Return the first *useful* response. If one endpoint returns an empty
  // result but the other returns actual gates, choose the useful result.
  const results=[];
  const settled=await Promise.allSettled(jobs);

  for (const item of settled) {
    if (item.status==="fulfilled") results.push(item.value);
    else console.warn("[Overpass]",item.reason?.message||item.reason);
  }

  if (!results.length) {
    throw new Error("Alle Overpass-Server waren nicht erreichbar oder liefen in ein Timeout.");
  }

  results.sort((a,b)=>b.gates.length-a.gates.length);

  // If both are empty, keep the first valid empty response.
  return results[0];
}

async function getAirportGates(icao) {
  const cached=gateCache.get(icao);
  if (cached && Date.now()-cached.timestamp<GATE_CACHE_TTL) return cached.data;

  const data=await fetchGatesFromOSM(icao);

  const result={
    icao,
    source:"OpenStreetMap / Overpass",
    osmTimestamp:data.osmTimestamp,
    total_gates:data.gates.length,
    gates:data.gates
  };

  gateCache.set(icao,{timestamp:Date.now(),data:result});
  return result;
}

async function getVatsimPilots() {
  if (Date.now()-vatsimCache.timestamp<VATSIM_CACHE_TTL) return vatsimCache.pilots;

  const r=await fetch("https://data.vatsim.net/v3/vatsim-data.json",{
    headers:{"User-Agent":"VATSIM-Gate-Finder/Stable/1.0"}
  });
  if (!r.ok) throw new Error(`VATSIM HTTP ${r.status}`);

  const data=await r.json();
  vatsimCache={timestamp:Date.now(),pilots:Array.isArray(data.pilots)?data.pilots:[]};
  return vatsimCache.pilots;
}

function gateAirlineMatches(gate,requestedAirline) {
  if (!requestedAirline || !gate.airlines?.length) return true;
  const aliases=normalizeAirline(requestedAirline);
  return gate.airlines.some(op =>
    aliases.some(a=>String(op).toUpperCase()===a || String(op).toUpperCase().includes(a))
  );
}

function gateAircraftMatches(gate,requestedAircraft) {
  if (!requestedAircraft) return true;
  if (!gate.category && !gate.maxWingspanM) return true;

  if (gate.category && requestedAircraft.cat) {
    return "ABCDEF".indexOf(requestedAircraft.cat)<=
      "ABCDEF".indexOf(gate.category);
  }

  if (gate.maxWingspanM && requestedAircraft.span) {
    return requestedAircraft.span<=gate.maxWingspanM+0.5;
  }

  return true;
}

function getAirportOfPilot(pilot) {
  const fp=pilot.flight_plan||{};
  return {
    departure:String(fp.departure||"").toUpperCase(),
    arrival:String(fp.arrival||"").toUpperCase()
  };
}

function assignOccupancy(gates,icao,pilots) {
  const candidates=[];

  for (const pilot of pilots) {
    const {departure,arrival}=getAirportOfPilot(pilot);
    if (departure!==icao && arrival!==icao) continue;

    const lat=Number(pilot.latitude), lon=Number(pilot.longitude);
    if (!Number.isFinite(lat)||!Number.isFinite(lon)) continue;

    const gs=Number(pilot.groundspeed||0);
    const radius=gs<=3 ? 70 : gs<=12 ? OCCUPANCY_RADIUS_M : DIRECT_GATE_RADIUS_M;

    let best=null;
    for (let i=0;i<gates.length;i++) {
      const d=haversineMeters(gates[i].lat,gates[i].lon,lat,lon);
      if (d<=radius && (!best || d<best.distance)) {
        best={gateIndex:i,distance:d};
      }
    }

    if (!best) continue;
    candidates.push({
      pilot,
      gateIndex:best.gateIndex,
      distance:best.distance,
      groundspeed:gs
    });
  }

  // Global one-to-one matching: every pilot and every gate is used once.
  candidates.sort((a,b)=>a.distance-b.distance);
  const usedPilots=new Set();
  const usedGates=new Set();
  const assignments=[];

  for (const c of candidates) {
    const pilotId=String(c.pilot.cid||c.pilot.callsign||"");
    if (usedPilots.has(pilotId)||usedGates.has(c.gateIndex)) continue;

    usedPilots.add(pilotId);
    usedGates.add(c.gateIndex);

    const callsign=String(c.pilot.callsign||"").toUpperCase();
    const prefix=(callsign.match(/^[A-Z]{3}/)||[""])[0];
    const airline=Object.entries(AIRLINE_ALIASES).find(([,a])=>a.includes(prefix))?.[0]||prefix||"Unknown";
    const aircraft=normalizeAircraft(c.pilot.flight_plan?.aircraft_short||c.pilot.flight_plan?.aircraft||"");

    assignments.push({
      gateIndex:c.gateIndex,
      callsign:c.pilot.callsign,
      airline,
      aircraft,
      cid:c.pilot.cid,
      distanceM:Math.round(c.distance),
      groundspeed:c.groundspeed
    });
  }

  return assignments;
}

app.get("/api/health",(_req,res)=>{
  res.json({
    ok:true,
    version:"STABLE",
    serverTime:new Date().toISOString(),
    vatsimFeedAgeSeconds:vatsimCache.timestamp?Math.round((Date.now()-vatsimCache.timestamp)/1000):null,
    gateCacheSize:gateCache.size,
    overpassEndpoints:OVERPASS_ENDPOINTS
  });
});

app.get("/api/gates",async(req,res)=>{
  const icao=String(req.query.icao||"").trim().toUpperCase();
  const airline=String(req.query.airline||"").trim().toUpperCase();
  const aircraft=normalizeAircraft(req.query.aircraft||"");

  if (!/^[A-Z0-9]{4}$/.test(icao)) {
    return res.status(400).json({error:"Bitte einen gültigen 4-stelligen ICAO-Code eingeben."});
  }

  try {
    const [airportData,pilots]=await Promise.all([
      getAirportGates(icao),
      getVatsimPilots().catch(e=>{
        console.warn("[VATSIM]",e.message);
        return [];
      })
    ]);

    if (!airportData.gates.length) {
      return res.status(404).json({
        error:`Keine Gate-/Stand-Daten für ${icao} gefunden.`,
        hint:"OSM hat für diesen Flughafen aktuell keine benannten Gate-/Parking-Positionen geliefert.",
        overpass:airportData.source
      });
    }

    const requestedAircraft=aircraftInfo(aircraft);
    const occupancy=assignOccupancy(airportData.gates,icao,pilots);
    const byGate=new Map(occupancy.map(o=>[o.gateIndex,o]));

    const gates=airportData.gates.map((g,i)=>{
      const occ=byGate.get(i)||null;
      const airlineOK=!airline || !g.airlines.length ||
        g.airlines.some(x=>normalizeAirline(airline).some(a=>String(x).toUpperCase().includes(a)));
      const aircraftOK=gateAircraftMatches(g,requestedAircraft);

      return {
        ...g,
        compatible:airlineOK&&aircraftOK,
        occupied:Boolean(occ),
        available:airlineOK&&aircraftOK&&!occ,
        status:occ?"occupied":(airlineOK&&aircraftOK?"available":"incompatible"),
        occupant:occ||null
      };
    });

    gates.sort((a,b)=>{
      const rank=x=>x.status==="available"?0:(x.status==="incompatible"?1:2);
      return rank(a)-rank(b)||a.name.localeCompare(b.name,undefined,{numeric:true});
    });

    res.setHeader("Cache-Control","no-store");
    res.json({
      version:"STABLE",
      icao,
      source:airportData.source,
      osmTimestamp:airportData.osmTimestamp||null,
      requestedAirline:airline||null,
      requestedAircraft:aircraft||null,
      aircraftInfo:aircraft?{
        category:requestedAircraft.cat||null,
        wingspanM:requestedAircraft.span||null
      }:null,
      total_gates:gates.length,
      available_count:gates.filter(g=>g.available).length,
      occupied_count:gates.filter(g=>g.occupied).length,
      incompatible_count:gates.filter(g=>!g.compatible).length,
      occupiedAircraftCount:occupancy.length,
      vatsimUpdatedAt:vatsimCache.timestamp?new Date(vatsimCache.timestamp).toISOString():null,
      gates
    });
  } catch(e) {
    console.error(e);
    res.status(502).json({
      error:"Gate-Daten konnten gerade nicht abgerufen werden.",
      details:e.name==="AbortError"?"Overpass request timeout":e.message
    });
  }
});

app.listen(PORT,"0.0.0.0",()=>console.log(`VATSIM Gate Finder STABLE listening on ${PORT}`));
