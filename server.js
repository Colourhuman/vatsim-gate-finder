const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;
app.use(express.static(__dirname));
app.use(express.json());

const VATSIM_URL = "https://data.vatsim.net/v3/vatsim-data.json";
const IFATC_URL = icao => `https://www.ifatc.org/gates?code=${encodeURIComponent(icao)}`;
const OSM_MAP_URL = "https://api.openstreetmap.org/api/0.6/map";
const NOMINATIM_URL = icao => `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(icao + " airport")}`;

const VATSIM_TTL = 10_000;
const GATE_TTL = 24 * 60 * 60 * 1000;
const TILE_TTL = 7 * 24 * 60 * 60 * 1000;
const REF_TTL = 7 * 24 * 60 * 60 * 1000;

// VATSIM aircraft coordinates are not the OSM nose-wheel anchor. These values
// deliberately cover the normal aircraft-reference-point offset while keeping
// taxiing traffic from occupying a nearby stand.
const PARKED_RADIUS = Number(process.env.PARKED_RADIUS_M || 85);
const SLOW_RADIUS = Number(process.env.SLOW_RADIUS_M || 55);
const TAXI_RADIUS = Number(process.env.TAXI_RADIUS_M || 32);

const ifatcCache = new Map();
const airportBoundsCache = new Map();
const tileCache = new Map();
const gateCache = new Map();
let vatsimCache = { at: 0, pilots: [] };

const RULES = JSON.parse(fs.readFileSync(path.join(__dirname, "airport-rules.json"), "utf8"));

const AIRCRAFT = {
  A318:{cat:"C",span:34.1,name:"Airbus A318"}, A319:{cat:"C",span:34.1,name:"Airbus A319"},
  A320:{cat:"C",span:34.1,name:"Airbus A320"}, A20N:{cat:"C",span:35.8,name:"Airbus A320neo"},
  A321:{cat:"C",span:35.8,name:"Airbus A321"}, A21N:{cat:"C",span:35.8,name:"Airbus A321neo"},
  B737:{cat:"C",span:35.8,name:"Boeing 737"}, B738:{cat:"C",span:35.8,name:"Boeing 737-800"},
  B38M:{cat:"C",span:35.9,name:"Boeing 737 MAX 8"}, B39M:{cat:"C",span:35.9,name:"Boeing 737 MAX 9"},
  E170:{cat:"C",span:26,name:"Embraer 170"}, E175:{cat:"C",span:28.7,name:"Embraer 175"},
  E190:{cat:"C",span:28.7,name:"Embraer 190"}, E195:{cat:"C",span:28.7,name:"Embraer E195"},
  E290:{cat:"C",span:33.7,name:"Embraer E190-E2"}, E295:{cat:"C",span:33.7,name:"Embraer E195-E2"},
  CRJ7:{cat:"C",span:24.9,name:"CRJ700"}, CRJ9:{cat:"C",span:26.2,name:"CRJ900"},
  CRJX:{cat:"C",span:26.2,name:"CRJ family"}, DH8D:{cat:"C",span:28.4,name:"Dash 8-400"},
  AT72:{cat:"C",span:27.1,name:"ATR 72"}, B752:{cat:"D",span:38.5,name:"Boeing 757-200"},
  B753:{cat:"D",span:38.5,name:"Boeing 757-300"}, A300:{cat:"D",span:44.8,name:"Airbus A300"},
  A310:{cat:"D",span:44.8,name:"Airbus A310"}, A332:{cat:"E",span:60.3,name:"Airbus A330-200"},
  A333:{cat:"E",span:60.3,name:"Airbus A330-300"}, A339:{cat:"E",span:64,name:"Airbus A330-900neo"},
  A359:{cat:"E",span:64.8,name:"Airbus A350-900"}, A35K:{cat:"E",span:64.8,name:"Airbus A350-1000"},
  B762:{cat:"E",span:47.6,name:"Boeing 767-200"}, B763:{cat:"E",span:51.8,name:"Boeing 767-300"},
  B764:{cat:"E",span:51.8,name:"Boeing 767-400"}, B772:{cat:"E",span:60.9,name:"Boeing 777-200"},
  B77L:{cat:"E",span:64.8,name:"Boeing 777F/200LR"}, B77W:{cat:"E",span:64.8,name:"Boeing 777-300ER"},
  B788:{cat:"E",span:60.1,name:"Boeing 787-8"}, B789:{cat:"E",span:60.1,name:"Boeing 787-9"},
  B78X:{cat:"E",span:60.1,name:"Boeing 787-10"}, B744:{cat:"E",span:64.4,name:"Boeing 747-400"},
  B748:{cat:"F",span:68.4,name:"Boeing 747-8"}, A388:{cat:"F",span:79.8,name:"Airbus A380-800"}
};
const MODEL_ALIASES = {
  "318":"A318","319":"A319","320":"A320","32N":"A20N","321":"A321","32Q":"A21N",
  "737":"B737","738":"B738","7M8":"B38M","7M9":"B39M","170":"E170","175":"E175","190":"E190","195":"E195",
  "290":"E290","295":"E295","CR7":"CRJ7","CR9":"CRJ9","DH4":"DH8D","AT7":"AT72","752":"B752","75Y":"B753",
  "AB6":"A300","310":"A310","332":"A332","333":"A333","339":"A339","359":"A359","351":"A35K","762":"B762","763":"B763",
  "764":"B764","772":"B772","77L":"B77L","77W":"B77W","788":"B788","789":"B789","781":"B78X","744":"B744","74H":"B748","380":"A388","388":"A388"
};

