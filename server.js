const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.static(__dirname));
app.use(express.json());

// ---------------- DATA SOURCES ----------------
const VATSIM_URL = "https://data.vatsim.net/v3/vatsim-data.json";
const IFATC_URL = icao => `https://www.ifatc.org/gates?code=${encodeURIComponent(icao)}`;
const OSM_MAP_URL = "https://api.openstreetmap.org/api/0.6/map";
const NOMINATIM_URL = icao =>
  `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=&q=${encodeURIComponent(icao)}`;

const VATSIM_TTL = 10_000;
const REF_TTL = 24 * 60 * 60 * 1000;
const GATE_TTL = 7 * 24 * 60 * 60 * 1000;
const TILE_TTL = 7 * 24 * 60 * 60 * 1000;

// These are intentionally conservative.
// For a parked aircraft, we allow more room because the VATSIM aircraft
// coordinate is not guaranteed to be exactly the nose-wheel point.
// A moving aircraft gets a much tighter radius.
const PARKED_RADIUS = Number(process.env.PARKED_RADIUS_M || 55);
const SLOW_RADIUS = Number(process.env.SLOW_RADIUS_M || 34);
const TAXI_RADIUS = Number(process.env.TAXI_RADIUS_M || 18);

// ---------------- CACHE ----------------
const ifatcCache = new Map();
const airportBoundsCache = new Map();
const tileCache = new Map();
const gateCache = new Map();

let vatsimCache = { at: 0, pilots: [] };

// ---------------- AIRCRAFT ----------------
const AIRCRAFT = {
  A318:{cat:"C",span:34.1,name:"Airbus A318"},
  A319:{cat:"C",span:34.1,name:"Airbus A319"},
  A320:{cat:"C",span:34.1,name:"Airbus A320"},
  A20N:{cat:"C",span:35.8,name:"Airbus A320neo"},
  A321:{cat:"C",span:35.8,name:"Airbus A321"},
  A21N:{cat:"C",span:35.8,name:"Airbus A321neo"},
  B737:{cat:"C",span:35.8,name:"Boeing 737"},
  B738:{cat:"C",span:35.8,name:"Boeing 737-800"},
  B38M:{cat:"C",span:35.9,name:"Boeing 737 MAX 8"},
  B39M:{cat:"C",span:35.9,name:"Boeing 737 MAX 9"},
  E170:{cat:"C",span:26,name:"Embraer 170"},
  E175:{cat:"C",span:28.7,name:"Embraer 175"},
  E190:{cat:"C",span:28.7,name:"Embraer 190"},
  E195:{cat:"C",span:28.7,name:"Embraer 195"},
  E290:{cat:"C",span:33.7,name:"Embraer E190-E2"},
  E295:{cat:"C",span:33.7,name:"Embraer E195-E2"},
  CRJ7:{cat:"C",span:24.9,name:"CRJ700"},
  CRJ9:{cat:"C",span:26.2,name:"CRJ900"},
  CRJX:{cat:"C",span:26.2,name:"CRJ family"},
  DH8D:{cat:"C",span:28.4,name:"Dash 8-400"},
  AT72:{cat:"C",span:27.1,name:"ATR 72"},
  B752:{cat:"D",span:38.5,name:"Boeing 757-200"},
  B753:{cat:"D",span:38.5,name:"Boeing 757-300"},
  A300:{cat:"D",span:44.8,name:"Airbus A300"},
  A310:{cat:"D",span:44.8,name:"Airbus A310"},
  A332:{cat:"E",span:60.3,name:"Airbus A330-200"},
  A333:{cat:"E",span:60.3,name:"Airbus A330-300"},
  A339:{cat:"E",span:64,name:"Airbus A330-900neo"},
  A359:{cat:"E",span:64.8,name:"Airbus A350-900"},
  A35K:{cat:"E",span:64.8,name:"Airbus A350-1000"},
  B762:{cat:"E",span:47.6,name:"Boeing 767-200"},
  B763:{cat:"E",span:51.8,name:"Boeing 767-300"},
  B764:{cat:"E",span:51.8,name:"Boeing 767-400"},
  B772:{cat:"E",span:60.9,name:"Boeing 777-200"},
  B77L:{cat:"E",span:64.8,name:"Boeing 777F/200LR"},
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
  "763":"B763","764":"B764","772":"B772","77L":"B77L","77W":"B77W","788":"B788",
  "789":"B789","781":"B78X","744":"B744","74H":"B748","388":"A388","380":"A388"
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

// ---------------- HELPERS ----------------
function normalizeAircraft(value) {
  const raw = String(value || "").split("/")[0].trim().toUpperCase();
  const key = IATA_TO_ICAO[raw] || raw;

  if (AIRCRAFT[key]) return { icao:key, ...AIRCRAFT[key] };
  if (/^A320/.test(raw)) return { icao:"A320", ...AIRCRAFT.A320 };
  if (/^A321/.test(raw)) return { icao:"A321", ...AIRCRAFT.A321 };
  if (/^A319/.test(raw)) return { icao:"A319", ...AIRCRAFT.A319 };
  if (/^B737/.test(raw)) return { icao:"B737", ...AIRCRAFT.B737 };

  return { icao:raw, name:raw || "Unknown", cat:"", span:null };
}

function airlineFromCallsign(callsign) {
  const prefix = String(callsign || "").toUpperCase().match(/^[A-Z]{3}/)?.[0] || "";
  for (const [icao, aliases] of Object.entries(AIRLINE_ALIASES)) {
    if (aliases.includes(prefix)) return icao;
  }
  return prefix || "UNKNOWN";
}

function normalizeRef(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/\s+/g,"")
    .replace(/[-–—_]/g,"");
}

