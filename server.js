const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

const DATA_API_URL = "https://data.vatsim.net/v3/vatsim-data.json";
const AIRCRAFT_DB_URL = "https://raw.githubusercontent.com/laegsgaardTroels/whatisflying-db/master/data/aircraft_types.csv";
const AIRLINE_DB_URL = "https://raw.githubusercontent.com/laegsgaardTroels/whatisflying-db/master/data/airlines.csv";
const OVERPASS_PROXY = "https://osm.hpi.de/overpass/api/interpreter";

const VATSIM_TTL = 10_000;
const OSM_TTL = 7 * 24 * 60 * 60 * 1000;
const REF_TTL = 7 * 24 * 60 * 60 * 1000;

const OCCUPANCY_RADIUS_M = Number(process.env.OCCUPANCY_RADIUS_M || 65);
const PARKED_RADIUS_M = Number(process.env.PARKED_RADIUS_M || 70);
const TAXI_RADIUS_M = Number(process.env.TAXI_RADIUS_M || 32);
const OSM_RADIUS_M = Number(process.env.OSM_RADIUS_M || 5000);

const gateCache = new Map();
let vatsimCache = { at: 0, pilots: [] };
let referenceData = {
  at: 0,
  aircraft: new Map(),
  airlines: new Map(),
  airlineAliases: new Map()
};
let referencePromise = null;

// Built-in fallback for the most common VATSIM aircraft. The live/reference DB
// fills in the rest automatically.
const FALLBACK_AIRCRAFT = {
  A318:{icao:"A318",iata:"318",name:"Airbus A318",wingspan:34.1,cat:"C"},
  A319:{icao:"A319",iata:"319",name:"Airbus A319",wingspan:34.1,cat:"C"},
  A320:{icao:"A320",iata:"320",name:"Airbus A320",wingspan:34.1,cat:"C"},
  A20N:{icao:"A20N",iata:"32N",name:"Airbus A320neo",wingspan:35.8,cat:"C"},
  A321:{icao:"A321",iata:"321",name:"Airbus A321",wingspan:35.8,cat:"C"},
  A21N:{icao:"A21N",iata:"32Q",name:"Airbus A321neo",wingspan:35.8,cat:"C"},
  B737:{icao:"B737",iata:"737",name:"Boeing 737",wingspan:35.8,cat:"C"},
  B738:{icao:"B738",iata:"738",name:"Boeing 737-800",wingspan:35.8,cat:"C"},
  B38M:{icao:"B38M",iata:"7M8",name:"Boeing 737 MAX 8",wingspan:35.9,cat:"C"},
  B39M:{icao:"B39M",iata:"7M9",name:"Boeing 737 MAX 9",wingspan:35.9,cat:"C"},
  E170:{icao:"E170",iata:"170",name:"Embraer 170",wingspan:26.0,cat:"C"},
  E175:{icao:"E175",iata:"175",name:"Embraer 175",wingspan:28.7,cat:"C"},
  E190:{icao:"E190",iata:"190",name:"Embraer 190",wingspan:28.7,cat:"C"},
  E195:{icao:"E195",iata:"195",name:"Embraer 195",wingspan:28.7,cat:"C"},
  E290:{icao:"E290",iata:"290",name:"Embraer E190-E2",wingspan:33.7,cat:"C"},
  E295:{icao:"E295",iata:"295",name:"Embraer E195-E2",wingspan:33.7,cat:"C"},
  CRJ7:{icao:"CRJ7",iata:"CR7",name:"CRJ700",wingspan:24.9,cat:"C"},
  CRJ9:{icao:"CRJ9",iata:"CR9",name:"CRJ900",wingspan:26.2,cat:"C"},
  DH8D:{icao:"DH8D",iata:"DH4",name:"De Havilland Dash 8-400",wingspan:28.4,cat:"C"},
  AT72:{icao:"AT72",iata:"AT7",name:"ATR 72",wingspan:27.1,cat:"C"},
  B752:{icao:"B752",iata:"752",name:"Boeing 757-200",wingspan:38.0,cat:"D"},
  B753:{icao:"B753",iata:"75Y",name:"Boeing 757-300",wingspan:38.0,cat:"D"},
  A300:{icao:"A300",iata:"AB6",name:"Airbus A300",wingspan:44.8,cat:"D"},
  A310:{icao:"A310",iata:"310",name:"Airbus A310",wingspan:44.8,cat:"D"},
  A332:{icao:"A332",iata:"332",name:"Airbus A330-200",wingspan:60.3,cat:"E"},
  A333:{icao:"A333",iata:"333",name:"Airbus A330-300",wingspan:60.3,cat:"E"},
  A339:{icao:"A339",iata:"339",name:"Airbus A330-900neo",wingspan:64.0,cat:"E"},
  A359:{icao:"A359",iata:"359",name:"Airbus A350-900",wingspan:64.8,cat:"E"},
  A35K:{icao:"A35K",iata:"351",name:"Airbus A350-1000",wingspan:64.8,cat:"E"},
  B762:{icao:"B762",iata:"762",name:"Boeing 767-200",wingspan:47.6,cat:"E"},
  B763:{icao:"B763",iata:"763",name:"Boeing 767-300",wingspan:51.8,cat:"E"},
  B772:{icao:"B772",iata:"772",name:"Boeing 777-200",wingspan:60.9,cat:"E"},
  B77W:{icao:"B77W",iata:"77W",name:"Boeing 777-300ER",wingspan:64.8,cat:"E"},
  B788:{icao:"B788",iata:"788",name:"Boeing 787-8",wingspan:60.1,cat:"E"},
  B789:{icao:"B789",iata:"789",name:"Boeing 787-9",wingspan:60.1,cat:"E"},
  B78X:{icao:"B78X",iata:"781",name:"Boeing 787-10",wingspan:60.1,cat:"E"},
  B744:{icao:"B744",iata:"744",name:"Boeing 747-400",wingspan:64.4,cat:"E"},
  B748:{icao:"B748",iata:"74H",name:"Boeing 747-8",wingspan:68.4,cat:"F"},
  A388:{icao:"A388",iata:"388",name:"Airbus A380-800",wingspan:79.8,cat:"F"}
};