const aliasToIcao = new Map();
for (const [icao, data] of Object.entries(RULES.airlines || {})) {
  for (const a of [icao, ...(data.aliases || [])]) aliasToIcao.set(String(a).toUpperCase(), icao);
}

const CAT_ORDER = {A:0,B:1,C:2,D:3,E:4,F:5};

function normalizeAirline(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return {icao:"", name:"All airlines", aliases:[]};
  const direct = aliasToIcao.get(raw);
  if (direct) return {icao:direct, name:RULES.airlines[direct].name, aliases:RULES.airlines[direct].aliases};
  return {icao:raw, name:raw, aliases:[raw]};
}

function airlineFromCallsign(callsign) {
  const prefix = String(callsign || "").toUpperCase().match(/^[A-Z]{3}/)?.[0] || "";
  return normalizeAirline(prefix);
}

function normalizeAircraft(value) {
  const raw = String(value || "").split("/")[0].trim().toUpperCase();
  const key = MODEL_ALIASES[raw] || raw;
  if (AIRCRAFT[key]) return {input:String(value||""), icao:key, ...AIRCRAFT[key]};
  for (const k of Object.keys(AIRCRAFT)) if (raw.startsWith(k)) return {input:String(value||""), icao:k, ...AIRCRAFT[k]};
  return {input:String(value||""), icao:raw, name:raw || "Unknown", cat:"", span:null};
}

function normalizeRef(value) {
  return String(value || "").toUpperCase().replace(/\s+/g, "").replace(/[-–—_]/g, "");
}
function refVariants(value) {
  const raw = String(value || "").toUpperCase();
  const out = new Set([normalizeRef(raw)]);
  for (const part of raw.split(/[\/,;]/)) { const p=normalizeRef(part); if(p) out.add(p); }
  return [...out].filter(Boolean);
}
function referenceScore(a,b) {
  let score=0;
  for(const x of refVariants(a)) for(const y of refVariants(b)) {
    if(x===y) score=Math.max(score,100);
    else if(x.length>=3 && (x.endsWith(y)||y.endsWith(x))) score=Math.max(score,78);
  }
  return score;
}
function haversine(lat1,lon1,lat2,lon2){
  const R=6371000,rad=x=>x*Math.PI/180;
  const dLat=rad(lat2-lat1),dLon=rad(lon2-lon1);
  const a=Math.sin(dLat/2)**2+Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}