function refVariants(value) {
  const raw=String(value||"").toUpperCase();
  const out=new Set([normalizeRef(raw)]);

  const tokens=raw.match(/[A-Z]?\d{1,3}[A-Z]?/g)||[];
  for(const token of tokens) out.add(normalizeRef(token));

  for(const part of raw.split(/[\/,;]/)) {
    const p=normalizeRef(part);
    if(p) out.add(p);
  }

  return [...out].filter(Boolean);
}

function referenceScore(a,b) {
  const aa=refVariants(a), bb=refVariants(b);
  let score=0;

  for(const x of aa) {
    for(const y of bb) {
      if(x===y) score=Math.max(score,100);
      else if(x.length>=3 && (x.endsWith(y)||y.endsWith(x))) score=Math.max(score,75);
    }
  }

  return score;
}

function haversine(lat1,lon1,lat2,lon2) {
  const R=6371000,rad=x=>x*Math.PI/180;
  const dLat=rad(lat2-lat1), dLon=rad(lon2-lon1);
  const a=Math.sin(dLat/2)**2+
    Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

function xmlAttrs(text) {
  const out={};
  const r=/([A-Za-z_:][\w:.-]*)="([^"]*)"/g;
  let m;
  while((m=r.exec(text))) out[m[1]]=m[2];
  return out;
}

function parseTagText(block) {
  const tags={};
  const r=/<tag\b([^>]*)\/?>/g;
  let m;

  while((m=r.exec(block))) {
    const a=xmlAttrs(m[1]);
    if(a.k) tags[a.k]=a.v||"";
  }

  return tags;
}

