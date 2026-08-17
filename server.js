const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.static(__dirname));
app.use(express.json());

// ---------- Configuration ----------
const VATSIM_URL = "https://data.vatsim.net/v3/vatsim-data.json";
const OURAIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const IFATC_URL = icao => `https://www.ifatc.org/gates?code=${encodeURIComponent(icao)}`;
const OSM_MAP_URL = "https://api.openstreetmap.org/api/0.6/map";

const VATSIM_TTL_MS = 12_000;
const AIRPORT_TTL_MS = 24 * 60 * 60 * 1000;
const GATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OSM_TILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Physical stand detection. The important part is:
// - parked: generous radius
// - slow/positioning: medium radius
// - taxiing: tight radius
const PARKED_RADIUS_M = Number(process.env.PARKED_RADIUS_M || 45);
const SLOW_RADIUS_M = Number(process.env.SLOW_RADIUS_M || 28);
const TAXI_RADIUS_M = Number(process.env.TAXI_RADIUS_M || 14);

const OSM_TILE_TIMEOUT_MS = 4500;

const ifatcCache = new Map();
const gateCache = new Map();
const osmTileCache = new Map();
const airportDb = { at: 0, map: new Map() };
let airportDbPromise = null;

let vatsimCache = { at: 0, pilots: [] };

// ---------- Reference data ----------
const AIRCRAFT = {
  A318:{cat:"C",span:34.1,name:"Airbus A318"},
  A319:{cat:"C",span:35.8,name:"Airbus A319"},
  A320:{cat:"C",span:35.8,name:"Airbus A320"},
  A20N:{cat:"C",span:35.8,name:"Airbus A320neo"},
  A321:{cat:"C",span:35.8,name:"Airbus A321"},
  A21N:{cat:"C",span:35.8,name:"Airbus A321neo"},
  B737:{cat:"C",span:35.8,name:"Boeing 737"},
  B738:{cat:"C",span:35.8,name:"Boeing 737-800"},
  B38M:{cat:"C",span:35.9,name:"Boeing 737 MAX 8"},
  B39M:{cat:"C",span:35.9,name:"Boeing 737 MAX 9"},
  E170:{cat:"C",span:26.0,name:"Embraer 170"},
  E175:{cat:"C",span:28.7,name:"Embraer 175"},
  E190:{cat:"C",span:28.7,name:"Embraer 190"},
  E195:{cat:"C",span:28.7,name:"Embraer 195"},
  E290:{cat:"C",span:33.7,name:"Embraer E190-E2"},
  E295:{cat:"C",span:33.7,name:"Embraer E195-E2"},
  CRJ7:{cat:"C",span:24.9,name:"CRJ700"},
  CRJ9:{cat:"C",span:26.2,name:"CRJ900"},
  DH8D:{cat:"C",span:28.4,name:"Dash 8-400"},
  AT72:{cat:"C",span:27.1,name:"ATR 72"},
  B752:{cat:"D",span:38.5,name:"Boeing 757-200"},
  B753:{cat:"D",span:38.5,name:"Boeing 757-300"},
  A300:{cat:"D",span:44.8,name:"Airbus A300"},
  A310:{cat:"D",span:44.8,name:"Airbus A310"},
  A332:{cat:"E",span:60.3,name:"Airbus A330-200"},
  A333:{cat:"E",span:60.3,name:"Airbus A330-300"},
  A339:{cat:"E",span:64.0,name:"Airbus A330-900neo"},
  A359:{cat:"E",span:64.8,name:"Airbus A350-900"},
  A35K:{cat:"E",span:64.8,name:"Airbus A350-1000"},
  B762:{cat:"E",span:47.6,name:"Boeing 767-200"},
  B763:{cat:"E",span:51.8,name:"Boeing 767-300"},
  B772:{cat:"E",span:60.9,name:"Boeing 777-200"},
  B77W:{cat:"E",span:64.8,name:"Boeing 777-300ER"},
  B788:{cat:"E",span:60.1,name:"Boeing 787-8"},
  B789:{cat:"E",span:60.1,name:"Boeing 787-9"},
  B78X:{cat:"E",span:60.1,name:"Boeing 787-10"},
  B744:{cat:"E",span:64.4,name:"Boeing 747-400"},
  B748:{cat:"F",span:68.4,name:"Boeing 747-8"},
  A388:{cat:"F",span:79.8,name:"Airbus A380-800"}
};

