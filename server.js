const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.static(__dirname));
app.use(express.json());

const VATSIM_URL = "https://data.vatsim.net/v3/vatsim-data.json";
const OURAIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const IFATC_URL = icao => `https://www.ifatc.org/gates?code=${encodeURIComponent(icao)}`;
const OSM_MAP_URL = "https://api.openstreetmap.org/api/0.6/map";

const VATSIM_TTL = 12_000;
const AIRPORT_TTL = 24 * 60 * 60 * 1000;
const GATE_TTL = 7 * 24 * 60 * 60 * 1000;
const OSM_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

// Reference-point compensation.
// VATSIM gives the aircraft simulation position, while OSM parking_position
// is normally the nose-wheel stop point. The radius therefore depends on size.
const BASE_RADII = {
  A: 24, B: 26, C: 30, D: 36, E: 44, F: 52
};

const TAXI_RADIUS = 18;
const SLOW_RADIUS = 34;
const PARKED_RADIUS = 46;

const aircraftDb = {
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
  A339:{cat:"E",span:64,name:"Airbus A330-900neo"},
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

const iataToIcao = {
  "318":"A318","319":"A319","320":"A320","32N":"A20N","321":"A321","32Q":"A21N",
  "737":"B737","738":"B738","7M8":"B38M","7M9":"B39M","170":"E170","175":"E175",
  "190":"E190","195":"E195","290":"E290","295":"E295","CR7":"CRJ7","CR9":"CRJ9",
  "DH4":"DH8D","AT7":"AT72","752":"B752","75Y":"B753","AB6":"A300","310":"A310",
  "332":"A332","333":"A333","339":"A339","359":"A359","351":"A35K","762":"B762",
  "763":"B763","772":"B772","77W":"B77W","788":"B788","789":"B789","781":"B78X",
  "744":"B744","74H":"B748","380":"A388","388":"A388"
};

const airlineAliases = {
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

const airportDb = {at:0,map:new Map()};
let airportPromise=null;
const ifatcCache=new Map();
const gateCache=new Map();
const osmCache=new Map();
let vatsimCache={at:0,pilots:[]};

// ---------- Generic helpers ----------

function normalizeRef(v){
  return String(v||"")
    .toUpperCase()
    .replace(/\s+/g,"")
    .replace(/[-–—_]/g,"");
}

function refVariants(v){
  const raw=String(v||"").toUpperCase().trim();
  const out=new Set();
  out.add(normalizeRef(raw));

  // All stand-like tokens, e.g.
  // "Terminal 2 Gate D10" -> D10, "D11/12" -> D11, 12
  const tokens=raw.match(/[A-Z]?\d{1,3}[A-Z]?/g)||[];
  for(const token of tokens)out.add(normalizeRef(token));

  for(const piece of raw.split(/[\/,;]/)){
    const p=normalizeRef(piece);
    if(p)out.add(p);
  }

  return [...out].filter(Boolean);
}

function bestRefMatch(a,b){
  const aa=refVariants(a), bb=refVariants(b);
  let score=0;
  for(const x of aa){
    for(const y of bb){
      if(x===y)score=Math.max(score,100);
      else if(x.length>=2 && (x.endsWith(y)||y.endsWith(x)))score=Math.max(score,75);
    }
  }
  return score;
}

function haversine(lat1,lon1,lat2,lon2){
  const R=6371000;
  const rad=x=>x*Math.PI/180;
  const dLat=rad(lat2-lat1),dLon=rad(lon2-lon1);
  const a=Math.sin(dLat/2)**2+
    Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

function aircraft(v){
  const raw=String(v||"").split("/")[0].trim().toUpperCase();
  const key=iataToIcao[raw]||raw;
  if(aircraftDb[key])return {icao:key,...aircraftDb[key]};
  if(/^A320/.test(raw))return {icao:"A320",...aircraftDb.A320};
  if(/^A321/.test(raw))return {icao:"A321",...aircraftDb.A321};
  if(/^A319/.test(raw))return {icao:"A319",...aircraftDb.A319};
  if(/^B737/.test(raw))return {icao:"B737",...aircraftDb.B737};
  return {icao:raw,name:raw||"Unknown",cat:"",span:null};
}

function airlineFromCallsign(callsign){
  const prefix=String(callsign||"").toUpperCase().match(/^[A-Z]{3}/)?.[0]||"";
  for(const [icao,aliases] of Object.entries(airlineAliases)){
    if(aliases.includes(prefix))return icao;
  }
  return prefix||"UNKNOWN";
}

function parseCsv(csv){
  const rows=[];let row=[],cell="",quoted=false;
  for(let i=0;i<csv.length;i++){
    const ch=csv[i];
    if(ch==='"'&&csv[i+1]==='"'&&quoted){cell+='"';i++;continue}
    if(ch==='"'){quoted=!quoted;continue}
    if(ch===','&&!quoted){row.push(cell);cell="";continue}
    if((ch==="\n"||ch==="\r")&&!quoted){
      if(ch==="\r"&&csv[i+1]==="\n")i++;
      row.push(cell);rows.push(row);row=[];cell="";continue;
    }
    cell+=ch;
  }
  if(cell||row.length){row.push(cell);rows.push(row)}
  return rows;
}

// ---------- Airport coordinates ----------

async function loadAirports(){
  if(airportDb.map.size&&Date.now()-airportDb.at<24*60*60*1000)return airportDb.map;
  if(airportPromise)return airportPromise;

  airportPromise=(async()=>{
    const r=await fetch(OURAIRPORTS_URL,{headers:{"User-Agent":"VATSIM-Gate-Finder-v8"}});
    if(!r.ok)throw new Error(`OurAirports HTTP ${r.status}`);
    const rows=parseCsv(await r.text());
    const header=rows.shift();
    const idx=Object.fromEntries(header.map((x,i)=>[x,i]));
    const map=new Map();

    for(const row of rows){
      const ident=String(row[idx.ident]||"").trim().toUpperCase();
      const lat=Number(row[idx.latitude_deg]),lon=Number(row[idx.longitude_deg]);
      if(/^[A-Z0-9]{4}$/.test(ident)&&Number.isFinite(lat)&&Number.isFinite(lon)){
        map.set(ident,{lat,lon,name:row[idx.name]||ident});
      }
    }

    airportDb.at=Date.now();
    airportDb.map=map;
    airportPromise=null;
    return map;
  })().catch(e=>{airportPromise=null;throw e});

  return airportPromise;
}

// ---------- IFATC ----------

function textClean(s){
  return String(s||"")
    .replace(/<[^>]+>/g," ")
    .replace(/&nbsp;/g," ")
    .replace(/&amp;/g,"&")
    .replace(/&#39;/g,"'")
    .replace(/\s+/g," ")
    .trim();
}

async function loadIfatc(icao){
  const cached=ifatcCache.get(icao);
  if(cached&&Date.now()-cached.at<GATE_TTL_MS)return cached.data;

  const r=await fetch(IFATC_URL(icao),{
    headers:{"User-Agent":"VATSIM-Gate-Finder-v8","Accept":"text/html"}
  });
  if(!r.ok)throw new Error(`IFATC HTTP ${r.status}`);

  const html=await r.text();
  const trs=html.match(/<tr[\s\S]*?<\/tr>/gi)||[];
  const gates=[];

  for(const tr of trs){
    const cells=(tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi)||[]).map(textClean);
    if(cells.length<3)continue;
    const name=cells[0], type=cells[1], cls=cells[2].toUpperCase();
    if(!name||!/^[ABCDEF]$/.test(cls))continue;
    if(name.toLowerCase()==="name")continue;

    // For IFATC we preserve the whole descriptive name so the frontend can
    // show "Terminal 2 Gate D10", but ref matching uses variants.
    gates.push({rawName:name,type,class:cls});
  }

  const data={at:Date.now(),gates};
  ifatcCache.set(icao,data);
  return data;
}

// ---------- Proper OSM XML parser ----------

// IMPORTANT:
// OSM parking_position is valid as a node OR a way. For a way, the LAST node
// is the nose-wheel stopping point according to the OSM mapping convention.
// We therefore collect every node first, then resolve each parking-position way.

function parseOsmXml(xml){
  const nodes=new Map();
  const parkingWays=[];
  const gateWays=[];

  const nodeRegex=/<node\b([^>]*?)(?:\/>|>([\s\S]*?)<\/node>)/g;
  let match;

  while((match=nodeRegex.exec(xml))){
    const attrText=match[1]||"";
    const inner=match[2]||"";
    const attrs={};
    let a;
    const attrRegex=/(\w+)="([^"]*)"/g;
    while((a=attrRegex.exec(attrText)))attrs[a[1]]=a[2];

    const id=attrs.id;
    const lat=Number(attrs.lat);
    const lon=Number(attrs.lon);
    if(!id||!Number.isFinite(lat)||!Number.isFinite(lon))continue;

    const tags={};
    let t;
    const tagRegex=/<tag\b([^>]*)\/?>/g;
    while((t=tagRegex.exec(inner))){
      const ta={};
      let x;
      while((x=attrRegex.exec(t[1])))ta[x[1]]=x[2];
      if(ta.k)tags[ta.k]=ta.v||"";
    }

    nodes.set(id,{id,lat,lon,tags});
  }

  const wayRegex=/<way\b([^>]*?)>([\s\S]*?)<\/way>/g;
  while((match=wayRegex.exec(xml))){
    const inner=match[2]||"";
    const nds=[];
    let nd;
    const ndRegex=/<nd\b([^>]*)\/?>/g;
    while((nd=ndRegex.exec(inner))){
      const ref=nd[1].match(/\bref="([^"]+)"/)?.[1];
      if(ref)nds.push(ref);
    }

    const tags={};
    let t;
    const tagRegex=/<tag\b([^>]*)\/?>/g;
    while((t=tagRegex.exec(inner))){
      const ta={};
      let x;
      while((x=/(\w+)="([^"]*)"/g.exec(t[1])))ta[x[1]]=x[2];
      if(ta.k)tags[ta.k]=ta.v||"";
    }

    if(!nds.length)continue;

    if(tags.aeroway==="parking_position")parkingWays.push({nds,tags});
    if(tags.aeroway==="gate")gateWays.push({nds,tags});
  }

  const out=[];

  // Parking-position nodes.
  for(const n of nodes.values()){
    if(n.tags.aeroway!=="parking_position"&&n.tags.aeroway!=="gate")continue;

    const ref=n.tags.ref||n.tags["stand:ref"]||n.tags["parking:ref"]||n.tags.name;
    if(!ref)continue;

    out.push({
      osmId:n.id,
      kind:n.tags.aeroway,
      ref:String(ref).trim(),
      lat:n.lat,
      lon:n.lon,
      anchorType:n.tags.aeroway==="parking_position"?"parking_position_node":"gate_node",
      category:["A","B","C","D","E","F"].includes(String(n.tags["aircraft:reference_code"]||n.tags["aircraft:size"]||"").toUpperCase())
        ?String(n.tags["aircraft:reference_code"]||n.tags["aircraft:size"]).toUpperCase()
        :null
    });
  }

  // Parking-position ways -> last node.
  // This is the key fix missing in v7.
  for(const way of parkingWays){
    const lastRef=way.nds[way.nds.length-1];
    const last=nodes.get(lastRef);
    if(!last)continue;

    const ref=way.tags.ref||way.tags["stand:ref"]||way.tags["parking:ref"]||way.tags.name;
    if(!ref)continue;

    const cat=String(way.tags["aircraft:reference_code"]||way.tags["aircraft:size"]||"").toUpperCase();

    out.push({
      osmId:`way:${lastRef}:${normalizeRef(ref)}`,
      kind:"parking_position",
      ref:String(ref).trim(),
      lat:last.lat,
      lon:last.lon,
      anchorType:"parking_position_way_endpoint",
      category:["A","B","C","D","E","F"].includes(cat)?cat:null
    });
  }

  return out;
}