function xmlAttrs(text){const out={};const r=/([A-Za-z_:][\w:.-]*)="([^"]*)"/g;let m;while((m=r.exec(text)))out[m[1]]=m[2];return out;}
function parseTagText(block){const tags={};const r=/<tag\b([^>]*)\/?>(?:<\/tag>)?/g;let m;while((m=r.exec(block))){const a=xmlAttrs(m[1]);if(a.k)tags[a.k]=a.v||"";}return tags;}
function gateFamily(name){
  const n=String(name||"").toUpperCase().replace(/\s+/g,"");
  const m=n.match(/^([A-Z]+|\d+)/); return m?m[1]:n;
}
function gateMatchesRule(g,rule){
  try{return new RegExp(rule.match,"i").test(String(g.name||""));}catch{return false;}
}

async function getAirportBounds(icao){
  const cached=airportBoundsCache.get(icao); if(cached && Date.now()-cached.at<REF_TTL)return cached.data;
  const r=await fetch(NOMINATIM_URL(icao),{headers:{"User-Agent":"VATSIM-Gate-Finder/12.0","Accept":"application/json"}});
  if(!r.ok)throw new Error(`Nominatim HTTP ${r.status}`);
  const results=await r.json();
  const exact=results.find(x=>String(x.type||"").toLowerCase()==="aerodrome")||results.find(x=>String(x.class||"").toLowerCase()==="aeroway")||results[0];
  if(!exact?.boundingbox)throw new Error(`Keine Airport-Bounding-Box für ${icao}`);
  const [south,north,west,east]=exact.boundingbox.map(Number);
  if(![south,north,west,east].every(Number.isFinite))throw new Error(`Ungültige Airport-Bounding-Box für ${icao}`);
  const data={south,north,west,east,displayName:exact.display_name||icao};
  airportBoundsCache.set(icao,{at:Date.now(),data}); return data;
}

function cleanHtml(s){return String(s||"").replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/\s+/g," ").trim();}
async function loadIfatc(icao){
  const cached=ifatcCache.get(icao);if(cached&&Date.now()-cached.at<GATE_TTL)return cached.data;
  const r=await fetch(IFATC_URL(icao),{headers:{"User-Agent":"VATSIM-Gate-Finder/12.0","Accept":"text/html"}});
  if(!r.ok)throw new Error(`IFATC HTTP ${r.status}`);
  const trs=(await r.text()).match(/<tr[\s\S]*?<\/tr>/gi)||[];const raw=[];
  for(const tr of trs){
    const cells=(tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi)||[]).map(cleanHtml);
    if(cells.length<3)continue;
    const name=cells[0],type=cells[1],category=cells[2].toUpperCase().trim();
    if(!name||!/^[ABCDEF]$/.test(category)||name.toLowerCase()==="name")continue;
    raw.push({name:name.trim(),type:type.trim(),category});
  }
  // IFATC may list one physical stand more than once. Canonicalize it here.
  const byRef=new Map();
  for(const g of raw){
    const key=normalizeRef(g.name);
    const old=byRef.get(key);
    if(!old){byRef.set(key,g);continue;}
    const oldRank=CAT_ORDER[old.category]??99,newRank=CAT_ORDER[g.category]??99;
    if(newRank>oldRank)byRef.set(key,{...old,category:g.category});
  }
  const data={at:Date.now(),gates:[...byRef.values()]};
  ifatcCache.set(icao,data);return data;
}