// ---------------- AIRPORT BOUNDARY ----------------
// Instead of assuming a small radius around the ARP, we ask Nominatim for
// the airport's actual bounding box. This fixes large airports such as EGLL.
async function getAirportBounds(icao) {
  const cached=airportBoundsCache.get(icao);
  if(cached && Date.now()-cached.at<REF_TTL) return cached.data;

  const url=NOMINATIM_URL(icao);
  const r=await fetch(url,{
    headers:{
      "User-Agent":"VATSIM-Gate-Finder-v9 (https://vatsim-gate-finder.onrender.com)",
      "Accept":"application/json"
    }
  });

  if(!r.ok) throw new Error(`Nominatim HTTP ${r.status}`);

  const results=await r.json();
  const exact=results.find(x =>
    String(x.type||"").toLowerCase()==="aerodrome" ||
    String(x.class||"").toLowerCase()==="aeroway"
  ) || results[0];

  if(!exact?.boundingbox) throw new Error(`Keine Airport-Bounding-Box für ${icao}`);

  const [south,north,west,east]=exact.boundingbox.map(Number);
  if(![south,north,west,east].every(Number.isFinite)) {
    throw new Error(`Ungültige Airport-Bounding-Box für ${icao}`);
  }

  const data={south,north,west,east,displayName:exact.display_name||icao};
  airportBoundsCache.set(icao,{at:Date.now(),data});
  return data;
}

// ---------------- IFATC ----------------
function cleanHtml(s) {
  return String(s||"")
    .replace(/<[^>]+>/g," ")
    .replace(/&nbsp;/g," ")
    .replace(/&amp;/g,"&")
    .replace(/\s+/g," ")
    .trim();
}

async function loadIfatc(icao) {
  const cached=ifatcCache.get(icao);
  if(cached && Date.now()-cached.at<GATE_TTL) return cached.data;

  const r=await fetch(IFATC_URL(icao),{
    headers:{
      "User-Agent":"VATSIM-Gate-Finder-v9",
      "Accept":"text/html"
    }
  });

  if(!r.ok) throw new Error(`IFATC HTTP ${r.status}`);

  const trs=(await r.text()).match(/<tr[\s\S]*?<\/tr>/gi)||[];
  const gates=[];

  for(const tr of trs) {
    const cells=(tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi)||[]).map(cleanHtml);
    if(cells.length<3)continue;

    const name=cells[0],type=cells[1],category=cells[2].toUpperCase().trim();
    if(!name || !/^[ABCDEF]$/.test(category) || name.toLowerCase()==="name")continue;

    gates.push({rawName:name,type,category});
  }

  const data={at:Date.now(),gates};
  ifatcCache.set(icao,data);
  return data;
}

// ---------------- OSM ----------------
// Tile the ACTUAL airport bbox. A normal OSM map bbox has a size limit, so
// split large airports into small tiles. This covers all aprons and terminals.
function makeTiles(bounds) {
  const stepLat=0.012;
  const centerLat=(bounds.south+bounds.north)/2;
  const cos=Math.max(0.2,Math.cos(centerLat*Math.PI/180));
  const stepLon=stepLat/cos;

  const tiles=[];
  for(let lat=bounds.south;lat<bounds.north;lat+=stepLat) {
    for(let lon=bounds.west;lon<bounds.east;lon+=stepLon) {
      tiles.push([
        lon,
        lat,
        Math.min(lon+stepLon,bounds.east),
        Math.min(lat+stepLat,bounds.north)
      ]);
    }
  }
  return tiles;
}