function tileBboxes(center){
  const step=0.012;
  const half=0.018;
  const out=[];
  for(let y=-half;y<half;y+=step){
    for(let x=-half;x<half;x+=step){
      out.push([
        center.lon+x,
        center.lat+y,
        center.lon+x+step,
        center.lat+y+step
      ]);
    }
  }
  return out;
}

async function loadOsmTile(bbox){
  const key=bbox.map(x=>x.toFixed(5)).join(",");
  const cached=osmCache.get(key);
  if(cached&&Date.now()-cached.at<OSM_CACHE_TTL)return cached.data;

  const [minLon,minLat,maxLon,maxLat]=bbox;
  const url=`${OSM_MAP_URL}?bbox=${minLon},${minLat},${maxLon},${maxLat}`;
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),5000);

  try{
    const r=await fetch(url,{
      headers:{
        "User-Agent":"VATSIM-Gate-Finder-v8",
        "Accept":"application/xml"
      },
      signal:controller.signal
    });
    if(!r.ok)throw new Error(`OSM HTTP ${r.status}`);

    const data=parseOsmXml(await r.text());
    osmCache.set(key,{at:Date.now(),data});
    return data;
  }finally{
    clearTimeout(timeout);
  }
}

async function loadOsmPositions(icao){
  const airports=await loadAirports();
  const center=airports.get(icao);
  if(!center)throw new Error(`Airport ${icao} nicht in OurAirports gefunden.`);

  const tiles=tileBboxes(center);
  const settled=await Promise.allSettled(tiles.map(loadOsmTile));
  const positions=[];

  for(const r of settled){
    if(r.status==="fulfilled")positions.push(...r.value);
  }

  // Keep distinct physical positions. Same ref at two different coordinates is
  // legitimate for airport mapping only if it is actually duplicated in OSM;
  // do not collapse it by name alone.
  const unique=[];
  for(const p of positions){
    const duplicate=unique.find(x=>
      normalizeRef(x.ref)===normalizeRef(p.ref)&&
      haversine(x.lat,x.lon,p.lat,p.lon)<12
    );
    if(!duplicate)unique.push(p);
  }

  return unique;
}

