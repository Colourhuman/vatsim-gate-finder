const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.static(__dirname));
app.use(express.json());

const VATSIM_CACHE_TTL = 12_000;
const GATE_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const AIRPORT_DB_TTL = 24 * 60 * 60 * 1000;

// Aircraft is considered to "occupy" a stand only when it is actually near
// the stand AND moving slowly enough to plausibly be at/approaching the stand.
// This prevents a taxiing aircraft 80m away from painting multiple gates red.
const OCCUPANCY_RADIUS_M = Number(process.env.OCCUPANCY_RADIUS_M || 55);
const OCCUPANCY_MAX_GROUNDSPEED_KTS = Number(process.env.OCCUPANCY_MAX_GROUNDSPEED_KTS || 20);
const DIRECT_GATE_RADIUS_M = Number(process.env.DIRECT_GATE_RADIUS_M || 25);

const OSM_RADIUS_M = Number(process.env.OSM_RADIUS_M || 5000);
const OVERPASS_PROXY = "https://osm.hpi.de/overpass/api/interpreter";
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
  A332:{cat:"E",span:64.0}, A333:{cat:"E",span:64.0}, A339:{cat:"E",span:64.0},
  A359:{cat:"E",span:64.8}, A35K:{cat:"E",span:64.8},
  B762:{cat:"E",span:47.6}, B763:{cat:"E",span:51.8}, B764:{cat:"E",span:51.8},
  B772:{cat:"E",span:60.9}, B77L:{cat:"E",span:64.8}, B77W:{cat:"E",span:64.8},
  B788:{cat:"E",span:60.1}, B789:{cat:"E",span:60.1}, B78X:{cat:"E",span:60.1},
  B744:{cat:"E",span:64.4}, B748:{cat:"E",span:68.4}, A388:{cat:"F",span:79.8}
};

// This is used for displaying the airline of online VATSIM aircraft.
// Gate-specific airline restrictions still come from gate data if OSM
// contains an operator/airline tag.
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
      const r = await fetch(OUR_AIRPORTS_URL, {headers:{"User-Agent":"VATSIM-Gate-Finder/4.0"}});
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

function getElementPoint(el) {
  if (Number.isFinite(el.lat) && Number.isFinite(el.lon)) return {lat:el.lat,lon:el.lon};
  if (el.center && Number.isFinite(el.center.lat) && Number.isFinite(el.center.lon)) {
    return {lat:el.center.lat,lon:el.center.lon};
  }
  return null;
}

function parseGate(el) {
  const tags=el.tags||{};
  if (tags.aeroway!=="parking_position" && tags.aeroway!=="gate") return null;

  // V4 intentionally only accepts NODE positions.
  // parking_position ways are parking lanes, not separate individual stands,
  // and were the primary reason you saw 1, 2, 3... multiple times.
  if (el.type !== "node") return null;

  const p=getElementPoint(el);
  if (!p) return null;

  const name=tags.ref || tags.name || tags["stand:ref"] || tags["parking:ref"];
  if (!name) return null;

  const rawCat=String(tags["aircraft:size"] || tags["aircraft:reference_code"] || tags.code || "").toUpperCase();
  const category=["A","B","C","D","E","F"].includes(rawCat) ? rawCat : null;

  const rawSpan=tags.maxspan || tags.max_wingspan || tags.wingspan || tags["aircraft:max_wingspan"];
  const maxWingspanM=Number.parseFloat(String(rawSpan||"").replace(",","." ));

  return {
    name:String(name),
    type:tags.aeroway==="gate" ? "Gate" : "Standplatz",
    category,
    maxWingspanM:Number.isFinite(maxWingspanM)?maxWingspanM:null,
    airlines:getOperators(tags),
    lat:p.lat, lon:p.lon,
    osmType:el.type, osmId:el.id
  };
}

