const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.static(__dirname));
app.use(express.json());

const VATSIM_URL = "https://data.vatsim.net/v3/vatsim-data.json";
const OURAIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const IFATC_URL = (icao) => `https://www.ifatc.org/gates?code=${encodeURIComponent(icao)}`;
const OSM_MAP_URL = "https://api.openstreetmap.org/api/0.6/map";

const VATSIM_TTL = 12_000;
const AIRPORT_TTL = 24 * 60 * 60 * 1000;
const GATE_TTL = 7 * 24 * 60 * 60 * 1000;

const gateCache = new Map();
const airportCache = new Map();
const ifatcCache = new Map();
let vatsimCache = { at: 0, pilots: [] };
let airportsPromise = null;

const OCCUPANCY_PARKED_M = Number(process.env.OCCUPANCY_PARKED_M || 70);
const OCCUPANCY_SLOW_M = Number(process.env.OCCUPANCY_SLOW_M || 55);
const OCCUPANCY_TAXI_M = Number(process.env.OCCUPANCY_TAXI_M || 28);

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
  "744":"B744","74H":"B748","380":"A388","388":"A388"
};

const AIRLINE_ALIASES = {
  EWG:["EWG","EW","EUROWINGS"], DLH:["DLH","LH","LUFTHANSA"], RYR:["RYR","FR","RYANAIR"],
  WZZ:["WZZ","W6","WIZZAIR"], EZY:["EZY","U2","EASYJET"], CFG:["CFG","DE","CONDOR"],
  TUI:["TUI","X3","TUIFLY"], AUA:["AUA","OS","AUSTRIAN"], SWR:["SWR","LX","SWISS"],
  KLM:["KLM","KL"], AFR:["AFR","AF","AIRFRANCE"], BAW:["BAW","BA","BRITISH AIRWAYS"],
  TAP:["TAP","TP","TAP AIR PORTUGAL"], SAS:["SAS","SK"], LOT:["LOT","LO"],
  FIN:["FIN","AY"], UAE:["UAE","EK"], QTR:["QTR","QR"], SIA:["SIA","SQ"],
  THY:["THY","TK"], ACA:["ACA","AC"], DAL:["DAL","DL"], UAL:["UAL","UA"], AAL:["AAL","AA"]
};

const IFATC_CLASS_TO_CODE = { A:15, B:24, C:36, D:52, E:65, F:80 };

function normalizeAircraft(v) {
  return String(v || "").split("/")[0].trim().toUpperCase();
}