function makeTiles(bounds){
  const stepLat=.012,center=(bounds.south+bounds.north)/2,cos=Math.max(.2,Math.cos(center*Math.PI/180)),stepLon=stepLat/cos,tiles=[];
  for(let lat=bounds.south;lat<bounds.north;lat+=stepLat)for(let lon=bounds.west;lon<bounds.east;lon+=stepLon)
    tiles.push([lon,lat,Math.min(lon+stepLon,bounds.east),Math.min(lat+stepLat,bounds.north)]);
  return tiles;
}
function parseOsmXml(xml){
  const nodes=new Map(),output=[];let m;
  const nodeRegex=/<node\b([^>]*?)(?:\/|>([\s\S]*?)<\/node)>/g;
  while((m=nodeRegex.exec(xml))){const a=xmlAttrs(m[1]||"");const id=a.id,lat=Number(a.lat),lon=Number(a.lon);if(!id||!Number.isFinite(lat)||!Number.isFinite(lon))continue;nodes.set(id,{id,lat,lon,tags:parseTagText(m[2]||"")});}
  for(const node of nodes.values()){
    const kind=node.tags.aeroway;if(kind!=="parking_position"&&kind!=="gate")continue;
    const ref=node.tags.ref||node.tags["stand:ref"]||node.tags["parking:ref"]||node.tags.name;if(!ref)continue;
    const cat=String(node.tags["aircraft:reference_code"]||node.tags["aircraft:size"]||"").toUpperCase();
    output.push({osmId:`node:${node.id}`,ref:String(ref).trim(),lat:node.lat,lon:node.lon,kind,anchorType:kind==="parking_position"?"parking_position_node":"gate_node",category:/^[ABCDEF]$/.test(cat)?cat:null});
  }
  const wayRegex=/<way\b([^>]*)>([\s\S]*?)<\/way>/g;
  while((m=wayRegex.exec(xml))){const inner=m[2]||"",tags=parseTagText(inner);if(tags.aeroway!=="parking_position")continue;const refs=[];const ndRegex=/<nd\b([^>]*)\/?>(?:<\/nd>)?/g;let nd;while((nd=ndRegex.exec(inner))){const a=xmlAttrs(nd[1]);if(a.ref)refs.push(a.ref);}if(!refs.length)continue;const ref=tags.ref||tags["stand:ref"]||tags["parking:ref"]||tags.name;if(!ref)continue;
    // Use the endpoint closest to the tagged ref/parking end. If the last node
    // is missing from the tile, try every member instead of dropping the stand.
    const members=refs.map(id=>nodes.get(id)).filter(Boolean);if(!members.length)continue;
    const last=members[members.length-1];const cat=String(tags["aircraft:reference_code"]||tags["aircraft:size"]||"").toUpperCase();
    output.push({osmId:`way:${m[1].match(/id="([^"]+)/)?.[1]||normalizeRef(ref)}`,ref:String(ref).trim(),lat:last.lat,lon:last.lon,kind:"parking_position",anchorType:"parking_position_way_endpoint",category:/^[ABCDEF]$/.test(cat)?cat:null,wayNodeCount:members.length});
  }
  return output;
}
async function fetchOsmTile(bbox){
  const key=bbox.map(v=>v.toFixed(6)).join(",");const cached=tileCache.get(key);if(cached&&Date.now()-cached.at<TILE_TTL)return cached.data;
  const [west,south,east,north]=bbox;const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),8000);
  try{const r=await fetch(`${OSM_MAP_URL}?bbox=${west},${south},${east},${north}`,{headers:{"User-Agent":"VATSIM-Gate-Finder/12.0","Accept":"application/xml"},signal:controller.signal});if(!r.ok)throw new Error(`OSM HTTP ${r.status}`);const data=parseOsmXml(await r.text());tileCache.set(key,{at:Date.now(),data});return data;}finally{clearTimeout(timeout);}
}
async function loadOsmPositions(icao){
  const bounds=await getAirportBounds(icao),tiles=makeTiles(bounds),settled=await Promise.allSettled(tiles.map(fetchOsmTile)),all=[];
  for(const r of settled)if(r.status==="fulfilled")all.push(...r.value);
  const unique=[];
  for(const p of all){const dup=unique.find(x=>normalizeRef(x.ref)===normalizeRef(p.ref)&&haversine(x.lat,x.lon,p.lat,p.lon)<8);if(!dup)unique.push(p);}
  return {bounds,positions:unique,failedTiles:settled.filter(x=>x.status==="rejected").length};
}