function makeFallbackReference() {
  const aircraft = new Map();
  for (const v of Object.values(FALLBACK_AIRCRAFT)) {
    aircraft.set(v.icao, v);
    if (v.iata) aircraft.set(v.iata.toUpperCase(), v);
  }

  const airlines = new Map();
  const seeds = [
    ["EWG","EW","Eurowings"],["DLH","LH","Lufthansa"],["RYR","FR","Ryanair"],
    ["WZZ","W6","Wizz Air"],["EZY","U2","easyJet"],["CFG","DE","Condor"],
    ["TUI","X3","TUI fly Deutschland"],["AUA","OS","Austrian Airlines"],
    ["SWR","LX","SWISS"],["KLM","KL","KLM"],["AFR","AF","Air France"],
    ["BAW","BA","British Airways"],["TAP","TP","TAP Air Portugal"],
    ["SAS","SK","SAS"],["LOT","LO","LOT Polish Airlines"],["FIN","AY","Finnair"],
    ["UAE","EK","Emirates"],["QTR","QR","Qatar Airways"],["THY","TK","Turkish Airlines"],
    ["SIA","SQ","Singapore Airlines"],["AAL","AA","American Airlines"],
    ["DAL","DL","Delta Air Lines"],["UAL","UA","United Airlines"],
    ["ACA","AC","Air Canada"]
  ];
  for (const [icao,iata,name] of seeds) {
    const obj={icao,iata,name,callsign:icao};
    airlines.set(icao,obj);
    if (iata) airlines.set(iata,obj);
    airlines.set(name.toUpperCase(),obj);
    airlines.set(icao.toUpperCase(),obj);
  }
  return {aircraft,airlines,airlineAliases:new Map()};
}

function parseCsvLine(line) {
  const out = [];
  let value = "", quoted = false;
  for (let i=0;i<line.length;i++) {
    const ch=line[i];
    if (ch === '"' && line[i+1] === '"' && quoted) { value+='"'; i++; continue; }
    if (ch === '"') { quoted=!quoted; continue; }
    if (ch === ',' && !quoted) { out.push(value); value=""; continue; }
    value += ch;
  }
  out.push(value);
  return out;
}

async function fetchCsv(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "VATSIM-Gate-Finder/Final",
      "Accept": "text/csv,*/*"
    }
  });
  if (!response.ok) throw new Error(`Reference CSV HTTP ${response.status}`);
  return response.text();
}