// ---------- Gate → physical stand matching ----------

function chooseAnchor(ifatcGate,osmPositions){
  const variants=refVariants(ifatcGate.rawName);

  const scored=osmPositions.map(p=>{
    const refScore=Math.max(
      ...refVariants(p.ref).map(x=>variants.includes(x)?100:0),
      bestRefMatch(ifatcGate.rawName,p.ref)
    );

    // Prefer physical parking positions strongly over terminal gate points.
    const typeBonus=p.kind==="parking_position"?50:0;
    const endpointBonus=p.anchorType==="parking_position_way_endpoint"?10:0;

    return {
      p,
      score:refScore+typeBonus+endpointBonus
    };
  }).filter(x=>x.score>100);

  scored.sort((a,b)=>b.score-a.score);
  return scored[0]?.p||null;
}

function mergeGates(ifatc,osm){
  const result=[];
  const used=new Set();

  for(const g of ifatc){
    const anchor=chooseAnchor(g,osm);

    result.push({
      name:g.rawName,
      displayName:g.rawName,
      type:g.type,
      category:g.class,
      lat:anchor?.lat??null,
      lon:anchor?.lon??null,
      osmId:anchor?.osmId??null,
      anchorType:anchor?.anchorType??"none",
      source:anchor?"IFATC + OSM":"IFATC",
      anchorRef:anchor?.ref??null
    });

    if(anchor)used.add(anchor.osmId);
  }

  // Add unmatched OSM physical stands, useful when IFATC is incomplete.
  for(const p of osm){
    if(p.kind!=="parking_position")continue;
    if(used.has(p.osmId))continue;

    const already=result.some(g=>
      g.anchorRef&&normalizeRef(g.anchorRef)===normalizeRef(p.ref) &&
      Number.isFinite(g.lat)&&
      haversine(g.lat,g.lon,p.lat,p.lon)<20
    );

    if(already)continue;

    result.push({
      name:p.ref,
      displayName:p.ref,
      type:"Standplatz",
      category:p.category,
      lat:p.lat,
      lon:p.lon,
      osmId:p.osmId,
      anchorType:p.anchorType,
      source:"OSM",
      anchorRef:p.ref
    });
  }

  result.sort((a,b)=>String(a.name).localeCompare(String(b.name),undefined,{numeric:true}));
  return result;
}