function getAircraft(v) {
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
  const R=6371000, rad=x=>x*Math.PI/180;
  const dLat=rad(lat2-lat1), dLon=rad(lon2-lon1);
  const a=Math.sin(dLat/2)**2 + Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

function parseCsvRows(csv) {
  const rows=[]; let row=[], cell="", quoted=false;
  for(let i=0;i<csv.length;i++){
    const ch=csv[i];
    if(ch==='"' && csv[i+1]==='"' && quoted){cell+='"';i++;continue}
    if(ch==='"'){quoted=!quoted;continue}
    if(ch===',' && !quoted){row.push(cell);cell="";continue}
    if((ch==='\n'||ch==='\r')&&!quoted){
      if(ch==='\r'&&csv[i+1]==='\n')i++;
      row.push(cell);rows.push(row);row=[];cell="";continue;
    }
    cell+=ch;
  }
  if(cell||row.length){row.push(cell);rows.push(row)}
  return rows;
}

async function loadAirports(){
  if(airportCache.size && airportCache.get("__db")?.at && Date.now()-airportCache.get("__db").at<AIRPORT_TTL){
    return airportCache.get("__db").data;
  }
  if(airportsPromise) return airportsPromise;

  airportsPromise=(async()=>{
    const r=await fetch(OURAIRPORTS_URL,{headers:{"User-Agent":"VATSIM-Gate-Finder-Stable/6.0"}});
    if(!r.ok)throw new Error(`OurAirports HTTP ${r.status}`);
    const rows=parseCsvRows(await r.text());
    const header=rows.shift();
    const idx=Object.fromEntries(header.map((x,i)=>[x,i]));
    const map=new Map();
    for(const row of rows){
      const ident=String(row[idx.ident]||"").trim().toUpperCase();
      const lat=Number(row[idx.latitude_deg]), lon=Number(row[idx.longitude_deg]);
      if(/^[A-Z0-9]{4}$/.test(ident)&&Number.isFinite(lat)&&Number.isFinite(lon)){
        map.set(ident,{lat,lon,name:row[idx.name]||ident});
      }
    }
    airportCache.set("__db",{at:Date.now(),data:map});
    airportsPromise=null;
    return map;
  })().catch(e=>{airportsPromise=null;throw e});

  return airportsPromise;
}

function parseIfatc(html) {
  // The page is rendered as a simple HTML table. The web source exposes rows:
  // Name | Type | Class. We only consume data, never copy page styling.
  const rows=[];
  const clean=s=>s.replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/\s+/g," ").trim();
  const trMatches=html.match(/<tr[\s\S]*?<\/tr>/gi)||[];

  for(const tr of trMatches){
    const cells=(tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi)||[]).map(clean);
    if(cells.length<3)continue;
    const name=cells[0], type=cells[1], cls=cells[2].toUpperCase();
    if(!name||!["A","B","C","D","E","F"].includes(cls))continue;
    if(name.toLowerCase().includes("name") && type.toLowerCase().includes("type"))continue;
    rows.push({rawName:name,type,class:cls,maxSpanM:IFATC_CLASS_TO_CODE[cls]});
  }

  return rows;
}

function canonicalGateRef(name){
  let s=String(name||"").toUpperCase();
  s=s.replace(/\b(APRON|TERMINAL|REMOTE|STAND|GATE|CARGO|AIRLINE|GA|MILITARY|NONE|INT\.?|DOM\.?)\b/g," ");
  const matches=s.match(/[A-Z]?\d{1,3}[A-Z]?/g)||[];
  if(!matches.length)return s.replace(/\s+/g,"").slice(-12);
  // Prefer the final stand-like token, e.g. "Terminal 1 Gate C10" -> C10.
  return matches[matches.length-1].replace(/\s+/g,"");
}

function normalizeGateRef(v){
  return String(v||"").toUpperCase().replace(/[\s_-]/g,"");
}

async function loadIfatc(icao){
  const cached=ifatcCache.get(icao);
  if(cached&&Date.now()-cached.at<GATE_TTL)return cached.data;

  const r=await fetch(IFATC_URL(icao),{
    headers:{"User-Agent":"VATSIM-Gate-Finder-Stable/6.0","Accept":"text/html"}
  });
  if(!r.ok)throw new Error(`IFATC HTTP ${r.status}`);

  const data={updatedAt:new Date().toISOString(),gates:parseIfatc(await r.text())};
  ifatcCache.set(icao,{at:Date.now(),data});
  return data;
}