async function refreshReferenceData(force=false) {
  if (!force && referenceData.at && Date.now()-referenceData.at < REF_TTL) return referenceData;
  if (referencePromise) return referencePromise;

  referencePromise = (async () => {
    const base = makeFallbackReference();

    const [aircraftText, airlineText] = await Promise.all([
      fetchCsv(AIRCRAFT_DB_URL).catch(()=>null),
      fetchCsv(AIRLINE_DB_URL).catch(()=>null)
    ]);

    if (aircraftText) {
      const lines=aircraftText.split(/\r?\n/).filter(Boolean);
      const headers=parseCsvLine(lines.shift());
      const idx=Object.fromEntries(headers.map((h,i)=>[h,i]));

      for (const line of lines) {
        const row=parseCsvLine(line);
        const icao=String(row[idx.icao_code]||"").trim().toUpperCase();
        if (!icao) continue;
        const iata=String(row[idx.iata_code]||"").trim().toUpperCase();
        const name=String(row[idx.name]||icao).trim();
        const manufacturer=String(row[idx.manufacturer]||"").trim();
        const span=Number.parseFloat(row[idx.wingspan]);
        const wtc=String(row[idx.wtc]||"").trim().toUpperCase();
        const cat = codeFromWtcAndSpan(wtc, span);
        const obj={
          icao,
          iata:iata||null,
          name,
          manufacturer,
          wingspan:Number.isFinite(span)?span:null,
          cat
        };
        base.aircraft.set(icao,obj);
        if (iata) base.aircraft.set(iata,obj);
      }
    }

    if (airlineText) {
      const lines=airlineText.split(/\r?\n/).filter(Boolean);
      const headers=parseCsvLine(lines.shift());
      const idx=Object.fromEntries(headers.map((h,i)=>[h,i]));

      for (const line of lines) {
        const row=parseCsvLine(line);
        const icao=String(row[idx.icao_code]||"").trim().toUpperCase();
        if (!icao) continue;
        const iata=String(row[idx.iata_code]||"").trim().toUpperCase();
        const name=String(row[idx.name]||icao).trim();
        const callsign=String(row[idx.callsign]||"").trim().toUpperCase();

        const obj={icao,iata:iata||null,name,callsign:callsign||null};
        base.airlines.set(icao,obj);
        if (iata) base.airlines.set(iata,obj);
        if (callsign) base.airlines.set(callsign,obj);
        base.airlines.set(name.toUpperCase(),obj);
      }
    }

    referenceData={...base,at:Date.now()};
    return referenceData;
  })().finally(()=>{ referencePromise=null; });

  return referencePromise;
}

function codeFromWtcAndSpan(wtc, span) {
  // Gate/stand compatibility is governed by aircraft size, so use the
  // Aerodrome Reference Code as the display model. WTC alone is not enough.
  if (!Number.isFinite(span)) {
    if (wtc === "J" || wtc === "H") return "E";
    if (wtc === "M") return "C";
    return "";
  }
  if (span < 15) return "A";
  if (span < 24) return "B";
  if (span < 36) return "C";
  if (span < 52) return "D";
  if (span < 65) return "E";
  return "F";
}

function normalizeAircraftInput(input, refs) {
  let value=String(input||"").trim().toUpperCase();
  if (!value) return null;

  // VATSIM may provide "A320/H-SDE3..." in flight_plan.aircraft.
  value=value.split("/")[0].trim();

  if (refs.aircraft.has(value)) return refs.aircraft.get(value);

  // Try to normalize user-entered names / dashes.
  const compact=value.replace(/[\s_-]/g,"");
  if (refs.aircraft.has(compact)) return refs.aircraft.get(compact);

  // Prefix/family fallbacks for common simulator aliases.
  const families=[
    [/^A320NEO|^A20N/, "A20N"],
    [/^A321NEO|^A21N/, "A21N"],
    [/^A319NEO|^A19N/, "A19N"],
    [/^A320/, "A320"],
    [/^A321/, "A321"],
    [/^A319/, "A319"],
    [/^B737MAX8|^B38M/, "B38M"],
    [/^B737MAX9|^B39M/, "B39M"],
    [/^B737/, "B737"]
  ];
  for (const [rx,key] of families) {
    if (rx.test(value) && refs.aircraft.has(key)) return refs.aircraft.get(key);
  }

  return {
    icao:value,
    iata:null,
    name:"Unbekannter ICAO-Typ",
    manufacturer:"",
    wingspan:null,
    cat:""
  };
}

