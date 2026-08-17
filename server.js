const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.static(__dirname));
app.use(express.json());

const VATSIM_CACHE_TTL = 12_000;
const GATE_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const AIRPORT_DB_TTL = 24 * 60 * 60 * 1000;
const OCCUPANCY_RADIUS_M = Number(process.env.OCCUPANCY_RADIUS_M || 90);
const OSM_RADIUS_M = Number(process.env.OSM_RADIUS_M || 5000);

// IMPORTANT:
// We deliberately do NOT call three Overpass servers in sequence anymore.
// Render was timing out on those requests. The HPI reverse proxy is designed
// to load-balance/cache public Overpass requests and documents 24h caching.
const OVERPASS_PROXY = "https://osm.hpi.de/overpass/api/interpreter";
const OUR_AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv";

const gateCache = new Map();
let vatsimCache = { timestamp: 0, pilots: [] };
let airportDB = { timestamp: 0, map: new Map() };
let airportDBPromise = null;

const AIRCRAFT_CATEGORY = {
  A318:"C",A319:"C",A320:"C",A321:"C",A20N:"C",A21N:"C",
  B737:"C",B731:"C",B732:"C",B733:"C",B734:"C",B735:"C",B736:"C",
  B737:"C",B738:"C",B739:"C",B38M:"C",B39M:"C",
  E170:"C",E175:"C",E190:"C",E195:"C",E290:"C",E295:"C",
  CRJ7:"C",CRJ9:"C",CRJX:"C",DH8D:"C",AT72:"C",
  B752:"D",B753:"D",A300:"D",A310:"D",
  A332:"E",A333:"E",A339:"E",A350:"E",A359:"E",A35K:"E",
  B762:"E",B763:"E",B764:"E",B772:"E",B77L:"E",B77W:"E",
  B788:"E",B789:"E",B78X:"E",B744:"E",B748:"E",A388:"F"
};

const AIRCRAFT_WINGSPAN_M = {
  A318:34.1,A319:35.8,A320:35.8,A321:35.8,A20N:35.8,A21N:35.8,
  B737:35.8,B738:35.8,B739:35.9,B38M:35.9,B39M:35.9,
  E170:26,E175:28.7,E190:28.7,E195:28.7,E290:33.7,E295:33.7,
  CRJ7:24.9,CRJ9:26.2,CRJX:26.2,
  B752:38.5,B753:38.5,A300:44.8,A310:44.8,
  A332:64,A333:64,A339:64,A359:64.8,A35K:64.8,
  B762:47.6,B763:51.8,B764:51.8,B772:60.9,B77L:64.8,B77W:64.8,
  B788:60.1,B789:60.1,B78X:60.1,B744:64.4,B748:68.4,A388:79.8
};

const AIRLINE_ALIASES = {
  EWG:["EWG","EW","EUROWINGS"],DLH:["DLH","LH","LUFTHANSA"],
  RYR:["RYR","FR","RYANAIR"],WZZ:["WZZ","W6","WIZZAIR"],
  EZY:["EZY","U2","EASYJET"],TUI:["TUI","TUIFLY"],
  CFG:["CFG","DE","CONDOR"],AUA:["AUA","OS","AUSTRIAN"],
  SWR:["SWR","LX","SWISS"],KLM:["KLM","KL"],
  AFR:["AFR","AF","AIRFRANCE"],BAW:["BAW","BA","BRITISH AIRWAYS"],
  TAP:["TAP","TP","TAP AIR PORTUGAL"],SAS:["SAS","SK"]
};

function normalizeAircraft(v) {
  return String(v || "").split("/")[0].trim().toUpperCase();
}

function aircraftCategory(v) {
  const t = normalizeAircraft(v);
  if (AIRCRAFT_CATEGORY[t]) return AIRCRAFT_CATEGORY[t];
  if (/^B73/.test(t) || /^A31[89]$/.test(t) || /^A32/.test(t) ||
      /^E19/.test(t) || /^CRJ/.test(t)) return "C";
  if (/^(B75|A30|A31)/.test(t)) return "D";
  if (/^(B76|B77|B78|A33|A35)/.test(t)) return "E";
  if (/^A38/.test(t)) return "F";
  return "";
}