const IATA_TO_ICAO = {
  "318":"A318","319":"A319","320":"A320","32N":"A20N","321":"A321","32Q":"A21N",
  "737":"B737","738":"B738","7M8":"B38M","7M9":"B39M","170":"E170","175":"E175",
  "190":"E190","195":"E195","290":"E290","295":"E295","CR7":"CRJ7","CR9":"CRJ9",
  "DH4":"DH8D","AT7":"AT72","752":"B752","75Y":"B753","AB6":"A300","310":"A310",
  "332":"A332","333":"A333","339":"A339","359":"A359","351":"A35K","762":"B762",
  "763":"B763","772":"B772","77W":"B77W","788":"B788","789":"B789","781":"B78X",
  "744":"B744","74H":"B748","388":"A388","380":"A388"
};

const AIRLINE_ALIASES = {
  EWG:["EWG","EW","EUROWINGS"], DLH:["DLH","LH","LUFTHANSA"],
  RYR:["RYR","FR","RYANAIR"], WZZ:["WZZ","W6","WIZZAIR"],
  EZY:["EZY","U2","EASYJET"], CFG:["CFG","DE","CONDOR"],
  TUI:["TUI","X3","TUIFLY"], AUA:["AUA","OS","AUSTRIAN"],
  SWR:["SWR","LX","SWISS"], KLM:["KLM","KL"], AFR:["AFR","AF","AIRFRANCE"],
  BAW:["BAW","BA","BRITISH AIRWAYS"], TAP:["TAP","TP","TAP AIR PORTUGAL"],
  SAS:["SAS","SK"], LOT:["LOT","LO"], FIN:["FIN","AY"], UAE:["UAE","EK"],
  QTR:["QTR","QR"], SIA:["SIA","SQ"], THY:["THY","TK"], ACA:["ACA","AC"],
  DAL:["DAL","DL"], UAL:["UAL","UA"], AAL:["AAL","AA"]
};

// ---------- Helpers ----------
function normalizeAircraft(v) {
  return String(v || "").split("/")[0].trim().toUpperCase();
}

function resolveAircraft(v) {
  const raw = normalizeAircraft(v);
  const key = IATA_TO_ICAO[raw] || raw;

  if (AIRCRAFT[key]) return { icao:key, ...AIRCRAFT[key] };
  if (/^A320/.test(raw)) return { icao:"A320", ...AIRCRAFT.A320 };
  if (/^A321/.test(raw)) return { icao:"A321", ...AIRCRAFT.A321 };
  if (/^A319/.test(raw)) return { icao:"A319", ...AIRCRAFT.A319 };
  if (/^B737/.test(raw)) return { icao:"B737", ...AIRCRAFT.B737 };

  return { icao:raw, name:raw || "Unbekannt", cat:"", span:null };
}

function normalizeAirline(v) {
  const s = String(v || "").trim().toUpperCase();
  if (!s) return null;
  for (const [icao, aliases] of Object.entries(AIRLINE_ALIASES)) {
    if (aliases.includes(s) || aliases.some(a => s.includes(a))) {
      return { icao, aliases };
    }
  }
  return { icao:s, aliases:[s] };
}

function airlineFromCallsign(callsign) {
  const prefix = String(callsign || "").toUpperCase().match(/^[A-Z]{3}/)?.[0] || "";
  for (const [icao, aliases] of Object.entries(AIRLINE_ALIASES)) {
    if (aliases.includes(prefix)) return icao;
  }
  return prefix || "UNKNOWN";
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = x => x * Math.PI / 180;
  const dLat = rad(lat2-lat1);
  const dLon = rad(lon2-lon1);

  const a =
    Math.sin(dLat/2)**2 +
    Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLon/2)**2;

  return 2 * R * Math.asin(Math.sqrt(a));
}