// OSM's standard /api/0.6/map endpoint does not require Overpass.
// We query small tiles around the airport and only retain gate/parking nodes.
async function fetchOsmTile(bbox){
  const [minLon,minLat,maxLon,maxLat]=bbox;
  const url=`${OSM_MAP_URL}?bbox=${minLon},${minLat},${maxLon},${maxLat}`;
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),5000);

  try{
    const r=await fetch(url,{
      headers:{
        "User-Agent":"VATSIM-Gate-Finder-Stable/6.0 (https://vatsim-gate-finder.onrender.com)",
        "Accept":"application/xml"
      },
      signal:controller.signal
    });
    if(!r.ok)throw new Error(`OSM map HTTP ${r.status}`);
    const xml=await r.text();

    const nodes=new Map();
    const nodeRegex=/<node\b([^>]*?)\/?>/g;
    let match;
    while((match=nodeRegex.exec(xml))){
      const attrs={};
      const attrRegex=/(\w+)="([^"]*)"/g;
      let a;
      while((a=attrRegex.exec(match[1])))attrs[a[1]]=a[2];
      if(!attrs.id||!attrs.lat||!attrs.lon)continue;

      const elementEnd=xml.slice(nodeRegex.lastIndex, nodeRegex.lastIndex+2500);
      const nodeBlock=xml.slice(Math.max(0,nodeRegex.lastIndex-100),Math.min(xml.length,nodeRegex.lastIndex+2500));
      const isParking=/k="aeroway"\s+v="parking_position"/.test(nodeBlock);
      const isGate=/k="aeroway"\s+v="gate"/.test(nodeBlock);
      if(!isParking&&!isGate)continue;

      const ref=nodeBlock.match(/<tag\b[^>]*k="(?:ref|stand:ref|parking:ref)"[^>]*v="([^"]+)"/i)?.[1]||null;
      const name=nodeBlock.match(/<tag\b[^>]*k="name"[^>]*v="([^"]+)"/i)?.[1]||null;
      const span=nodeBlock.match(/<tag\b[^>]*k="(?:maxspan|max_wingspan|wingspan)"[^>]*v="([^"]+)"/i)?.[1]||null;
      const cat=nodeBlock.match(/<tag\b[^>]*k="(?:aircraft:reference_code|aircraft:size)"[^>]*v="([^"]+)"/i)?.[1]||null;
      const label=ref||name;
      if(!label)continue;

      nodes.set(attrs.id,{
        osmId:attrs.id,
        ref:label,
        lat:Number(attrs.lat),
        lon:Number(attrs.lon),
        type:isGate?"Gate":"Standplatz",
        maxSpanM:Number.parseFloat(String(span||"").replace(",","."))||null,
        category:["A","B","C","D","E","F"].includes(String(cat||"").toUpperCase())?String(cat).toUpperCase():null
      });
    }
    return [...nodes.values()];
  }finally{
    clearTimeout(timeout);
  }
}

function makeTiles(center){
  // 3 x 3 km-ish coverage around the ARP using nine small OSM API requests.
  // Render only needs a handful of tiles; results are cached for 7 days.
  const step=0.012;
  const half=0.018;
  const tiles=[];
  for(let dy=-half;dy<half;dy+=step){
    for(let dx=-half;dx<half;dx+=step){
      const minLon=center.lon+dx, minLat=center.lat+dy;
      tiles.push([minLon,minLat,minLon+step,minLat+step]);
    }
  }
  return tiles;
}

async function loadOsmPositions(icao){
  const airports=await loadAirports();
  const center=airports.get(icao);
  if(!center)throw new Error(`Airport ${icao} nicht in OurAirports gefunden.`);

  const tiles=makeTiles(center);
  const results=await Promise.allSettled(tiles.map(fetchOsmTile));
  const positions=results.flatMap(r=>r.status==="fulfilled"?r.value:[]);
  const unique=new Map();

  for(const p of positions){
    const key=normalizeGateRef(p.ref);
    if(!key)continue;
    const existing=unique.get(key);
    if(!existing||(!existing.category&&p.category)||(!existing.maxSpanM&&p.maxSpanM)){
      unique.set(key,p);
    }
  }
  return [...unique.values()];
}