function normalizeAirline(v) {
  const s = String(v || "").trim().toUpperCase();
  if (!s) return [];
  for (const [icao, aliases] of Object.entries(AIRLINE_ALIASES)) {
    if (aliases.some(x => s === x || s.includes(x))) return [icao, ...aliases];
  }
  return [s];
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
      const r = await fetch(OUR_AIRPORTS_URL, {headers:{"User-Agent":"VATSIM-Gate-Finder/3.0"}});
      if (!r.ok) throw new Error(`OurAirports HTTP ${r.status}`);
      const csv = await r.text();

      // CSV parser sufficient for this dataset's columns because we only need
      // ident + latitude_deg + longitude_deg. It handles quoted fields.
      const rows = [];
      let row=[], cell="", quoted=false;
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

      const header = rows.shift();
      const idx = Object.fromEntries(header.map((x,i)=>[x,i]));
      const map = new Map();

      for (const r of rows) {
        const ident = String(r[idx.ident] || "").trim().toUpperCase();
        const lat = Number(r[idx.latitude_deg]);
        const lon = Number(r[idx.longitude_deg]);
        if (/^[A-Z0-9]{4}$/.test(ident) && Number.isFinite(lat) && Number.isFinite(lon)) {
          map.set(ident, {lat,lon,name:r[idx.name] || ident});
        }
      }

      airportDB = {timestamp:Date.now(),map};
      return map;
    } finally {
      airportDBPromise = null;
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
  const tags = el.tags || {};
  if (tags.aeroway !== "parking_position" && tags.aeroway !== "gate") return null;
  const p = getElementPoint(el);
  if (!p) return null;

  const name = tags.ref || tags.name || tags["stand:ref"] || tags["parking:ref"];
  if (!name) return null;

  const rawCat = String(tags["aircraft:size"] || tags["aircraft:reference_code"] || tags.code || "").toUpperCase();
  const category = ["A","B","C","D","E","F"].includes(rawCat) ? rawCat : null;

  const rawSpan = tags.maxspan || tags.max_wingspan || tags.wingspan || tags["aircraft:max_wingspan"];
  const maxWingspanM = Number.parseFloat(String(rawSpan || "").replace(",", "."));

  return {
    name:String(name),
    type:tags.aeroway === "gate" ? "Gate" : "Standplatz",
    category,
    maxWingspanM:Number.isFinite(maxWingspanM) ? maxWingspanM : null,
    airlines:getOperators(tags),
    lat:p.lat, lon:p.lon, osmType:el.type, osmId:el.id
  };
}

async function fetchGatesFromOSM(icao, coords) {
  const query = `
[out:json][timeout:25];
(
  nwr["aeroway"="parking_position"](around:${OSM_RADIUS_M},${coords.lat},${coords.lon});
  nwr["aeroway"="gate"](around:${OSM_RADIUS_M},${coords.lat},${coords.lon});
);
out center tags;
`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const url = OVERPASS_PROXY + "?data=" + encodeURIComponent(query);
    const response = await fetch(url, {
      headers:{
        "User-Agent":"VATSIM-Gate-Finder/3.0",
        "Accept":"application/json"
      },
      signal:controller.signal
    });
    if (!response.ok) throw new Error(`OSM proxy HTTP ${response.status}`);
    const data = await response.json();

    const gates = (data.elements || [])
      .map(parseGate)
      .filter(Boolean)
      .filter(g => haversineMeters(coords.lat,coords.lon,g.lat,g.lon) <= OSM_RADIUS_M + 100);

    const deduped = [];
    for (const gate of gates) {
      if (!deduped.some(g => g.name === gate.name &&
          haversineMeters(g.lat,g.lon,gate.lat,gate.lon) < 10)) {
        deduped.push(gate);
      }
    }

    deduped.sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:"base"}));
    return deduped;
  } finally {
    clearTimeout(timeout);
  }
}

async function getAirportGates(icao) {
  const cached = gateCache.get(icao);
  if (cached && Date.now()-cached.timestamp < GATE_CACHE_TTL) return cached.data;

  const airports = await fetchAirportDB();
  const coords = airports.get(icao);
  if (!coords) throw new Error(`Airport ${icao} konnte nicht in OurAirports gefunden werden.`);

  const gates = await fetchGatesFromOSM(icao,coords);

  const result = {
    icao,
    airportName:coords.name,
    airportLat:coords.lat,
    airportLon:coords.lon,
    total_gates:gates.length,
    gates
  };

  gateCache.set(icao,{timestamp:Date.now(),data:result});
  return result;
}

async function getVatsimPilots() {
  if (Date.now()-vatsimCache.timestamp < VATSIM_CACHE_TTL) return vatsimCache.pilots;

  const r = await fetch("https://data.vatsim.net/v3/vatsim-data.json", {
    headers:{"User-Agent":"VATSIM-Gate-Finder/3.0"}
  });
  if (!r.ok) throw new Error(`VATSIM HTTP ${r.status}`);
  const data=await r.json();

  vatsimCache={timestamp:Date.now(),pilots:Array.isArray(data.pilots)?data.pilots:[]};
  return vatsimCache.pilots;
}

function airlineMatches(gate,airline) {
  if (!airline || !gate.airlines?.length) return true;
  const aliases=normalizeAirline(airline);
  return gate.airlines.some(op => aliases.some(a => String(op).toUpperCase()===a ||
                                                   String(op).toUpperCase().includes(a)));
}