function choosePhysicalAnchor(ifatcGate,positions){
  let best=null;
  for(const p of positions){const score=referenceScore(ifatcGate.name,p.ref);if(score<100)continue;const typeBonus=p.kind==="parking_position"?60:0,endpointBonus=p.anchorType==="parking_position_way_endpoint"?10:0,total=score+typeBonus+endpointBonus;if(!best||total>best.score)best={p,score:total};}
  return best?.p||null;
}
function mergeGates(ifatcGates,positions){
  const output=[],used=new Set(),byRef=new Map();

  // One canonical IFATC card per stand reference.
  for(const g of ifatcGates){
    const key=normalizeRef(g.name);
    if(byRef.has(key))continue;
    const anchor=choosePhysicalAnchor(g,positions);
    const record={name:g.name,displayName:g.name,type:g.type,category:g.category,
      lat:anchor?.lat??null,lon:anchor?.lon??null,osmId:anchor?.osmId??null,
      anchorType:anchor?.anchorType??"none",anchorRef:anchor?.ref??null,
      source:anchor?"IFATC + OSM":"IFATC",gateAirlines:[],terminal:null,ruleLabel:null};
    byRef.set(key,record);output.push(record);
    if(anchor)used.add(anchor.osmId);
  }

  // OSM is fallback data only. Never add an OSM position if IFATC already
  // represents that reference or if it is physically the same stand.
  for(const p of positions){
    if(p.kind!=="parking_position"||used.has(p.osmId))continue;
    const key=normalizeRef(p.ref);
    if(byRef.has(key))continue;
    const nearby=output.find(g=>Number.isFinite(g.lat)&&Number.isFinite(g.lon)&&
      haversine(g.lat,g.lon,p.lat,p.lon)<12);
    if(nearby)continue;
    const record={name:p.ref,displayName:p.ref,type:"Standplatz",category:p.category,
      lat:p.lat,lon:p.lon,osmId:p.osmId,anchorType:p.anchorType,anchorRef:p.ref,
      source:"OSM",gateAirlines:[],terminal:null,ruleLabel:null};
    byRef.set(key,record);output.push(record);
  }

  // Final safety pass: same normalized reference OR essentially identical
  // physical position can only produce one visible gate.
  const final=[];
  for(const g of output){
    const refDup=final.find(x=>normalizeRef(x.name)===normalizeRef(g.name));
    if(refDup){
      if(refDup.source==="OSM"&&g.source!=="OSM")final[final.indexOf(refDup)]=g;
      continue;
    }
    const physicalDup=Number.isFinite(g.lat)&&Number.isFinite(g.lon)
      ?final.find(x=>Number.isFinite(x.lat)&&Number.isFinite(x.lon)&&
        haversine(x.lat,x.lon,g.lat,g.lon)<8):null;
    if(physicalDup){
      if(physicalDup.source==="OSM"&&g.source!=="OSM")final[final.indexOf(physicalDup)]=g;
      continue;
    }
    final.push(g);
  }
  final.sort((a,b)=>String(a.name).localeCompare(String(b.name),undefined,{numeric:true,sensitivity:"base"}));
  return final;
}