function parseOsmXml(xml) {
  // Collect all referenced nodes.
  const nodes=new Map();
  const nodeRegex=/<node\b([^>]*?)(?:\/>|>([\s\S]*?)<\/node>)/g;
  let m;

  while((m=nodeRegex.exec(xml))) {
    const a=xmlAttrs(m[1]||"");
    const id=a.id,lat=Number(a.lat),lon=Number(a.lon);
    if(!id || !Number.isFinite(lat)||!Number.isFinite(lon))continue;

    const tags=parseTagText(m[2]||"");
    nodes.set(id,{id,lat,lon,tags});
  }

  const output=[];

  // Node parking positions/gates.
  for(const node of nodes.values()) {
    const kind=node.tags.aeroway;
    if(kind!=="parking_position" && kind!=="gate")continue;

    const ref=node.tags.ref||node.tags["stand:ref"]||node.tags["parking:ref"]||node.tags.name;
    if(!ref)continue;

    const cat=String(
      node.tags["aircraft:reference_code"]||node.tags["aircraft:size"]||""
    ).toUpperCase();

    output.push({
      osmId:node.id,
      ref:String(ref).trim(),
      lat:node.lat,
      lon:node.lon,
      kind,
      anchorType:kind==="parking_position"?"parking_position_node":"gate_node",
      category:/^[ABCDEF]$/.test(cat)?cat:null
    });
  }

  // Way parking positions.
  const wayRegex=/<way\b([^>]*)>([\s\S]*?)<\/way>/g;

  while((m=wayRegex.exec(xml))) {
    const inner=m[2]||"";
    const tags=parseTagText(inner);
    if(tags.aeroway!=="parking_position")continue;

    const refs=[];
    const ndRegex=/<nd\b([^>]*)\/?>/g;
    let nd;
    while((nd=ndRegex.exec(inner))) {
      const a=xmlAttrs(nd[1]);
      if(a.ref)refs.push(a.ref);
    }

    if(!refs.length)continue;

    // OSM convention for a parking-position way: last member is the
    // nose-wheel stopping point.
    const last=nodes.get(refs[refs.length-1]);
    if(!last)continue;

    const ref=tags.ref||tags["stand:ref"]||tags["parking:ref"]||tags.name;
    if(!ref)continue;

    const cat=String(
      tags["aircraft:reference_code"]||tags["aircraft:size"]||""
    ).toUpperCase();

    output.push({
      osmId:`way:${refs[refs.length-1]}:${normalizeRef(ref)}`,
      ref:String(ref).trim(),
      lat:last.lat,
      lon:last.lon,
      kind:"parking_position",
      anchorType:"parking_position_way_endpoint",
      category:/^[ABCDEF]$/.test(cat)?cat:null,
      wayNodeCount:refs.length
    });
  }

  return output;
}