function aircraftMatches(gate,aircraft) {
  if (!aircraft) return true;
  const cat=aircraftCategory(aircraft);
  if (gate.category && cat) return "ABCDEF".indexOf(cat) <= "ABCDEF".indexOf(gate.category);
  const span=AIRCRAFT_WINGSPAN_M[normalizeAircraft(aircraft)];
  if (gate.maxWingspanM && span) return span <= gate.maxWingspanM + 0.5;
  return true;
}

function gateOccupant(gate,icao,pilots) {
  let closest=null;
  for (const p of pilots) {
    const lat=Number(p.latitude), lon=Number(p.longitude);
    if (!Number.isFinite(lat)||!Number.isFinite(lon)) continue;

    const fp=p.flight_plan || {};
    const dep=String(fp.departure||"").toUpperCase();
    const arr=String(fp.arrival||"").toUpperCase();
    if (dep!==icao && arr!==icao) continue;

    const distance=haversineMeters(gate.lat,gate.lon,lat,lon);
    if (distance>OCCUPANCY_RADIUS_M) continue;

    const gs=Number(p.groundspeed||0);
    const score=distance + Math.min(gs,80)*0.4;
    if (!closest || score<closest.score) {
      closest={
        callsign:p.callsign,
        aircraft:normalizeAircraft(fp.aircraft_short||fp.aircraft),
        distanceM:Math.round(distance),
        groundspeed:gs,
        cid:p.cid
      };
    }
  }
  return closest;
}

app.get("/api/health", async (_req,res)=>{
  res.json({
    ok:true,
    version:"3.0",
    timestamp:new Date().toISOString(),
    gateCacheSize:gateCache.size,
    vatsimFeedAgeSeconds:vatsimCache.timestamp ? Math.round((Date.now()-vatsimCache.timestamp)/1000) : null,
    sources:{
      airportCoordinates:"OurAirports",
      gates:"OpenStreetMap via HPI Overpass proxy",
      occupancy:"VATSIM v3 live data"
    }
  });
});

app.get("/api/gates", async (req,res)=>{
  const icao=String(req.query.icao||"").trim().toUpperCase();
  const airline=String(req.query.airline||"").trim().toUpperCase();
  const aircraft=normalizeAircraft(req.query.aircraft||"");

  if (!/^[A-Z0-9]{4}$/.test(icao)) {
    return res.status(400).json({error:"Bitte einen gültigen 4-stelligen ICAO-Code eingeben."});
  }

  try {
    // Gate data is cached for 7 days. VATSIM is independent and refreshed
    // every 12 seconds. Therefore normal searches only do OSM work once per
    // airport per 7 days.
    const [airportData,pilots] = await Promise.all([
      getAirportGates(icao),
      getVatsimPilots().catch(e => {
        console.warn("[VATSIM]",e.message);
        return [];
      })
    ]);

    if (!airportData.gates.length) {
      return res.status(404).json({
        error:`Keine Gate-/Stand-Daten für ${icao} gefunden.`,
        airport:airportData.airportName,
        hint:"OSM enthält im Suchradius keine benannten aeroway=gate/parking_position-Objekte."
      });
    }

    const gates=airportData.gates.map(g=>{
      const occ=gateOccupant(g,icao,pilots);
      const compatible=airlineMatches(g,airline)&&aircraftMatches(g,aircraft);

      return {
        ...g,
        compatible,
        occupied:Boolean(occ),
        available:compatible&&!occ,
        occupant:occ||null
      };
    });

    gates.sort((a,b)=>{
      const rank=x=>x.available?0:(x.occupied?2:1);
      return rank(a)-rank(b) || a.name.localeCompare(b.name,undefined,{numeric:true});
    });

    res.setHeader("Cache-Control","no-store");
    res.json({
      version:"3.0",
      icao,
      airportName:airportData.airportName,
      requestedAirline:airline||null,
      requestedAircraft:aircraft||null,
      total_gates:gates.length,
      available_count:gates.filter(g=>g.available).length,
      occupied_count:gates.filter(g=>g.occupied).length,
      incompatible_count:gates.filter(g=>!g.compatible).length,
      gateDataCached:true,
      vatsimUpdatedAt:vatsimCache.timestamp ? new Date(vatsimCache.timestamp).toISOString() : null,
      gates
    });
  } catch (e) {
    console.error(e);
    const msg=e.name==="AbortError" ? "OSM-Gate-Abfrage hat das 10-Sekunden-Limit überschritten." : e.message;
    res.status(502).json({error:"Gate-Daten konnten gerade nicht abgerufen werden.",details:msg});
  }
});

app.listen(PORT,"0.0.0.0",()=>console.log(`VATSIM Gate Finder 3.0 listening on ${PORT}`));