async function fetchGatesFromOSM(coords) {
  const query=`
[out:json][timeout:20];
(
  node["aeroway"="parking_position"](around:${OSM_RADIUS_M},${coords.lat},${coords.lon});
  node["aeroway"="gate"](around:${OSM_RADIUS_M},${coords.lat},${coords.lon});
);
out body;
`;

  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),8500);

  try {
    const url=OVERPASS_PROXY+"?data="+encodeURIComponent(query);
    const response=await fetch(url,{
      headers:{"User-Agent":"VATSIM-Gate-Finder/4.0","Accept":"application/json"},
      signal:controller.signal
    });
    if (!response.ok) throw new Error(`OSM proxy HTTP ${response.status}`);
    const data=await response.json();

    const raw=(data.elements||[]).map(parseGate).filter(Boolean);
    const deduped=[];

    for (const gate of raw) {
      // De-duplicate by ref first. If two OSM objects use the same stand number
      // within a few meters, keep the best one. This also protects against
      // duplicate gate+parking_position tagging.
      const sameName=deduped.find(g =>
        g.name.toUpperCase()===gate.name.toUpperCase() &&
        haversineMeters(g.lat,g.lon,gate.lat,gate.lon)<35
      );
      if (!sameName) deduped.push(gate);
      else if (sameName.type!=="Gate" && gate.type==="Gate") {
        Object.assign(sameName,gate);
      }
    }

    deduped.sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:"base"}));
    return deduped;
  } finally {
    clearTimeout(timeout);
  }
}

async function getAirportGates(icao) {
  const cached=gateCache.get(icao);
  if (cached && Date.now()-cached.timestamp<GATE_CACHE_TTL) return cached.data;

  const airports=await fetchAirportDB();
  const coords=airports.get(icao);
  if (!coords) throw new Error(`Airport ${icao} konnte nicht in OurAirports gefunden werden.`);

  const gates=await fetchGatesFromOSM(coords);
  const result={icao,airportName:coords.name,airportLat:coords.lat,airportLon:coords.lon,total_gates:gates.length,gates};
  gateCache.set(icao,{timestamp:Date.now(),data:result});
  return result;
}