async function fetchOsmTile(bbox) {
  const key=bbox.map(v=>v.toFixed(6)).join(",");
  const cached=tileCache.get(key);
  if(cached&&Date.now()-cached.at<TILE_TTL)return cached.data;

  const [west,south,east,north]=bbox;
  const url=`${OSM_MAP_URL}?bbox=${west},${south},${east},${north}`;

  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),5500);

  try {
    const r=await fetch(url,{
      headers:{
        "User-Agent":"VATSIM-Gate-Finder-v9",
        "Accept":"application/xml"
      },
      signal:controller.signal
    });

    if(!r.ok)throw new Error(`OSM map HTTP ${r.status}`);

    const data=parseOsmXml(await r.text());
    tileCache.set(key,{at:Date.now(),data});
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadOsmPositions(icao) {
  const bounds=await getAirportBounds(icao);
  const tiles=makeTiles(bounds);

  const settled=await Promise.allSettled(tiles.map(fetchOsmTile));
  const all=[];

  for(const r of settled) {
    if(r.status==="fulfilled")all.push(...r.value);
  }

  // Deduplicate exact same physical anchor only.
  const unique=[];
  for(const p of all) {
    const duplicate=unique.find(x =>
      normalizeRef(x.ref)===normalizeRef(p.ref) &&
      haversine(x.lat,x.lon,p.lat,p.lon)<10
    );
    if(!duplicate)unique.push(p);
  }

  return {bounds,positions:unique};
}

// ---------------- GATE MATCHING ----------------
function choosePhysicalAnchor(ifatcGate,positions) {
  let best=null;

  for(const p of positions) {
    const score=referenceScore(ifatcGate.rawName,p.ref);
    if(score<100)continue;

    // Prefer physical parking positions over terminal gate markers.
    const typeBonus=p.kind==="parking_position"?60:0;
    const endpointBonus=p.anchorType==="parking_position_way_endpoint"?10:0;
    const total=score+typeBonus+endpointBonus;

    if(!best || total>best.score)best={p,score:total};
  }

  return best?.p||null;
}

function mergeGates(ifatcGates,positions) {
  const output=[];
  const used=new Set();

  for(const g of ifatcGates) {
    const anchor=choosePhysicalAnchor(g,positions);

    output.push({
      name:g.rawName,
      displayName:g.rawName,
      type:g.type,
      category:g.category,
      lat:anchor?.lat??null,
      lon:anchor?.lon??null,
      osmId:anchor?.osmId??null,
      anchorType:anchor?.anchorType??"none",
      anchorRef:anchor?.ref??null,
      source:anchor?"IFATC + OSM":"IFATC"
    });

    if(anchor)used.add(anchor.osmId);
  }

  // Add all unmatched physical positions as extra stands.
  // This means OSM can discover positions which IFATC hasn't listed.
  for(const p of positions) {
    if(p.kind!=="parking_position")continue;
    if(used.has(p.osmId))continue;

    const existing=output.find(g =>
      g.anchorRef &&
      normalizeRef(g.anchorRef)===normalizeRef(p.ref) &&
      Number.isFinite(g.lat) &&
      haversine(g.lat,g.lon,p.lat,p.lon)<18
    );

    if(existing)continue;

    output.push({
      name:p.ref,
      displayName:p.ref,
      type:"Standplatz",
      category:p.category,
      lat:p.lat,
      lon:p.lon,
      osmId:p.osmId,
      anchorType:p.anchorType,
      anchorRef:p.ref,
      source:"OSM"
    });
  }

  output.sort((a,b)=>String(a.name).localeCompare(String(b.name),undefined,{numeric:true,sensitivity:"base"}));
  return output;
}

// ---------------- OCCUPANCY ----------------
function radiusForPilot(pilot) {
  const speed=Number(pilot.groundspeed||0);

  if(speed<=2) return PARKED_RADIUS;
  if(speed<=8) return SLOW_RADIUS;
  return TAXI_RADIUS;
}

function pilotIsRelevantAtAirport(pilot,bounds,icao) {
  const lat=Number(pilot.latitude),lon=Number(pilot.longitude);
  if(!Number.isFinite(lat)||!Number.isFinite(lon))return false;

  // Most important change from v8:
  // DO NOT require flight_plan departure/arrival == airport.
  // An aircraft can be on a VATSIM airport apron with a missing/changed FP.
  // Spatial inclusion is the authoritative condition.
  if(lat<bounds.south-0.005 || lat>bounds.north+0.005 ||
     lon<bounds.west-0.005 || lon>bounds.east+0.005)return false;

  // If filed flightplan explicitly says a different departure and the aircraft
  // is clearly moving fast, don't count it as airport stand occupancy.
  const fp=pilot.flight_plan||{};
  const dep=String(fp.departure||"").toUpperCase();
  const arr=String(fp.arrival||"").toUpperCase();
  const gs=Number(pilot.groundspeed||0);

  if(dep!==icao && arr!==icao && gs>45)return false;

  return true;
}

function assignOccupancy(gates,icao,pilots,bounds) {
  const candidates=[];

  for(const pilot of pilots) {
    if(!pilotIsRelevantAtAirport(pilot,bounds,icao))continue;

    const lat=Number(pilot.latitude),lon=Number(pilot.longitude);
    const radius=radiusForPilot(pilot);

    let best=null;

    for(let i=0;i<gates.length;i++) {
      const gate=gates[i];
      if(!Number.isFinite(gate.lat)||!Number.isFinite(gate.lon))continue;

      const d=haversine(lat,lon,gate.lat,gate.lon);
      if(d>radius)continue;

      // Terminal gate points are less trustworthy than parking anchors.
      // If an exact physical anchor is available, use it exclusively.
      if(gate.anchorType==="none")continue;

      const confidence =
        (gate.anchorType.startsWith("parking_position")?20:0) -
        d;

      if(!best || confidence>best.confidence) {
        best={
          index:i,
          distance:d,
          radius,
          confidence
        };
      }
    }

    if(!best)continue;

    const ac=normalizeAircraft(pilot.flight_plan?.aircraft_short||pilot.flight_plan?.aircraft||"");
    const speed=Number(pilot.groundspeed||0);

    candidates.push({
      pilot,
      gateIndex:best.index,
      distance:best.distance,
      radius:best.radius,
      confidence:best.confidence,
      aircraft:ac,
      speed
    });
  }

  // Global matching:
  // prioritize low-speed/close aircraft, then assign each pilot/gate once.
  candidates.sort((a,b)=>{
    const aScore=a.distance+(a.speed*1.5);
    const bScore=b.distance+(b.speed*1.5);
    return aScore-bScore;
  });

  const usedPilots=new Set(),usedGates=new Set(),assignments=[];

  for(const c of candidates) {
    const pilotId=String(c.pilot.cid||c.pilot.callsign||"");
    if(usedPilots.has(pilotId)||usedGates.has(c.gateIndex))continue;

    usedPilots.add(pilotId);
    usedGates.add(c.gateIndex);

    assignments.push({
      gateIndex:c.gateIndex,
      callsign:c.pilot.callsign,
      airline:airlineFromCallsign(c.pilot.callsign),
      aircraft:c.aircraft,
      cid:c.pilot.cid,
      distanceM:Math.round(c.distance),
      radiusM:Math.round(c.radius),
      groundspeed:c.speed,
      altitude:Number(c.pilot.altitude||0),
      latitude:Number(c.pilot.latitude),
      longitude:Number(c.pilot.longitude),
      confidence:Math.round(c.confidence)
    });
  }

  return assignments;
}

// ---------------- VATSIM ----------------
async function getVatsimPilots() {
  if(Date.now()-vatsimCache.at<VATSIM_TTL)return vatsimCache.pilots;

  const r=await fetch(VATSIM_URL,{
    headers:{"User-Agent":"VATSIM-Gate-Finder-v9"}
  });

  if(!r.ok)throw new Error(`VATSIM HTTP ${r.status}`);

  const data=await r.json();
  vatsimCache={
    at:Date.now(),
    pilots:Array.isArray(data.pilots)?data.pilots:[]
  };

  return vatsimCache.pilots;
}

function aircraftFitsGate(gate,ac) {
  if(!ac||!gate.category)return true;
  return "ABCDEF".indexOf(ac.cat||"F") <= "ABCDEF".indexOf(gate.category);
}

// ---------------- API ----------------
app.get("/api/health",(req,res)=>{
  res.json({
    ok:true,
    version:"9.0",
    serverTime:new Date().toISOString(),
    vatsimFeedAgeSeconds:vatsimCache.at?Math.round((Date.now()-vatsimCache.at)/1000):null,
    gateCacheSize:gateCache.size,
    osmTileCacheSize:tileCache.size,
    occupancy:{
      parked:PARKED_RADIUS,
      slow:SLOW_RADIUS,
      taxi:TAXI_RADIUS
    }
  });
});

app.get("/api/gates",async(req,res)=>{
  const icao=String(req.query.icao||"").trim().toUpperCase();
  const airline=String(req.query.airline||"").trim().toUpperCase();
  const aircraftInput=String(req.query.aircraft||"").trim();

  if(!/^[A-Z0-9]{4}$/.test(icao)) {
    return res.status(400).json({
      error:"Bitte einen gültigen 4-stelligen ICAO-Code eingeben."
    });
  }

  try {
    let gateData=gateCache.get(icao)?.data;

    if(!gateData || Date.now()-gateCache.get(icao).at>=GATE_TTL) {
      const [ifatcResult,osmResult]=await Promise.allSettled([
        loadIfatc(icao),
        loadOsmPositions(icao)
      ]);

      const ifatc=ifatcResult.status==="fulfilled"?ifatcResult.value.gates:[];
      const osm= osmResult.status==="fulfilled"?osmResult.value:null;

      if(!ifatc.length && !osm?.positions?.length) {
        return res.status(502).json({
          error:`Gate-Daten für ${icao} konnten nicht geladen werden.`,
          details:{
            ifatc:ifatcResult.reason?.message||null,
            osm:osmResult.reason?.message||null
          }
        });
      }

      const positions=osm?.positions||[];
      const bounds=osm?.bounds||null;
      const gates=mergeGates(ifatc,positions);

      gateData={
        source:ifatc.length&&positions.length
          ?"IFATC + OSM"
          :ifatc.length
            ?"IFATC"
            :"OSM",
        bounds,
        gates,
        at:new Date().toISOString()
      };

      gateCache.set(icao,{at:Date.now(),data:gateData});
    }

    const pilots=await getVatsimPilots().catch(e=>{
      console.warn("[VATSIM]",e.message);
      return [];
    });

    const ac=normalizeAircraft(aircraftInput);
    const occupancy=gateData.bounds
      ? assignOccupancy(gateData.gates,icao,pilots,gateData.bounds)
      : [];

    const occupiedMap=new Map(occupancy.map(x=>[x.gateIndex,x]));

    const output=gateData.gates.map((g,i)=>{
      const occ=occupiedMap.get(i)||null;
      const compatible=aircraftFitsGate(g,ac);

      return {
        ...g,
        compatible,
        occupied:Boolean(occ),
        available:Boolean(compatible&&!occ),
        status:occ?"occupied":compatible?"available":"incompatible",
        occupant:occ||null
      };
    });

    output.sort((a,b)=>{
      const rank=x=>x.status==="available"?0:x.status==="incompatible"?1:2;
      return rank(a)-rank(b) ||
        String(a.name).localeCompare(String(b.name),undefined,{numeric:true});
    });

    const groundCandidates=pilots.filter(p=>gateData.bounds&&pilotIsRelevantAtAirport(p,gateData.bounds,icao));

    res.setHeader("Cache-Control","no-store");

    res.json({
      version:"9.0",
      icao,
      source:gateData.source,
      airportBounds:gateData.bounds,
      requestedAirline:airline||null,
      requestedAircraft:aircraftInput||null,
      aircraftInfo:ac,
      gateCacheCreatedAt:gateData.at,
      totals:{
        gates:output.length,
        available:output.filter(g=>g.available).length,
        occupied:output.filter(g=>g.occupied).length,
        incompatible:output.filter(g=>!g.compatible).length
      },
      debug:{
        physicalAnchors:output.filter(g=>Number.isFinite(g.lat)&&Number.isFinite(g.lon)).length,
        unanchored:output.filter(g=>!Number.isFinite(g.lat)||!Number.isFinite(g.lon)).length,
        VATSIMAircraftInsideAirportBounds:groundCandidates.length,
        assignedAircraft:occupancy.length,
        assignments:occupancy
      },
      vatsimUpdatedAt:vatsimCache.at?new Date(vatsimCache.at).toISOString():null,
      gates:output
    });
  } catch(error) {
    console.error(error);
    res.status(502).json({
      error:"Gate-Daten konnten gerade nicht abgerufen werden.",
      details:error.name==="AbortError"?"OpenStreetMap request timeout":error.message
    });
  }
});

app.get("/api/refresh/:icao",(req,res)=>{
  const icao=String(req.params.icao||"").trim().toUpperCase();
  gateCache.delete(icao);
  ifatcCache.delete(icao);
  airportBoundsCache.delete(icao);
  res.json({ok:true,icao,cacheCleared:true});
});

app.listen(PORT,"0.0.0.0",()=>{
  console.log(`VATSIM Gate Finder v9 listening on ${PORT}`);
});