function mergeIfatcAndOsm(ifatc,osm){
  const result=[];
  const byRef=new Map();

  for(const p of osm){
    const key=normalizeGateRef(p.ref);
    if(key)byRef.set(key,p);
  }

  for(const g of ifatc.gates){
    const key=normalizeGateRef(canonicalGateRef(g.rawName));
    const p=byRef.get(key)||null;

    // Only show items that are actually gate/stand-like. IFATC includes hangars,
    // military pads, etc.; keep Airline + GA + Cargo entries, plus unnamed
    // parking positions discovered by OSM only as fallback.
    const usefulType=/airline|cargo|ga/i.test(g.type)||/stand|gate|apron/i.test(g.rawName);
    if(!usefulType)continue;

    result.push({
      name:canonicalGateRef(g.rawName),
      displayName:g.rawName,
      type:g.type,
      category:g.class,
      maxWingspanM:g.maxSpanM,
      lat:p?.lat??null,
      lon:p?.lon??null,
      osmId:p?.osmId??null,
      source:p?"IFATC + OSM":"IFATC"
    });
  }

  // Add OSM stands that IFATC did not know about.
  const seen=new Set(result.map(x=>normalizeGateRef(x.name)));
  for(const p of osm){
    const key=normalizeGateRef(p.ref);
    if(!key||seen.has(key))continue;
    result.push({
      name:p.ref,
      displayName:p.ref,
      type:p.type,
      category:p.category,
      maxWingspanM:p.maxSpanM,
      lat:p.lat,lon:p.lon,osmId:p.osmId,
      source:"OSM"
    });
    seen.add(key);
  }

  result.sort((a,b)=>String(a.name).localeCompare(String(b.name),undefined,{numeric:true,sensitivity:"base"}));
  return result;
}

function occupancyRadius(gs){
  if(gs<=3)return OCCUPANCY_PARKED_M;
  if(gs<=12)return OCCUPANCY_SLOW_M;
  return OCCUPANCY_TAXI_M;
}

function assignOccupancy(gates,icao,pilots){
  const candidates=[];
  for(const p of pilots){
    const fp=p.flight_plan||{};
    const dep=String(fp.departure||"").toUpperCase();
    const arr=String(fp.arrival||"").toUpperCase();
    if(dep!==icao&&arr!==icao)continue;

    const lat=Number(p.latitude),lon=Number(p.longitude);
    if(!Number.isFinite(lat)||!Number.isFinite(lon))continue;

    const gs=Number(p.groundspeed||0);
    const radius=occupancyRadius(gs);
    let best=null;

    for(let i=0;i<gates.length;i++){
      const g=gates[i];
      if(!Number.isFinite(g.lat)||!Number.isFinite(g.lon))continue;
      const d=haversineMeters(g.lat,g.lon,lat,lon);
      if(d<=radius&&(!best||d<best.distance))best={i,d};
    }
    if(!best)continue;

    candidates.push({pilot:p,i:best.i,d:best.d,gs});
  }

  candidates.sort((a,b)=>a.d-b.d);
  const usedGates=new Set(),usedPilots=new Set(),out=[];

  for(const c of candidates){
    const id=String(c.pilot.cid||c.pilot.callsign||"");
    if(usedGates.has(c.i)||usedPilots.has(id))continue;
    usedGates.add(c.i);usedPilots.add(id);

    const callsign=String(c.pilot.callsign||"").toUpperCase();
    const airline=airlineFromCallsign(callsign);
    const aircraft=normalizeAircraft(c.pilot.flight_plan?.aircraft_short||c.pilot.flight_plan?.aircraft||"");

    out.push({
      gateIndex:c.i,
      callsign:c.pilot.callsign,
      airline,
      aircraft,
      cid:c.pilot.cid,
      distanceM:Math.round(c.d),
      groundspeed:c.gs
    });
  }
  return out;
}

async function getVatsim(){
  if(Date.now()-vatsimCache.at<VATSIM_TTL)return vatsimCache.pilots;
  const r=await fetch(VATSIM_URL,{headers:{"User-Agent":"VATSIM-Gate-Finder-Stable/6.0"}});
  if(!r.ok)throw new Error(`VATSIM HTTP ${r.status}`);
  const d=await r.json();
  vatsimCache={at:Date.now(),pilots:Array.isArray(d.pilots)?d.pilots:[]};
  return vatsimCache.pilots;
}

function gateMatchesAircraft(g,ac){
  if(!ac)return true;
  if(!g.category)return true;
  return "ABCDEF".indexOf(ac.cat||"F")<="ABCDEF".indexOf(g.category);
}

function gateMatchesAirline(g,requested){
  // IFATC provides gate class/type but not a universal per-airline restriction.
  // Therefore do not invent a restriction. Airline is used as the user context
  // and live occupancy metadata; it is not a false hard filter.
  return !!requested;
}