function airportRules(icao){return RULES.airports?.[icao]||null;}
function evaluateAirlineRule(g,icao,airline){
  const ar=airportRules(icao);if(!ar||!airline?.icao)return {allowed:true,airlines:[],terminal:null,label:null,reason:null};
  const matching=(ar.rules||[]).filter(r=>gateMatchesRule(g,r));
  const denied=(ar.deny||[]).some(r=>gateMatchesRule(g,r)&&Array.isArray(r.airlines)&&r.airlines.includes(airline.icao));
  if(denied)return {allowed:false,airlines:[],terminal:null,label:"Airport rule: airline not assigned here",reason:`${airline.icao} is not assigned to this stand/pier`};
  if(!matching.length)return {allowed:true,airlines:[],terminal:null,label:null,reason:null};
  // If any matching rule explicitly lists the airline, it is allowed. Empty airline
  // lists mean the area has no airline restriction, not "no airlines allowed".
  const allowedRule=matching.find(r=>Array.isArray(r.airlines)&&r.airlines.length===0)||matching.find(r=>r.airlines?.includes(airline.icao));
  if(allowedRule)return {allowed:true,airlines:matching.flatMap(r=>r.airlines||[]),terminal:allowedRule.id,label:allowedRule.label,reason:null};
  return {allowed:false,airlines:[...new Set(matching.flatMap(r=>r.airlines||[]))],terminal:matching[0].id,label:matching[0].label,reason:`${airline.icao} is not assigned to ${matching[0].label}`};
}
function evaluateGate(g,icao,airline,ac){
  const ar=airportRules(icao);const air=evaluateAirlineRule(g,icao,airline);let size=true,sizeReason=null;
  if(ac?.cat){const gateCat=g.category; if(gateCat && CAT_ORDER[ac.cat]>CAT_ORDER[gateCat]){size=false;sizeReason=`Aircraft Code ${ac.cat} exceeds stand Code ${gateCat}`;}}
  const compatible=air.allowed&&size;
  return {compatible,airlineAllowed:air.allowed,sizeAllowed:size,gateAirlines:air.airlines||[],terminal:air.terminal,ruleLabel:air.label,reason:air.reason||sizeReason,ruleSource:ar?"airport-rules.json":"generic"};
}

function radiusForPilot(p){const s=Number(p.groundspeed||0);return s<=2?PARKED_RADIUS:s<=8?SLOW_RADIUS:TAXI_RADIUS;}
function pilotIsRelevantAtAirport(pilot,bounds,icao){
  const lat=Number(pilot.latitude),lon=Number(pilot.longitude);if(!Number.isFinite(lat)||!Number.isFinite(lon))return false;
  // Slight padding catches VATSIM reference points just outside a tightly mapped OSM bbox.
  const padLat=.0035,padLon=.0055;
  if(lat<bounds.south-padLat||lat>bounds.north+padLat||lon<bounds.west-padLon||lon>bounds.east+padLon)return false;
  const fp=pilot.flight_plan||{},dep=String(fp.departure||"").toUpperCase(),arr=String(fp.arrival||"").toUpperCase(),gs=Number(pilot.groundspeed||0);
  if(dep!==icao&&arr!==icao&&gs>65)return false;
  return true;
}