async function getVatsimPilots() {
  if (Date.now()-vatsimCache.timestamp<VATSIM_CACHE_TTL) return vatsimCache.pilots;

  const r=await fetch("https://data.vatsim.net/v3/vatsim-data.json",{
    headers:{"User-Agent":"VATSIM-Gate-Finder/4.0"}
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
    aliases.some(a => String(op).toUpperCase()===a || String(op).toUpperCase().includes(a))
  );
}

function gateAircraftMatches(gate,requestedAircraft) {
  if (!requestedAircraft) return true;
  const info=aircraftInfo(requestedAircraft);

  // If an airport gate has no aircraft restrictions in OSM, don't reject it.
  if (!gate.category && !gate.maxWingspanM) return true;

  if (gate.category && info.cat) {
    return "ABCDEF".indexOf(info.cat) <= "ABCDEF".indexOf(gate.category);
  }

  if (gate.maxWingspanM && info.span) {
    return info.span <= gate.maxWingspanM + 0.5;
  }

  return true;
}

/*
 * Key fix:
 * Rather than asking "which aircraft is within 55m of this gate?" independently
 * for every gate, first find a unique best gate for every aircraft.
 *
 * Result: one aircraft can occupy ONE gate, never 2, 3 or 4 gates at once.
 */
function assignVatsimOccupancy(gates,icao,pilots) {
  const assignments=[];

  for (const p of pilots) {
    const fp=p.flight_plan||{};
    const dep=String(fp.departure||"").toUpperCase();
    const arr=String(fp.arrival||"").toUpperCase();
    if (dep!==icao && arr!==icao) continue;

    const lat=Number(p.latitude), lon=Number(p.longitude), gs=Number(p.groundspeed||0);
    if (!Number.isFinite(lat)||!Number.isFinite(lon)) continue;

    const candidates=gates.map((g,index)=>({
      gateIndex:index,
      distance:haversineMeters(g.lat,g.lon,lat,lon)
    })).filter(x => x.distance <= OCCUPANCY_RADIUS_M);

    if (!candidates.length) continue;

    candidates.sort((a,b)=>a.distance-b.distance);
    const best=candidates[0];

    // Fast-moving aircraft are taxiing, departing, or arriving and should
    // not make an apron position red from a far-away point.
    // A very close aircraft may still be considered occupying even if its
    // reported speed is a little above the threshold.
    if (gs > OCCUPANCY_MAX_GROUNDSPEED_KTS && best.distance > DIRECT_GATE_RADIUS_M) continue;

    assignments.push({
      gateIndex:best.gateIndex,
      callsign:p.callsign,
      airline:callsignAirline(p.callsign),
      aircraft:normalizeAircraft(fp.aircraft_short||fp.aircraft),
      distanceM:Math.round(best.distance),
      groundspeed:gs,
      cid:p.cid
    });
  }

  // If multiple pilots somehow claim the same gate, keep the physically closest one.
  assignments.sort((a,b)=>a.distanceM-b.distanceM);
  const usedGates=new Set();
  const chosen=[];

  for (const a of assignments) {
    if (usedGates.has(a.gateIndex)) continue;
    usedGates.add(a.gateIndex);
    chosen.push(a);
  }

  return chosen;
}

app.get("/api/health",(_req,res)=>{
  res.json({
    ok:true,
    version:"4.0",
    timestamp:new Date().toISOString(),
    config:{
      occupancyRadiusM:OCCUPANCY_RADIUS_M,
      occupancyMaxGroundspeedKts:OCCUPANCY_MAX_GROUNDSPEED_KTS,
      directGateRadiusM:DIRECT_GATE_RADIUS_M,
      osmRadiusM:OSM_RADIUS_M
    },
    cache:{
      airportCount:gateCache.size,
      vatsimFeedAgeSeconds:vatsimCache.timestamp?Math.round((Date.now()-vatsimCache.timestamp)/1000):null
    }
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
      getVatsimPilots().catch(e=>{console.warn("[VATSIM]",e.message);return [];})
    ]);

    if (!airportData.gates.length) {
      return res.status(404).json({
        error:`Keine Gate-/Stand-Daten für ${icao} gefunden.`,
        hint:"OSM enthält im Suchradius keine benannten Node-Positionen für Gate/Parking Position."
      });
    }

    const occupied=assignVatsimOccupancy(airportData.gates,icao,pilots);

    const gates=airportData.gates.map((g,i)=>{
      const occ=occupied.find(x=>x.gateIndex===i) || null;
      const airlineOk=gateAirlineMatches(g,airline);
      const aircraftOk=gateAircraftMatches(g,aircraft);

      return {
        ...g,
        requestedAirline:airline||null,
        requestedAircraft:aircraft||null,
        requestedAircraftCategory:aircraft?aircraftInfo(aircraft).cat||null:null,
        requestedAircraftWingspanM:aircraft?aircraftInfo(aircraft).span||null:null,
        compatible:airlineOk&&aircraftOk,
        occupied:Boolean(occ),
        available:airlineOk&&aircraftOk&&!occ,
        occupant:occ
      };
    });

    gates.sort((a,b)=>{
      const rank=x=>x.available?0:(x.occupied?2:1);
      return rank(a)-rank(b)||a.name.localeCompare(b.name,undefined,{numeric:true});
    });

    res.setHeader("Cache-Control","no-store");
    res.json({
      version:"4.0",
      icao,
      airportName:airportData.airportName,
      requestedAirline:airline||null,
      requestedAircraft:aircraft||null,
      requestedAircraftCategory:aircraft?aircraftInfo(aircraft).cat||null:null,
      requestedAircraftWingspanM:aircraft?aircraftInfo(aircraft).span||null:null,
      total_gates:gates.length,
      available_count:gates.filter(g=>g.available).length,
      occupied_count:gates.filter(g=>g.occupied).length,
      incompatible_count:gates.filter(g=>!g.compatible).length,
      occupiedAircraftCount:occupied.length,
      gateDataCached:true,
      vatsimUpdatedAt:vatsimCache.timestamp?new Date(vatsimCache.timestamp).toISOString():null,
      gates
    });
  } catch(e) {
    console.error(e);
    const msg=e.name==="AbortError"
      ?"OSM-Gate-Abfrage hat das 8,5-Sekunden-Limit überschritten."
      :e.message;
    res.status(502).json({error:"Gate-Daten konnten gerade nicht abgerufen werden.",details:msg});
  }
});

app.listen(PORT,"0.0.0.0",()=>console.log(`VATSIM Gate Finder 4.0 listening on ${PORT}`));