app.get("/api/health",(req,res)=>{
  res.json({
    ok:true,
    version:"STABLE-6",
    serverTime:new Date().toISOString(),
    vatsimFeedAgeSeconds:vatsimCache.at?Math.round((Date.now()-vatsimCache.at)/1000):null,
    cachedAirports:gateCache.size,
    sources:{
      gates:"IFATC + OpenStreetMap API",
      occupancy:"VATSIM Data API v3",
      aircraft:"built-in ICAO/IATA reference"
    }
  });
});

app.get("/api/gates",async(req,res)=>{
  const icao=String(req.query.icao||"").trim().toUpperCase();
  const airline=String(req.query.airline||"").trim();
  const aircraftInput=String(req.query.aircraft||"").trim();

  if(!/^[A-Z0-9]{4}$/.test(icao)){
    return res.status(400).json({error:"Bitte einen gültigen 4-stelligen ICAO-Code eingeben."});
  }

  try{
    const [airportResult,ifatcResult,vatsimResult]=await Promise.all([
      loadOsmPositions(icao).catch(e=>({error:e.message,positions:[]})),
      loadIfatc(icao).catch(e=>({error:e.message,gates:[]})),
      getVatsim().catch(e=>{console.warn("[VATSIM]",e.message);return[]})
    ]);

    const osmPositions=Array.isArray(airportResult)?airportResult:airportResult.positions;
    const ifatc=ifatcResult;

    let gates=mergeIfatcAndOsm(ifatc,osmPositions);

    // Last-resort: if IFATC is unavailable, OSM positions still produce a
    // functional airport list.
    if(!gates.length&&osmPositions.length){
      gates=osmPositions.map(p=>({
        name:p.ref,displayName:p.ref,type:p.type,category:p.category,
        maxWingspanM:p.maxSpanM,lat:p.lat,lon:p.lon,osmId:p.osmId,source:"OSM"
      }));
    }

    if(!gates.length){
      return res.status(404).json({
        error:`Keine Gate-Daten für ${icao} gefunden.`,
        details:{
          ifatc:ifatc.error||null,
          osm:airportResult.error||null
        }
      });
    }

    const ac=getAircraft(aircraftInput);
    const occupancy=assignOccupancy(gates,icao,vatsimResult);
    const byGate=new Map(occupancy.map(x=>[x.gateIndex,x]));

    const output=gates.map((g,i)=>{
      const occ=byGate.get(i)||null;
      const aircraftOK=gateMatchesAircraft(g,ac);

      return {
        ...g,
        compatible:aircraftOK,
        occupied:Boolean(occ),
        available:aircraftOK&&!occ,
        status:occ?"occupied":(aircraftOK?"available":"incompatible"),
        occupant:occ||null
      };
    });

    output.sort((a,b)=>{
      const rank=x=>x.status==="available"?0:(x.status==="incompatible"?1:2);
      return rank(a)-rank(b)||a.name.localeCompare(b.name,undefined,{numeric:true});
    });

    res.setHeader("Cache-Control","no-store");
    res.json({
      version:"STABLE-6",
      icao,
      requestedAirline:airline||null,
      requestedAircraft:aircraftInput||null,
      aircraftInfo:ac,
      sources:{
        ifatc:ifatc.error?"unavailable":"ok",
        osm:airportResult.error?"unavailable":"ok"
      },
      totals:{
        gates:output.length,
        available:output.filter(g=>g.available).length,
        occupied:output.filter(g=>g.occupied).length,
        incompatible:output.filter(g=>!g.compatible).length
      },
      vatsimUpdatedAt:vatsimCache.at?new Date(vatsimCache.at).toISOString():null,
      gates:output
    });
  }catch(e){
    console.error(e);
    res.status(502).json({
      error:"Gate-Daten konnten gerade nicht abgerufen werden.",
      details:e.name==="AbortError"?"OpenStreetMap request timeout":e.message
    });
  }
});

app.listen(PORT,"0.0.0.0",()=>console.log(`VATSIM Gate Finder STABLE-6 on ${PORT}`));