function normalizeRef(v) {
  return String(v || "")
    .toUpperCase()
    .replace(/\s+/g,"")
    .replace(/[-–—_]/g,"");
}

function extractGateNumberParts(v) {
  const s = String(v || "").toUpperCase();
  const matches = s.match(/[A-Z]?\d{1,3}(?:\/\d{1,3})?/g) || [];
  return matches.map(x => x.replace(/\s+/g,""));
}

function canonicalGateNames(v) {
  const raw = String(v || "").toUpperCase().trim();
  const variants = new Set();

  variants.add(normalizeRef(raw));

  for (const part of extractGateNumberParts(raw)) {
    variants.add(normalizeRef(part));
  }

  // D11/D12 and D11 D12 should also be considered related to individual
  // stand anchors when the source only has the grouped name.
  if (raw.includes("/")) {
    for (const piece of raw.split("/")) variants.add(normalizeRef(piece));
  }

  return [...variants].filter(Boolean);
}

// ---------- Airport DB ----------
function parseCsvRows(csv) {
  const rows = [];
  let row = [], cell = "", quoted = false;

  for (let i=0; i<csv.length; i++) {
    const ch = csv[i];

    if (ch === '"' && csv[i+1] === '"' && quoted) {
      cell += '"';
      i++;
      continue;
    }

    if (ch === '"') {
      quoted = !quoted;
      continue;
    }

    if (ch === ',' && !quoted) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && csv[i+1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += ch;
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

async function loadAirports() {
  const cached = airportDb.map.get("__db");
  if (cached && Date.now()-cached.at < AIRPORT_TTL_MS) return cached.data;
  if (airportDbPromise) return airportDbPromise;

  airportDbPromise = (async() => {
    const r = await fetch(OURAIRPORTS_URL, {
      headers: {"User-Agent":"VATSIM-Gate-Finder-v7"}
    });
    if (!r.ok) throw new Error(`OurAirports HTTP ${r.status}`);

    const rows = parseCsvRows(await r.text());
    const header = rows.shift();
    const idx = Object.fromEntries(header.map((x,i)=>[x,i]));
    const map = new Map();

    for (const row of rows) {
      const ident = String(row[idx.ident] || "").trim().toUpperCase();
      const lat = Number(row[idx.latitude_deg]);
      const lon = Number(row[idx.longitude_deg]);

      if (/^[A-Z0-9]{4}$/.test(ident) &&
          Number.isFinite(lat) &&
          Number.isFinite(lon)) {
        map.set(ident, {
          lat,
          lon,
          name: row[idx.name] || ident
        });
      }
    }

    airportDb.map.set("__db",{at:Date.now(),data:map});
    airportDbPromise = null;
    return map;
  })().catch(e=>{
    airportDbPromise = null;
    throw e;
  });

  return airportDbPromise;
}

// ---------- IFATC ----------
function cleanHtml(s) {
  return String(s || "")
    .replace(/<[^>]*>/g," ")
    .replace(/&nbsp;/g," ")
    .replace(/&amp;/g,"&")
    .replace(/&#x27;/g,"'")
    .replace(/\s+/g," ")
    .trim();
}

function parseIfatc(html) {
  const gates = [];
  const trs = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];

  for (const tr of trs) {
    const cells =
      (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [])
        .map(cleanHtml);

    if (cells.length < 3) continue;

    const name = cells[0];
    const type = cells[1];
    const cls = cells[2].toUpperCase().trim();

    if (!name || !/^[ABCDEF]$/.test(cls)) continue;
    if (name.toLowerCase() === "name") continue;

    gates.push({
      rawName:name,
      type,
      category:cls
    });
  }

  return gates;
}

async function loadIfatc(icao) {
  const cached = ifatcCache.get(icao);
  if (cached && Date.now()-cached.at < GATE_TTL_MS) return cached.data;

  const r = await fetch(IFATC_URL(icao), {
    headers: {
      "User-Agent":"VATSIM-Gate-Finder-v7",
      "Accept":"text/html"
    }
  });

  if (!r.ok) throw new Error(`IFATC HTTP ${r.status}`);

  const data = {
    at: Date.now(),
    gates: parseIfatc(await r.text())
  };

  ifatcCache.set(icao,data);
  return data;
}

// ---------- OpenStreetMap exact stand anchors ----------
function makeOsmBboxes(center) {
  // Nine compact tiles cover roughly 4x4 km around the airport reference.
  // Parking positions are local apron features, so we don't need a 5km query.
  const step = 0.012;
  const half = step * 1.5;
  const tiles = [];

  for (let y=-half; y<half; y+=step) {
    for (let x=-half; x<half; x+=step) {
      tiles.push([
        center.lon+x,
        center.lat+y,
        center.lon+x+step,
        center.lat+y+step
      ]);
    }
  }

  return tiles;
}

function parseOsmXml(xml) {
  // Small XML scanner with state. This is intentionally not a regexp over
  // arbitrary chunks; each node's tags are parsed as proper child elements.
  const positions = [];
  const nodeRegex = /<node\b([^>]*)>([\s\S]*?)<\/node>|<node\b([^>]*)\/>/g;
  let match;

  while ((match=nodeRegex.exec(xml))) {
    const attrText = match[1] || match[3] || "";
    const inner = match[2] || "";

    const attrs = {};
    const attrRegex = /(\w+)="([^"]*)"/g;
    let a;
    while ((a=attrRegex.exec(attrText))) attrs[a[1]]=a[2];

    const lat = Number(attrs.lat);
    const lon = Number(attrs.lon);
    if (!attrs.id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const tags = {};
    const tagRegex = /<tag\b([^>]*)\/?>/g;
    let t;
    while ((t=tagRegex.exec(inner))) {
      const ta = {};
      let aa;
      const ar = /(\w+)="([^"]*)"/g;
      while ((aa=ar.exec(t[1]))) ta[aa[1]]=aa[2];
      if (ta.k) tags[ta.k]=ta.v || "";
    }

    const aeroway = String(tags.aeroway || "");
    if (aeroway !== "parking_position" && aeroway !== "gate") continue;

    const ref = tags.ref || tags["stand:ref"] || tags["parking:ref"] || tags.name;
    if (!ref) continue;

    const span = Number.parseFloat(String(
      tags.maxspan || tags.max_wingspan || tags.wingspan || ""
    ).replace(",","." ));

    const category = String(
      tags["aircraft:reference_code"] || tags["aircraft:size"] || ""
    ).toUpperCase();

    positions.push({
      osmId:attrs.id,
      ref:String(ref).trim(),
      lat,
      lon,
      kind:aeroway,
      category:/^[ABCDEF]$/.test(category) ? category : null,
      maxWingspanM:Number.isFinite(span) ? span : null
    });
  }

  return positions;
}