// Stable one-to-one assignment: every aircraft proposes to its best stand; if
// two aircraft want the same stand, the lower-cost aircraft keeps it and the
// other retries its next-best stand. This fixes the greedy "nearest gate" swap bug.
function assignOccupancy(gates,icao,pilots,bounds){
  const options=new Map(), queue=[];
  for(const pilot of pilots){
    if(!pilotIsRelevantAtAirport(pilot,bounds,icao))continue;
    const lat=Number(pilot.latitude),lon=Number(pilot.longitude),radius=radiusForPilot(pilot),opts=[];
    for(let i=0;i<gates.length;i++){
      const g=gates[i];if(!Number.isFinite(g.lat)||!Number.isFinite(g.lon)||g.anchorType==="none")continue;
      const d=haversine(lat,lon,g.lat,g.lon);if(d>radius)continue;
      // Prefer physical parking positions; gate_node is a weaker fallback.
      const anchorPenalty=g.anchorType.startsWith("parking_position")?0:18;
      const speedPenalty=Math.max(0,Number(pilot.groundspeed||0))*0.55;
      opts.push({gateIndex:i,distance:d,cost:d+anchorPenalty+speedPenalty,radius});
    }
    opts.sort((a,b)=>a.cost-b.cost);if(!opts.length)continue;
    const id=String(pilot.cid||pilot.callsign||`${pilot.latitude}:${pilot.longitude}`);
    options.set(id,{pilot,opts,next:0});queue.push(id);
  }
  const gateOwner=new Map(),assigned=new Map();
  while(queue.length){
    const id=queue.shift(),item=options.get(id);if(!item||item.next>=item.opts.length)continue;
    const proposal=item.opts[item.next++],old=gateOwner.get(proposal.gateIndex);
    if(!old){gateOwner.set(proposal.gateIndex,id);assigned.set(id,proposal);continue;}
    const oldProposal=assigned.get(old);
    if(proposal.cost<oldProposal.cost){
      gateOwner.set(proposal.gateIndex,id);assigned.set(id,proposal);assigned.delete(old);queue.push(old);
    }else queue.push(id);
  }
  const out=[];
  for(const [id,proposal] of assigned){const p=options.get(id).pilot;const acRaw=p.flight_plan?.aircraft_short||p.flight_plan?.aircraft||"";out.push({gateIndex:proposal.gateIndex,callsign:p.callsign,airline:airlineFromCallsign(p.callsign),aircraft:normalizeAircraft(acRaw),cid:p.cid,distanceM:Math.round(proposal.distance),radiusM:Math.round(proposal.radius),groundspeed:Number(p.groundspeed||0),altitude:Number(p.altitude||0),latitude:Number(p.latitude),longitude:Number(p.longitude),assignmentCost:Math.round(proposal.cost)});}
  return out;
}

async function getVatsimPilots(){
  if(Date.now()-vatsimCache.at<VATSIM_TTL)return vatsimCache.pilots;
  const r=await fetch(VATSIM_URL,{headers:{"User-Agent":"VATSIM-Gate-Finder/12.0","Accept":"application/json"}});if(!r.ok)throw new Error(`VATSIM HTTP ${r.status}`);const data=await r.json();vatsimCache={at:Date.now(),pilots:Array.isArray(data.pilots)?data.pilots:[]};return vatsimCache.pilots;
}

app.get("/api/airlines",(req,res)=>res.json({airlines:Object.entries(RULES.airlines).map(([icao,x])=>({icao,name:x.name,aliases:x.aliases}))}));
app.get("/api/health",(req,res)=>res.json({ok:true,version:"12.0",serverTime:new Date().toISOString(),vatsimFeedAgeSeconds:vatsimCache.at?Math.round((Date.now()-vatsimCache.at)/1000):null,airlineDatabase:Object.keys(RULES.airlines).length,airportRuleDatabase:Object.keys(RULES.airports||{}).length,gateCacheSize:gateCache.size,occupancy:{parked:PARKED_RADIUS,slow:SLOW_RADIUS,taxi:TAXI_RADIUS}}));