// ---------- Occupancy ----------

function occupancyRadius(pilot,gate){
  const gs=Number(pilot.groundspeed||0);

  if(gs<=2){
    const ac=aircraft(pilot.flight_plan?.aircraft_short||pilot.flight_plan?.aircraft);
    return Math.max(PARKED_RADIUS,BASE_RADII[ac.cat]||PARKED_RADIUS);
  }

  if(gs<=8)return SLOW_RADIUS;

  // Aircraft moving >8kt must be much closer to the actual nose-wheel anchor.
  return TAXI_RADIUS;
}

function assignOccupancy(gates,icao,pilots){
  const candidates=[];

  for(const pilot of pilots){
    const fp=pilot.flight_plan||{};
    const dep=String(fp.departure||"").toUpperCase();
    const arr=String(fp.arrival||"").toUpperCase();

    if(dep!==icao&&arr!==icao)continue;

    const lat=Number(pilot.latitude),lon=Number(pilot.longitude);
    if(!Number.isFinite(lat)||!Number.isFinite(lon))continue;

    // Ignore anything flying over the airport.
    if(Number(pilot.altitude||0)>1500&&Number(pilot.groundspeed||0)>35)continue;

    const radiusForGate=g=>occupancyRadius(pilot,g);
    let best=null;

    for(let i=0;i<gates.length;i++){
      const g=gates[i];
      if(!Number.isFinite(g.lat)||!Number.isFinite(g.lon))continue;

      // Never use IFATC-only records without a physical coordinate.
      if(g.anchorType==="none")continue;

      const d=haversine(g.lat,g.lon,lat,lon);
      const radius=radiusForGate(g);

      if(d<=radius){
        // Favor smaller distance, but reward actual parking_position anchor.
        const anchorBonus=g.anchorType.startsWith("parking_position")?8:0;
        const score=d-anchorBonus;
        if(!best||score<best.score){
          best={index:i,distance:d,radius,score};
        }
      }
    }

    if(!best)continue;

    // Fast taxi cannot claim a stand merely because it passes the edge of it.
    const gs=Number(pilot.groundspeed||0);
    if(gs>8&&best.distance>TAXI_RADIUS)continue;

    candidates.push({
      pilot,
      gateIndex:best.index,
      distance:best.distance,
      radius:best.radius,
      groundspeed:gs
    });
  }

  // One-to-one global assignment.
  candidates.sort((a,b)=>a.distance-b.distance);

  const usedPilots=new Set();
  const usedGates=new Set();
  const result=[];

  for(const c of candidates){
    const id=String(c.pilot.cid||c.pilot.callsign||"");
    if(usedPilots.has(id)||usedGates.has(c.gateIndex))continue;

    usedPilots.add(id);
    usedGates.add(c.gateIndex);

    result.push({
      gateIndex:c.gateIndex,
      callsign:c.pilot.callsign,
      airline:airlineFromCallsign(c.pilot.callsign),
      aircraft:normalizeAircraft(c.pilot.flight_plan?.aircraft_short||c.pilot.flight_plan?.aircraft||""),
      cid:c.pilot.cid,
      distanceM:Math.round(c.distance),
      radiusM:Math.round(c.radius),
      groundspeed:c.groundspeed
    });
  }

  return result;
}