function resolveAirlineInput(input, refs) {
  const s=String(input||"").trim().toUpperCase();
  if (!s) return null;
  if (refs.airlines.has(s)) return refs.airlines.get(s);

  // Search by startsWith / contains so "lufthansa" and "LUFTHANSA"
  // work even when the exact source spelling differs.
  const seen=new Set();
  for (const obj of refs.airlines.values()) {
    if (!obj || seen.has(obj.icao)) continue;
    seen.add(obj.icao);
    if (
      obj.icao===s ||
      obj.iata===s ||
      obj.callsign===s ||
      obj.name.toUpperCase()===s ||
      obj.name.toUpperCase().includes(s)
    ) return obj;
  }
  return {icao:s,iata:null,name:s,callsign:null};
}

function normalizeGateName(name) {
  return String(name||"")
    .toUpperCase()
    .replace(/^GATE\s+/,"")
    .replace(/\s+/g,"")
    .replace(/[–—]/g,"-");
}

function normalizeAirlineList(list) {
  if (!Array.isArray(list)) return [];
  return list.flatMap(x => String(x).split(/[;,|]/))
    .map(x=>x.trim().toUpperCase())
    .filter(Boolean);
}

function loadCuratedGates() {
  const file=path.join(__dirname,"gates.json");
  if (!fs.existsSync(file)) return {airports:{},aircraftCategories:{}};

  try {
    const data=JSON.parse(fs.readFileSync(file,"utf8"));
    return data && data.airports ? data : {airports:{},aircraftCategories:{}};
  } catch (err) {
    console.warn("[gates.json] invalid JSON:",err.message);
    return {airports:{},aircraftCategories:{}};
  }
}

function curatedAirport(icao) {
  const data=loadCuratedGates();
  const entries=Array.isArray(data.airports?.[icao]) ? data.airports[icao] : [];
  return entries.map((g,i)=>({
    id:`curated:${icao}:${i}`,
    name:String(g.name || g.ref || `Stand ${i+1}`),
    type:"Gate",
    lat:Number(g.lat),
    lon:Number(g.lon),
    category:String(g.category||g.maxcat||"").toUpperCase() || null,
    maxWingspanM:Number.isFinite(Number(g.maxspan))?Number(g.maxspan):null,
    airlines:normalizeAirlineList(g.airlines || g.airline),
    source:"curated"
  })).filter(g=>Number.isFinite(g.lat)&&Number.isFinite(g.lon));
}

async function fetchOsmGates(icao) {
  const query=`
[out:json][timeout:25];
area["aeroway"="aerodrome"]["icao"="${icao}"]->.apt;
(
  node["aeroway"="parking_position"](area.apt);
  node["aeroway"="gate"](area.apt);
);
out body;
`;

  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),8500);

  try {
    const response=await fetch(
      OVERPASS_PROXY+"?data="+encodeURIComponent(query),
      {
        headers:{
          "User-Agent":"VATSIM-Gate-Finder/Final",
          "Accept":"application/json"
        },
        signal:controller.signal
      }
    );
    if (!response.ok) throw new Error(`OSM HTTP ${response.status}`);
    const data=await response.json();

    const raw=(data.elements||[]).map((el)=>{
      const tags=el.tags||{};
      const name=tags.ref||tags.name||tags["stand:ref"]||tags["parking:ref"];
      if (el.type!=="node" || !name) return null;

      const span=Number.parseFloat(String(
        tags.maxspan||tags.max_wingspan||tags.wingspan||""
      ).replace(",","."));

      const category=String(
        tags["aircraft:reference_code"]||tags["aircraft:size"]||tags.code||""
      ).toUpperCase();

      return {
        id:`osm:${el.id}`,
        name:String(name),
        type:tags.aeroway==="gate"?"Gate":"Standplatz",
        lat:Number(el.lat),
        lon:Number(el.lon),
        category:/^[ABCDEF]$/.test(category)?category:null,
        maxWingspanM:Number.isFinite(span)?span:null,
        airlines:normalizeAirlineList(tags.airline||tags.operator||tags.operators),
        source:"osm"
      };
    }).filter(Boolean);

    const unique=[];
    for (const gate of raw) {
      const same=unique.find(g =>
        normalizeGateName(g.name)===normalizeGateName(gate.name) &&
        haversine(g.lat,g.lon,gate.lat,gate.lon)<35
      );
      if (!same) unique.push(gate);
    }
    return unique.sort((a,b)=>compareGateNames(a.name,b.name));
  } finally {
    clearTimeout(timeout);
  }
}