async function fetchOsmTile(bbox) {
  const key=bbox.map(x=>x.toFixed(5)).join(",");

  const cached=osmTileCache.get(key);
  if (cached && Date.now()-cached.at < OSM_TILE_TTL_MS) return cached.data;

  const [minLon,minLat,maxLon,maxLat]=bbox;
  const url=`${OSM_MAP_URL}?bbox=${minLon},${minLat},${maxLon},${maxLat}`;

  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),OSM_TILE_TIMEOUT_MS);

  try {
    const r=await fetch(url,{
      headers:{
        "User-Agent":"VATSIM-Gate-Finder-v7 (https://vatsim-gate-finder.onrender.com)",
        "Accept":"application/xml"
      },
      signal:controller.signal
    });

    if (!r.ok) throw new Error(`OSM HTTP ${r.status}`);

    const data=parseOsmXml(await r.text());

    osmTileCache.set(key,{at:Date.now(),data});
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadOsmPositions(icao) {
  const airports = await loadAirports();
  const center = airports.get(icao);

  if (!center) throw new Error(`Airport ${icao} nicht in OurAirports gefunden.`);

  const tiles=makeOsmBboxes(center);
  const results=await Promise.allSettled(tiles.map(fetchOsmTile));

  const positions=[];
  for (const r of results) {
    if (r.status==="fulfilled") positions.push(...r.value);
  }

  // Deduplicate OSM objects by ref + proximity, but DO NOT merge two distinct
  // positions merely because they share a numeric-looking name.
  const unique=[];

  for (const p of positions) {
    const same=unique.find(x =>
      canonicalGateNames(x.ref).some(ax=>canonicalGateNames(p.ref).includes(ax)) &&
      haversineMeters(x.lat,x.lon,p.lat,p.lon) < 25
    );

    if (!same) unique.push(p);
    else if (same.kind !== "parking_position" && p.kind === "parking_position") {
      Object.assign(same,p);
    }
  }

  return unique;
}

// ---------- Gate/stand model ----------
function choosePhysicalAnchor(ifatcGate, osmPositions) {
  const ifatcNames=canonicalGateNames(ifatcGate.rawName);

  // PRIMARY: exact parking position reference.
  const parking = osmPositions
    .filter(p=>p.kind==="parking_position")
    .filter(p=>canonicalGateNames(p.ref).some(x=>ifatcNames.includes(x)));

  if (parking.length) {
    // If there are several, choose the one whose name has the strongest exact match.
    parking.sort((a,b)=>{
      const sa=normalizeRef(a.ref)===normalizeRef(ifatcGate.rawName)?0:1;
      const sb=normalizeRef(b.ref)===normalizeRef(ifatcGate.rawName)?0:1;
      return sa-sb;
    });

    return {...parking[0], anchorType:"parking_position"};
  }

  // SECONDARY: OSM gate node with matching ref.
  const gates = osmPositions
    .filter(p=>p.kind==="gate")
    .filter(p=>canonicalGateNames(p.ref).some(x=>ifatcNames.includes(x)));

  if (gates.length) {
    return {...gates[0], anchorType:"gate_node"};
  }

  return null;
}

function mergeGateData(ifatcGates, osmPositions) {
  const result=[];
  const usedOsmIds=new Set();

  for (const iGate of ifatcGates) {
    const anchor=choosePhysicalAnchor(iGate,osmPositions);

    const gate={
      name:iGate.rawName,
      displayName:iGate.rawName,
      type:iGate.type,
      category:iGate.category,
      maxWingspanM:null,
      lat:anchor?.lat ?? null,
      lon:anchor?.lon ?? null,
      osmId:anchor?.osmId ?? null,
      anchorType:anchor?.anchorType ?? "none",
      source:anchor ? "IFATC + OSM" : "IFATC"
    };

    if (anchor) {
      usedOsmIds.add(anchor.osmId);
      if (anchor.maxWingspanM) gate.maxWingspanM=anchor.maxWingspanM;
      if (anchor.category) gate.category=anchor.category;
    }

    result.push(gate);
  }

  // Include OSM parking positions which IFATC did not list.
  for (const p of osmPositions) {
    if (p.kind!=="parking_position") continue;
    if (usedOsmIds.has(p.osmId)) continue;

    const known=result.find(g =>
      canonicalGateNames(g.name).some(a=>canonicalGateNames(p.ref).includes(a)) &&
      Number.isFinite(g.lat) &&
      haversineMeters(g.lat,g.lon,p.lat,p.lon)<25
    );

    if (known) continue;

    result.push({
      name:p.ref,
      displayName:p.ref,
      type:"Standplatz",
      category:p.category,
      maxWingspanM:p.maxWingspanM,
      lat:p.lat,
      lon:p.lon,
      osmId:p.osmId,
      anchorType:"parking_position",
      source:"OSM"
    });
  }

  return result;
}

// ---------- VATSIM occupancy ----------
function radiusForGroundspeed(gs) {
  if (gs <= 2) return PARKED_RADIUS_M;
  if (gs <= 8) return SLOW_RADIUS_M;
  return TAXI_RADIUS_M;
}

function assignOccupancy(gates,icao,pilots) {
  const candidates=[];

  for (const pilot of pilots) {
    const fp=pilot.flight_plan||{};
    const dep=String(fp.departure||"").toUpperCase();
    const arr=String(fp.arrival||"").toUpperCase();

    if (dep!==icao && arr!==icao) continue;

    const lat=Number(pilot.latitude);
    const lon=Number(pilot.longitude);
    if (!Number.isFinite(lat)||!Number.isFinite(lon)) continue;

    const gs=Number(pilot.groundspeed||0);
    const radius=radiusForGroundspeed(gs);

    // Exact physical stand anchors only.
    const options=[];

    for (let i=0;i<gates.length;i++) {
      const g=gates[i];
      if (!Number.isFinite(g.lat)||!Number.isFinite(g.lon)) continue;

      // Do not use terminal gate markers for occupancy when a physical stand
      // anchor exists. gate_node is only fallback.
      if (g.anchorType==="none") continue;

      const distance=haversineMeters(g.lat,g.lon,lat,lon);
      if (distance <= radius) {
        options.push({index:i,distance});
      }
    }

    if (!options.length) continue;

    options.sort((a,b)=>a.distance-b.distance);
    const best=options[0];

    // Add an anti-taxi filter. A 100kt aircraft passing the apron should never
    // be a stand occupant.
    if (gs>8 && best.distance>TAXI_RADIUS_M) continue;

    candidates.push({
      pilot,
      gateIndex:best.index,
      distance:best.distance,
      groundspeed:gs
    });
  }

  // One aircraft -> one stand AND one stand -> one aircraft.
  candidates.sort((a,b)=>a.distance-b.distance);

  const usedPilots=new Set();
  const usedGates=new Set();
  const assignments=[];

  for (const c of candidates) {
    const pilotId=String(c.pilot.cid||c.pilot.callsign||"");
    if (usedPilots.has(pilotId)||usedGates.has(c.gateIndex)) continue;

    usedPilots.add(pilotId);
    usedGates.add(c.gateIndex);

    assignments.push({
      gateIndex:c.gateIndex,
      callsign:c.pilot.callsign,
      airline:airlineFromCallsign(c.pilot.callsign),
      aircraft:normalizeAircraft(c.pilot.flight_plan?.aircraft_short||c.pilot.flight_plan?.aircraft||""),
      cid:c.pilot.cid,
      distanceM:Math.round(c.distance),
      groundspeed:c.groundspeed
    });
  }

  return assignments;
}

// ---------- API ----------
async function getVatsimPilots() {
  if (Date.now()-vatsimCache.at<VATSIM_TTL_MS) return vatsimCache.pilots;

  const r=await fetch(VATSIM_URL,{
    headers:{"User-Agent":"VATSIM-Gate-Finder-v7"}
  });

  if (!r.ok) throw new Error(`VATSIM HTTP ${r.status}`);

  const data=await r.json();

  vatsimCache={
    at:Date.now(),
    pilots:Array.isArray(data.pilots)?data.pilots:[]
  };

  return vatsimCache.pilots;
}

function aircraftFitsGate(gate,aircraft) {
  if (!aircraft) return true;

  if (gate.category && aircraft.cat) {
    return "ABCDEF".indexOf(aircraft.cat) <= "ABCDEF".indexOf(gate.category);
  }

  if (gate.maxWingspanM && aircraft.span) {
    return aircraft.span <= gate.maxWingspanM + 0.5;
  }

  return true;
}

app.get("/api/health",(req,res)=>{
  res.json({
    ok:true,
    version:"7.0",
    serverTime:new Date().toISOString(),
    vatsimFeedAgeSeconds:vatsimCache.at?Math.round((Date.now()-vatsimCache.at)/1000):null,
    gateCacheSize:gateCache.size,
    osmTileCacheSize:osmTileCache.size,
    occupancy:{
      parked:PARKED_RADIUS_M,
      slow:SLOW_RADIUS_M,
      taxi:TAXI_RADIUS_M
    }
  });
});

app.get("/api/gates",async(req,res)=>{
  const icao=String(req.query.icao||"").trim().toUpperCase();
  const airlineInput=String(req.query.airline||"").trim();
  const aircraftInput=String(req.query.aircraft||"").trim();

  if (!/^[A-Z0-9]{4}$/.test(icao)) {
    return res.status(400).json({
      error:"Bitte einen gültigen 4-stelligen ICAO-Code eingeben."
    });
  }

  try {
    const cached=gateCache.get(icao);

    let airportData;

    if (cached && Date.now()-cached.at<GATE_TTL_MS) {
      airportData=cached.data;
    } else {
      const [ifatcResult,osmResult]=await Promise.allSettled([
        loadIfatc(icao),
        loadOsmPositions(icao)
      ]);

      const ifatc=ifatcResult.status==="fulfilled"
        ? ifatcResult.value.gates
        : [];

      const osm=osmResult.status==="fulfilled"
        ? osmResult.value
        : [];

      if (!ifatc.length && !osm.length) {
        const ifatcError=ifatcResult.reason?.message || null;
        const osmError=osmResult.reason?.message || null;

        return res.status(502).json({
          error:`Gate-Daten für ${icao} konnten gerade nicht geladen werden.`,
          details:{ifatc:ifatcError,osm:osmError}
        });
      }

      const merged=mergeGateData(ifatc,osm);

      airportData={
        source:ifatc.length&&osm.length
          ?"IFATC + OpenStreetMap"
          :ifatc.length
            ?"IFATC"
            :"OpenStreetMap",
        gates:merged,
        at:new Date().toISOString()
      };

      gateCache.set(icao,{at:Date.now(),data:airportData});
    }

    // VATSIM is intentionally NOT cached with gates. It is live each refresh.
    const pilots=await getVatsimPilots().catch(e=>{
      console.warn("[VATSIM]",e.message);
      return [];
    });

    const requestedAircraft=resolveAircraft(aircraftInput);
    const occupancy=assignOccupancy(airportData.gates,icao,pilots);
    const occupiedByGate=new Map(occupancy.map(o=>[o.gateIndex,o]));

    const output=airportData.gates.map((gate,index)=>{
      const occupant=occupiedByGate.get(index)||null;
      const compatible=aircraftFitsGate(gate,requestedAircraft);

      return {
        ...gate,
        compatible,
        occupied:Boolean(occupant),
        available:compatible&&!occupant,
        status:occupant
          ?"occupied"
          :compatible
            ?"available"
            :"incompatible",
        occupant
      };
    });

    output.sort((a,b)=>{
      const rank=g=>g.status==="available"?0:g.status==="incompatible"?1:2;
      return rank(a)-rank(b) ||
        String(a.name).localeCompare(String(b.name),undefined,{numeric:true});
    });

    res.setHeader("Cache-Control","no-store");

    res.json({
      version:"7.0",
      icao,
      source:airportData.source,
      requestedAirline:airlineInput||null,
      requestedAircraft:aircraftInput||null,
      aircraftInfo:requestedAircraft,
      gateCacheCreatedAt:airportData.at,
      totals:{
        gates:output.length,
        available:output.filter(g=>g.available).length,
        occupied:output.filter(g=>g.occupied).length,
        incompatible:output.filter(g=>!g.compatible).length
      },
      occupancy:{
        parkedRadiusM:PARKED_RADIUS_M,
        slowRadiusM:SLOW_RADIUS_M,
        taxiRadiusM:TAXI_RADIUS_M
      },
      vatsimUpdatedAt:vatsimCache.at
        ? new Date(vatsimCache.at).toISOString()
        : null,
      gates:output
    });
  } catch (error) {
    console.error(error);
    res.status(502).json({
      error:"Gate-Daten konnten gerade nicht abgerufen werden.",
      details:error.name==="AbortError"
        ?"OpenStreetMap API Timeout"
        :error.message
    });
  }
});

app.get("/api/refresh/:icao",async(req,res)=>{
  const icao=String(req.params.icao||"").trim().toUpperCase();
  gateCache.delete(icao);
  ifatcCache.delete(icao);
  res.json({ok:true,icao,cacheCleared:true});
});

app.listen(PORT,"0.0.0.0",()=>{
  console.log(`VATSIM Gate Finder v7 listening on ${PORT}`);
});