app.get("/api/gates",async(req,res)=>{
  const icao=String(req.query.icao||"").trim().toUpperCase(),airline=normalizeAirline(req.query.airline||""),aircraft=normalizeAircraft(req.query.aircraft||"");
  if(!/^[A-Z0-9]{4}$/.test(icao))return res.status(400).json({error:"Bitte einen gültigen 4-stelligen ICAO-Code eingeben."});
  try{
    let gateData=gateCache.get(icao)?.data;
    if(!gateData||Date.now()-gateCache.get(icao).at>=GATE_TTL){
      const [i,o]=await Promise.allSettled([loadIfatc(icao),loadOsmPositions(icao)]);
      const ifatc=i.status==="fulfilled"?i.value.gates:[],osm=o.status==="fulfilled"?o.value:null;
      if(!ifatc.length&&!osm?.positions?.length)return res.status(502).json({error:`Gate-Daten für ${icao} konnten nicht geladen werden.`,details:{ifatc:i.reason?.message||null,osm:o.reason?.message||null}});
      gateData={source:ifatc.length&&osm?.positions?.length?"IFATC + OSM":ifatc.length?"IFATC":"OSM",bounds:osm?.bounds||null,gates:mergeGates(ifatc,osm?.positions||[]),failedOsmTiles:osm?.failedTiles||0,at:new Date().toISOString()};
      gateCache.set(icao,{at:Date.now(),data:gateData});
    }
    const pilots=await getVatsimPilots().catch(e=>{console.warn("[VATSIM]",e.message);return [];});
    const occupancy=gateData.bounds?assignOccupancy(gateData.gates,icao,pilots,gateData.bounds):[];
    const occupiedMap=new Map(occupancy.map(x=>[x.gateIndex,x]));
    const gates=gateData.gates.map((g,i)=>{
      const occ=occupiedMap.get(i)||null,fit=evaluateGate(g,icao,airline,aircraft);
      return {...g,...fit,occupied:Boolean(occ),available:Boolean(fit.compatible&&!occ),status:occ?"occupied":fit.compatible?"available":"incompatible",occupant:occ};
    });
    // Requested airline should affect sorting, but never hide occupied stands.
    gates.sort((a,b)=>{const rank=x=>x.status==="available"?0:x.status==="occupied"?1:2;return rank(a)-rank(b)||String(a.name).localeCompare(String(b.name),undefined,{numeric:true});});
    const inside=pilots.filter(p=>gateData.bounds&&pilotIsRelevantAtAirport(p,gateData.bounds,icao));
    const knownAtAirport=[...new Map(inside.map(p=>{const a=airlineFromCallsign(p.callsign);return [a.icao,a];})).values()].sort((a,b)=>a.name.localeCompare(b.name));
    res.setHeader("Cache-Control","no-store");
    res.json({version:"12.0",icao,source:gateData.source,airportRules:airportRules(icao)?.name||null,airportBounds:gateData.bounds,requestedAirline:airline.icao?airline:null,requestedAircraft:req.query.aircraft?aircraft:null,aircraftInfo:req.query.aircraft?aircraft:null,gateCacheCreatedAt:gateData.at,airlinesKnownAtAirport:knownAtAirport,totals:{gates:gates.length,available:gates.filter(g=>g.available).length,occupied:gates.filter(g=>g.occupied).length,incompatible:gates.filter(g=>!g.compatible).length,assignedAircraft:occupancy.length},debug:{physicalAnchors:gates.filter(g=>Number.isFinite(g.lat)&&Number.isFinite(g.lon)).length,unanchored:gates.filter(g=>!Number.isFinite(g.lat)||!Number.isFinite(g.lon)).length,VATSIMAircraftInsideAirportBounds:inside.length,assignedAircraft:occupancy.length,unassignedInsideAirport:Math.max(0,inside.length-occupancy.length),assignments:occupancy,failedOsmTiles:gateData.failedOsmTiles},vatsimUpdatedAt:vatsimCache.at?new Date(vatsimCache.at).toISOString():null,gates});
  }catch(error){console.error(error);res.status(502).json({error:"Gate-Daten konnten gerade nicht abgerufen werden.",details:error.name==="AbortError"?"OpenStreetMap request timeout":error.message});}
});
app.get("/api/refresh/:icao",(req,res)=>{const icao=String(req.params.icao||"").trim().toUpperCase();gateCache.delete(icao);ifatcCache.delete(icao);airportBoundsCache.delete(icao);res.json({ok:true,icao,cacheCleared:true});});
app.listen(PORT,"0.0.0.0",()=>console.log(`VATSIM Gate Finder v11 listening on ${PORT}`));