// ---------- VATSIM ----------

async function getVatsimPilots(){
  if(Date.now()-vatsimCache.at<VATSIM_TTL)return vatsimCache.pilots;

  const r=await fetch(VATSIM_URL,{headers:{"User-Agent":"VATSIM-Gate-Finder-v8"}});
  if(!r.ok)throw new Error(`VATSIM HTTP ${r.status}`);

  const data=await r.json();
  vatsimCache={
    at:Date.now(),
    pilots:Array.isArray(data.pilots)?data.pilots:[]
  };
  return vatsimCache.pilots;
}

function aircraftFits(g,ac){
  if(!ac||!g.category)return true;
  return "ABCDEF".indexOf(ac.cat||"F")<="ABCDEF".indexOf(g.category);
}

// ---------- API ----------

app.get("/api/health",(req,res)=>{
  res.json({
    ok:true,
    version:"8.0",
    serverTime:new Date().toISOString(),
    vatsimFeedAgeSeconds:vatsimCache.at?Math.round((Date.now()-vatsimCache.at)/1000):null,
    gateCache:gateCache.size,
    osmTileCache:osmCache.size,
    radii:{
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

  if(!/^[A-Z0-9]{4}$/.test(icao)){
    return res.status(400).json({error:"Bitte einen gültigen 4-stelligen ICAO-Code eingeben."});
  }

  try{
    let airportData;
    const cached=gateCache.get(icao);

    if(cached&&Date.now()-cached.at<GATE_TTL){
      airportData=cached.data;
    }else{
      const [ifatcResult,osmResult]=await Promise.allSettled([
        loadIfatc(icao),
        loadOsmPositions(icao)
      ]);

      const ifatc=ifatcResult.status==="fulfilled"?ifatcResult.value.gates:[];
      const osm=osmResult.status==="fulfilled"?osmResult.value:[];

      if(!ifatc.length&&!osm.length){
        return res.status(502).json({
          error:`Gate-Daten für ${icao} konnten nicht geladen werden.`,
          details:{
            ifatc:ifatcResult.reason?.message||null,
            osm:osmResult.reason?.message||null
          }
        });
      }

      const merged=mergeGates(ifatc,osm);
      airportData={
        source:ifatc.length&&osm.length?"IFATC + OSM":ifatc.length?"IFATC":"OSM",
        gates:merged,
        at:new Date().toISOString()
      };

      gateCache.set(icao,{at:Date.now(),data:airportData});
    }

    const pilots=await getVatsimPilots().catch(e=>{
      console.warn("[VATSIM]",e.message);
      return [];
    });

    const ac=aircraft(aircraftInput);
    const occupancy=assignOccupancy(airportData.gates,icao,pilots);
    const byGate=new Map(occupancy.map(x=>[x.gateIndex,x]));

    const output=airportData.gates.map((g,index)=>{
      const occ=byGate.get(index)||null;
      const compatible=aircraftFits(g,ac);

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
      const rank=g=>g.status==="available"?0:g.status==="incompatible"?1:2;
      return rank(a)-rank(b)||String(a.name).localeCompare(String(b.name),undefined,{numeric:true});
    });

    res.setHeader("Cache-Control","no-store");

    res.json({
      version:"8.0",
      icao,
      source:airportData.source,
      requestedAirline:airline||null,
      requestedAircraft:aircraftInput||null,
      aircraftInfo:ac,
      gateCacheCreatedAt:airportData.at,
      totals:{
        gates:output.length,
        available:output.filter(g=>g.available).length,
        occupied:output.filter(g=>g.occupied).length,
        incompatible:output.filter(g=>!g.compatible).length
      },
      debug:{
        occupiedAssignments:occupancy.length,
        physicalAnchors:output.filter(g=>Number.isFinite(g.lat)&&Number.isFinite(g.lon)).length,
        unanchored:output.filter(g=>!Number.isFinite(g.lat)||!Number.isFinite(g.lon)).length
      },
      vatsimUpdatedAt:vatsimCache.at?new Date(vatsimCache.at).toISOString():null,
      gates:output
    });
  }catch(error){
    console.error(error);
    res.status(502).json({
      error:"Gate-Daten konnten gerade nicht abgerufen werden.",
      details:error.name==="AbortError"?"OpenStreetMap API timeout":error.message
    });
  }
});

app.get("/api/refresh/:icao",(req,res)=>{
  const icao=String(req.params.icao||"").trim().toUpperCase();
  gateCache.delete(icao);
  ifatcCache.delete(icao);
  res.json({ok:true,icao,cacheCleared:true});
});

app.listen(PORT,"0.0.0.0",()=>{
  console.log(`VATSIM Gate Finder v8 listening on ${PORT}`);
});