function compareGateNames(a,b) {
  const aa=String(a).match(/^([A-Z]+)?\s*(\d+)/i);
  const bb=String(b).match(/^([A-Z]+)?\s*(\d+)/i);
  if (aa && bb) {
    const pa=(aa[1]||"").toUpperCase(), pb=(bb[1]||"").toUpperCase();
    if (pa!==pb) return pa.localeCompare(pb);
    const na=Number(aa[2]), nb=Number(bb[2]);
    if (na!==nb) return na-nb;
  }
  return String(a).localeCompare(String(b),undefined,{numeric:true,sensitivity:"base"});
}

function haversine(lat1,lon1,lat2,lon2) {
  const R=6371000, rad=x=>x*Math.PI/180;
  const dLat=rad(lat2-lat1), dLon=rad(lon2-lon1);
  const a=Math.sin(dLat/2)**2+
    Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

async function getAirportGates(icao) {
  const cached=gateCache.get(icao);
  if (cached && Date.now()-cached.at<OSM_TTL) return cached.data;

  const curated=curatedAirport(icao);
  if (curated.length) {
    const data={
      icao,
      source:"curated",
      gates:dedupeFinalGates(curated),
      cachedAt:new Date().toISOString()
    };
    gateCache.set(icao,{at:Date.now(),data});
    return data;
  }

  const osm=await fetchOsmGates(icao);
  const data={
    icao,
    source:"osm",
    gates:dedupeFinalGates(osm),
    cachedAt:new Date().toISOString()
  };
  gateCache.set(icao,{at:Date.now(),data});
  return data;
}

function dedupeFinalGates(gates) {
  const output=[];
  for (const gate of gates) {
    const key=normalizeGateName(gate.name);
    const same=output.find(g => normalizeGateName(g.name)===key);
    if (!same) {
      output.push(gate);
      continue;
    }

    // Prefer curated data, then Gate over Standplatz, then more complete data.
    if (same.source!=="curated" && gate.source==="curated") {
      Object.assign(same,gate);
    } else if (same.type!=="Gate" && gate.type==="Gate") {
      Object.assign(same,gate);
    } else {
      if (!same.category && gate.category) same.category=gate.category;
      if (!same.maxWingspanM && gate.maxWingspanM) same.maxWingspanM=gate.maxWingspanM;
      if (!same.airlines.length && gate.airlines.length) same.airlines=gate.airlines;
    }
  }
  return output.sort((a,b)=>compareGateNames(a.name,b.name));
}

async function getVatsimPilots() {
  if (Date.now()-vatsimCache.at<VATSIM_TTL) return vatsimCache.pilots;

  const response=await fetch(DATA_API_URL,{
    headers:{
      "User-Agent":"VATSIM-Gate-Finder/Final",
      "Accept":"application/json"
    }
  });
  if (!response.ok) throw new Error(`VATSIM HTTP ${response.status}`);
  const data=await response.json();

  vatsimCache={
    at:Date.now(),
    pilots:Array.isArray(data.pilots)?data.pilots:[]
  };
  return vatsimCache.pilots;
}

function pilotAircraft(pilot, refs) {
  const fp=pilot.flight_plan||{};
  return normalizeAircraftInput(fp.aircraft_short||fp.aircraft||"",refs);
}

function pilotAirline(pilot, refs) {
  const callsign=String(pilot.callsign||"").toUpperCase().trim();
  const prefix=(callsign.match(/^[A-Z]{3}/)||[""])[0];

  if (prefix) {
    const obj=refs.airlines.get(prefix);
    if (obj) return obj;
  }

  return {
    icao:prefix||null,
    iata:null,
    name:prefix||"Unbekannt",
    callsign:null
  };
}

function pilotAirportRelevance(pilot,icao) {
  const fp=pilot.flight_plan||{};
  const dep=String(fp.departure||"").toUpperCase();
  const arr=String(fp.arrival||"").toUpperCase();
  if (dep===icao || arr===icao) return 3;
  return 0;
}

function occupancyRadiusForPilot(pilot) {
  const gs=Number(pilot.groundspeed||0);
  if (gs<=3) return PARKED_RADIUS_M;
  if (gs<=12) return OCCUPANCY_RADIUS_M;
  return TAXI_RADIUS_M;
}

function assignOccupancy(gates,icao,pilots,refs) {
  const candidates=[];

  for (const pilot of pilots) {
    if (!pilot || !pilot.flight_plan) continue;

    const relevance=pilotAirportRelevance(pilot,icao);
    if (!relevance) continue;

    const lat=Number(pilot.latitude), lon=Number(pilot.longitude);
    if (!Number.isFinite(lat)||!Number.isFinite(lon)) continue;

    const radius=occupancyRadiusForPilot(pilot);
    const distances=[];

    for (let i=0;i<gates.length;i++) {
      const g=gates[i];
      const d=haversine(g.lat,g.lon,lat,lon);
      if (d<=radius) {
        distances.push({gateIndex:i,distance:d});
      }
    }

    distances.sort((a,b)=>a.distance-b.distance);
    if (!distances.length) continue;

    // At higher taxi speeds require the aircraft to be very close to a stand.
    const best=distances[0];
    const gs=Number(pilot.groundspeed||0);
    if (gs>12 && best.distance>TAXI_RADIUS_M) continue;

    candidates.push({
      pilot,
      gateIndex:best.gateIndex,
      distance:best.distance,
      gs,
      aircraft:pilotAircraft(pilot,refs),
      airline:pilotAirline(pilot,refs)
    });
  }

  // Stable one-to-one assignment:
  // shortest physical distance first, each aircraft and each gate only once.
  candidates.sort((a,b)=>a.distance-b.distance);

  const usedPilots=new Set();
  const usedGates=new Set();
  const result=[];

  for (const c of candidates) {
    const pid=String(c.pilot.cid||c.pilot.callsign||"");
    if (usedPilots.has(pid)||usedGates.has(c.gateIndex)) continue;
    usedPilots.add(pid);
    usedGates.add(c.gateIndex);

    result.push({
      gateIndex:c.gateIndex,
      callsign:c.pilot.callsign,
      cid:c.pilot.cid,
      distanceM:Math.round(c.distance),
      groundspeed:c.gs,
      aircraft:c.aircraft,
      airline:c.airline
    });
  }

  return result;
}

function gateAirlineMatch(gate, requestedAirline) {
  if (!requestedAirline) return true;
  if (!gate.airlines?.length) return true;

  const requested=[
    requestedAirline.icao,
    requestedAirline.iata,
    requestedAirline.name,
    requestedAirline.callsign
  ].filter(Boolean).map(x=>String(x).toUpperCase());

  return gate.airlines.some(value => {
    const v=String(value).toUpperCase();
    return requested.some(r=>v===r || v.includes(r) || r.includes(v));
  });
}

function gateAircraftMatch(gate, requestedAircraft) {
  if (!requestedAircraft || (!gate.category&&!gate.maxWingspanM)) return true;

  if (gate.category && requestedAircraft.cat) {
    return "ABCDEF".indexOf(requestedAircraft.cat) <=
      "ABCDEF".indexOf(gate.category);
  }

  if (gate.maxWingspanM && requestedAircraft.wingspan) {
    return requestedAircraft.wingspan <= gate.maxWingspanM + 0.5;
  }

  return true;
}

app.get("/api/health",(req,res)=>{
  res.json({
    ok:true,
    version:"FINAL",
    serverTime:new Date().toISOString(),
    vatsimFeedAgeSeconds:vatsimCache.at?Math.round((Date.now()-vatsimCache.at)/1000):null,
    cachedAirports:gateCache.size,
    referenceDataAgeDays:referenceData.at?
      Number(((Date.now()-referenceData.at)/86400000).toFixed(2)):null,
    dataSources:{
      vatsim:"VATSIM Data API v3",
      aircraft:"What is flying? aircraft_types.csv",
      airlines:"What is flying? airlines.csv",
      curatedGates:"gates.json (when airport exists)",
      fallbackGates:"OpenStreetMap via HPI Overpass proxy"
    }
  });
});

app.get("/api/refresh",(req,res)=>{
  // Lightweight manual cache refresh for admins/development.
  gateCache.clear();
  referenceData.at=0;
  res.json({ok:true,message:"Caches cleared."});
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
    // Reference data fetch runs in the background on cold start. Await only
    // if it is already available or easy to load.
    const refs=referenceData.at ? referenceData : makeFallbackReference();
    if (!referenceData.at) refreshReferenceData().catch(()=>{});

    const requestedAirline=resolveAirlineInput(airlineInput,refs);
    const requestedAircraft=normalizeAircraftInput(aircraftInput,refs);

    const [airportData,pilots]=await Promise.all([
      getAirportGates(icao),
      getVatsimPilots().catch(err=>{
        console.warn("[VATSIM]",err.message);
        return [];
      })
    ]);

    if (!airportData.gates.length) {
      return res.status(404).json({
        error:`Keine Gate-/Stand-Daten für ${icao} gefunden.`,
        source:airportData.source
      });
    }

    const occupancy=assignOccupancy(airportData.gates,icao,pilots,refs);
    const byGate=new Map(occupancy.map(x=>[x.gateIndex,x]));

    const result=airportData.gates.map((gate,index)=>{
      const occupant=byGate.get(index)||null;
      const airlineOK=gateAirlineMatch(gate,requestedAirline);
      const aircraftOK=gateAircraftMatch(gate,requestedAircraft);

      return {
        ...gate,
        displayName:gate.name,
        gateAirlines:gate.airlines||[],
        requestedAirline:requestedAirline?{
          icao:requestedAirline.icao||null,
          iata:requestedAirline.iata||null,
          name:requestedAirline.name||null
        }:null,
        requestedAircraft:requestedAircraft?{
          icao:requestedAircraft.icao||null,
          iata:requestedAircraft.iata||null,
          name:requestedAircraft.name||null,
          wingspan:requestedAircraft.wingspan||null,
          category:requestedAircraft.cat||null
        }:null,
        compatible:Boolean(airlineOK&&aircraftOK),
        occupied:Boolean(occupant),
        available:Boolean(airlineOK&&aircraftOK&&!occupant),
        status:occupant?"occupied":(airlineOK&&aircraftOK?"available":"incompatible"),
        occupant:occupant?{
          callsign:occupant.callsign,
          airline:occupant.airline,
          aircraft:occupant.aircraft,
          distanceM:occupant.distanceM,
          groundspeed:occupant.groundspeed
        }:null
      };
    });

    result.sort((a,b)=>{
      const rank=x=>x.status==="available"?0:(x.status==="incompatible"?1:2);
      return rank(a)-rank(b)||compareGateNames(a.name,b.name);
    });

    res.setHeader("Cache-Control","no-store");
    res.json({
      version:"FINAL",
      icao,
      dataSource:airportData.source,
      cachedAt:airportData.cachedAt,
      requestedAirline:requestedAirline?{
        input:airlineInput,
        icao:requestedAirline.icao,
        iata:requestedAirline.iata,
        name:requestedAirline.name
      }:null,
      requestedAircraft:requestedAircraft?{
        input:aircraftInput,
        icao:requestedAircraft.icao,
        iata:requestedAircraft.iata,
        name:requestedAircraft.name,
        manufacturer:requestedAircraft.manufacturer||null,
        wingspanM:requestedAircraft.wingspan||null,
        category:requestedAircraft.cat||null
      }:null,
      totals:{
        gates:result.length,
        available:result.filter(g=>g.available).length,
        occupied:result.filter(g=>g.occupied).length,
        incompatible:result.filter(g=>!g.compatible).length,
        assignedAircraft:occupancy.length
      },
      occupancy:{
        parkedRadiusM:PARKED_RADIUS_M,
        normalRadiusM:OCCUPANCY_RADIUS_M,
        taxiRadiusM:TAXI_RADIUS_M
      },
      vatsimUpdatedAt:vatsimCache.at?new Date(vatsimCache.at).toISOString():null,
      gates:result
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({
      error:"Gate-Daten konnten gerade nicht abgerufen werden.",
      details:err.name==="AbortError"?"OSM-Abfrage Timeout":err.message
    });
  }
});

// Start background reference-data refresh so the first user does not need
// to wait on the large CSV files.
refreshReferenceData().catch(err=>console.warn("[Reference data]",err.message));

app.listen(PORT,"0.0.0.0",()=>{
  console.log(`VATSIM Gate Finder FINAL läuft auf Port ${PORT}`);
});
