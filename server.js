const express=require("express");
const app=express();
const PORT=process.env.PORT||10000;
app.use(express.static(__dirname));
app.use(express.json());

const VATSIM_URL="https://data.vatsim.net/v3/vatsim-data.json";
const NOMINATIM_URL=icao=>`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=&q=${encodeURIComponent(icao+" airport")}`;
const OSM_MAP_URL="https://api.openstreetmap.org/api/0.6/map";

const VATSIM_TTL=10_000;
const AIRPORT_TTL=24*60*60*1000;
const OSM_TTL=7*24*60*60*1000;

const airportCache=new Map();
const osmCache=new Map();
let vatsimCache={at:0,pilots:[]};

const AIRCRAFT={
 A318:{span:34.1},A319:{span:35.8},A320:{span:35.8},A20N:{span:35.8},
 A321:{span:35.8},A21N:{span:35.8},B737:{span:35.8},B738:{span:35.8},
 B38M:{span:35.9},B39M:{span:35.9},E170:{span:26.0},E175:{span:28.7},
 E190:{span:28.7},E195:{span:28.7},E290:{span:33.7},E295:{span:33.7},
 CRJ7:{span:26.2},CRJ9:{span:26.2},CRJX:{span:26.2},DH8D:{span:28.4},
 AT72:{span:27.1},B752:{span:38.5},B753:{span:38.5},A300:{span:44.8},
 A310:{span:44.8},A332:{span:60.3},A333:{span:60.3},A339:{span:64.0},
 A359:{span:64.8},A35K:{span:64.8},B762:{span:47.6},B763:{span:51.8},
 B764:{span:51.8},B772:{span:60.9},B77L:{span:64.8},B77W:{span:64.8},
 B788:{span:60.1},B789:{span:60.1},B78X:{span:60.1},B744:{span:64.4},
 B748:{span:68.4},A388:{span:79.8}
};
const TYPE_MAP={
"318":"A318","319":"A319","320":"A320","32N":"A20N","321":"A321","32Q":"A21N",
"737":"B737","738":"B738","7M8":"B38M","7M9":"B39M","170":"E170","175":"E175",
"190":"E190","195":"E195","290":"E290","295":"E295","CR7":"CRJ7","CR9":"CRJ9",
"DH4":"DH8D","AT7":"AT72","752":"B752","75Y":"B753","AB6":"A300","310":"A310",
"332":"A332","333":"A333","339":"A339","359":"A359","351":"A35K","762":"B762",
"763":"B763","764":"B764","772":"B772","77L":"B77L","77W":"B77W","788":"B788",
"789":"B789","781":"B78X","744":"B744","74H":"B748","388":"A388","380":"A388"
};

function normalizeAircraft(v){
 const raw=String(v||"").split("/")[0].trim().toUpperCase();
 const icao=TYPE_MAP[raw]||raw;
 return {icao,span:AIRCRAFT[icao]?.span??null,name:icao||"Unknown"};
}
function normalizeRef(v){
 return String(v||"").toUpperCase().replace(/[\s\-–—_]/g,"");
}
function haversine(a,b,c,d){
 const R=6371000,p=Math.PI/180,dl=(c-a)*p,do_=(d-b)*p;
 const x=Math.sin(dl/2)**2+Math.cos(a*p)*Math.cos(c*p)*Math.sin(do_/2)**2;
 return 2*R*Math.asin(Math.sqrt(x));
}
function attrs(s){
 const o={},r=/([A-Za-z_:][\w:.-]*)="([^"]*)"/g;let m;
 while((m=r.exec(s)))o[m[1]]=m[2];
 return o;
}
function tags(block){
 const o={},r=/<tag\b([^>]*)\/?>/g;let m;
 while((m=r.exec(block))){const a=attrs(m[1]);if(a.k)o[a.k]=a.v||"";}
 return o;
}
function parseOsm(xml){
 const nodes=new Map(),out=[];
 const nr=/<node\b([^>]*?)(?:\/>|>([\s\S]*?)<\/node>)/g;let m;
 while((m=nr.exec(xml))){
  const a=attrs(m[1]||""),lat=+a.lat,lon=+a.lon;
  if(!a.id||!Number.isFinite(lat)||!Number.isFinite(lon))continue;
  nodes.set(a.id,{id:a.id,lat,lon,tags:tags(m[2]||"")});
 }
 for(const n of nodes.values()){
  if(n.tags.aeroway!=="parking_position")continue;
  const ref=n.tags.ref||n.tags["stand:ref"]||n.tags["parking:ref"]||n.tags.name;
  if(!ref)continue;
  const cat=String(n.tags["aircraft:reference_code"]||n.tags["aircraft:size"]||"").toUpperCase();
  out.push({id:`n:${n.id}`,ref:String(ref).trim(),lat:n.lat,lon:n.lon,
   kind:"parking_position",size:/^[ABCDEF]$/.test(cat)?cat:null});
 }
 const wr=/<way\b([^>]*)>([\s\S]*?)<\/way>/g;
 while((m=wr.exec(xml))){
  const inner=m[2]||"",t=tags(inner);
  if(t.aeroway!=="parking_position")continue;
  const refs=[],nd=/<nd\b([^>]*)\/?>/g;let x;
  while((x=nd.exec(inner))){const a=attrs(x[1]);if(a.ref)refs.push(a.ref);}
  const ref=t.ref||t["stand:ref"]||t["parking:ref"]||t.name;
  const last=nodes.get(refs[refs.length-1]);
  if(!ref||!last)continue;
  const cat=String(t["aircraft:reference_code"]||t["aircraft:size"]||"").toUpperCase();
  out.push({id:`w:${m[1]||refs[refs.length-1]}`,ref:String(ref).trim(),lat:last.lat,lon:last.lon,
   kind:"parking_position",size:/^[ABCDEF]$/.test(cat)?cat:null});
 }
 return out;
}
function tileBboxes(b){
 const latStep=.01, c=Math.max(.2,Math.cos(((b.south+b.north)/2)*Math.PI/180)),lonStep=latStep/c, a=[];
 for(let lat=b.south;lat<b.north;lat+=latStep)for(let lon=b.west;lon<b.east;lon+=lonStep)
  a.push([lon,lat,Math.min(lon+lonStep,b.east),Math.min(lat+latStep,b.north)]);
 return a;
}
async function airportBounds(icao){
 const c=airportCache.get(icao);
 if(c&&Date.now()-c.at<AIRPORT_TTL)return c.data;
 const r=await fetch(NOMINATIM_URL(icao),{headers:{"User-Agent":"VATSIM-Gate-Finder/13.0"}});
 if(!r.ok)throw new Error(`Airport lookup HTTP ${r.status}`);
 const rs=await r.json();
 const e=rs.find(x=>x.boundingbox && (/aerodrome|airport/i.test(x.type||"")||/aeroway/i.test(x.class||"")))||rs.find(x=>x.boundingbox);
 if(!e)throw new Error(`Kein Airport-Datensatz für ${icao}`);
 const bb=e.boundingbox.map(Number);
 const data={south:bb[0]-.002,north:bb[1]+.002,west:bb[2]-.002,east:bb[3]+.002};
 airportCache.set(icao,{at:Date.now(),data});return data;
}
async function osmTile(bb){
 const key=bb.join(",");
 const c=osmCache.get(key);if(c&&Date.now()-c.at<OSM_TTL)return c.data;
 const [w,s,e,n]=bb,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),7000);
 try{
  const r=await fetch(`${OSM_MAP_URL}?bbox=${w},${s},${e},${n}`,{headers:{"User-Agent":"VATSIM-Gate-Finder/13.0","Accept":"application/xml"},signal:controller.signal});
  if(!r.ok)throw new Error(`OSM HTTP ${r.status}`);
  const data=parseOsm(await r.text());osmCache.set(key,{at:Date.now(),data});return data;
 }finally{clearTimeout(timer);}
}
async function loadPositions(icao){
 const b=await airportBounds(icao),rs=await Promise.allSettled(tileBboxes(b).map(osmTile)),all=[];
 for(const r of rs)if(r.status==="fulfilled")all.push(...r.value);
 // One physical stand only. Reference is primary; proximity is the fallback.
 const unique=[];
 for(const p of all){
  const dup=unique.find(x=>normalizeRef(x.ref)===normalizeRef(p.ref) || haversine(x.lat,x.lon,p.lat,p.lon)<7);
  if(!dup){unique.push(p);continue;}
  // Prefer a node/way with an explicit size tag over an untyped duplicate.
  if(!dup.size&&p.size)Object.assign(dup,p);
 }
 unique.sort((a,b)=>String(a.ref).localeCompare(String(b.ref),undefined,{numeric:true}));
 return {bounds:b,positions:unique};
}
async function vatsim(){
 if(Date.now()-vatsimCache.at<VATSIM_TTL)return vatsimCache.pilots;
 const r=await fetch(VATSIM_URL,{headers:{"User-Agent":"VATSIM-Gate-Finder/13.0"}});
 if(!r.ok)throw new Error(`VATSIM HTTP ${r.status}`);
 const d=await r.json();vatsimCache={at:Date.now(),pilots:Array.isArray(d.pilots)?d.pilots:[]};return vatsimCache.pilots;
}
function inside(p,b){
 const lat=+p.latitude,lon=+p.longitude;
 return Number.isFinite(lat)&&Number.isFinite(lon)&&lat>=b.south&&lat<=b.north&&lon>=b.west&&lon<=b.east;
}
function occRadius(p){
 const gs=+p.groundspeed||0;
 if(gs<=2)return 80;
 if(gs<=8)return 55;
 if(gs<=20)return 30;
 return 18;
}
function occupancy(gates,pilots,b){
 const candidates=[];
 for(const p of pilots){
  if(!inside(p,b))continue;
  const lat=+p.latitude,lon=+p.longitude,r=occRadius(p);
  let best=null;
  for(let i=0;i<gates.length;i++){
   const g=gates[i];if(!Number.isFinite(g.lat)||!Number.isFinite(g.lon))continue;
   const d=haversine(lat,lon,g.lat,g.lon);if(d>r)continue;
   // For parked aircraft, distance is the only authoritative signal.
   if(!best||d<best.d)best={i,d,r};
  }
  if(best)candidates.push({p,...best});
 }
 // Global one-to-one assignment. Closest pair wins, so two aircraft cannot
 // make one stand appear twice and one aircraft cannot occupy two stands.
 candidates.sort((a,b)=>a.d-b.d);
 const usedP=new Set(),usedG=new Set(),out=[];
 for(const c of candidates){
  const id=String(c.p.cid||c.p.callsign);
  if(usedP.has(id)||usedG.has(c.i))continue;
  usedP.add(id);usedG.add(c.i);
  const ac=normalizeAircraft(c.p.flight_plan?.aircraft_short||c.p.flight_plan?.aircraft||"");
  out.push({gateIndex:c.i,callsign:c.p.callsign,cid:c.p.cid,aircraft:ac,
   airline:String(c.p.callsign||"").slice(0,3).toUpperCase(),distanceM:Math.round(c.d),
   radiusM:Math.round(c.r),groundspeed:+c.p.groundspeed||0,latitude:+c.p.latitude,longitude:+c.p.longitude});
 }
 return out;
}
const gateCache=new Map();
app.get("/api/health",(q,res)=>res.json({ok:true,version:"13.0",vatsimFeedAgeSeconds:vatsimCache.at?Math.round((Date.now()-vatsimCache.at)/1000):null}));
app.get("/api/gates",async(req,res)=>{
 const icao=String(req.query.icao||"").trim().toUpperCase();
 if(!/^[A-Z0-9]{4}$/.test(icao))return res.status(400).json({error:"Bitte einen gültigen 4-stelligen ICAO-Code eingeben."});
 try{
  let data=gateCache.get(icao);
  if(!data||Date.now()-data.at>OSM_TTL){
   data=await loadPositions(icao);data.at=Date.now();gateCache.set(icao,data);
  }
  const pilots=await vatsim().catch(()=>[]);
  const occ=occupancy(data.positions,pilots,data.bounds),map=new Map(occ.map(x=>[x.gateIndex,x]));
  const requestedAircraft=normalizeAircraft(req.query.aircraft||"");
  const gates=data.positions.map((g,i)=>{
   const o=map.get(i)||null;
   // No invented airline assignment. No invented gate size. OSM size is shown
   // only when OSM explicitly supplied an ICAO reference code.
   return {...g,occupied:!!o,status:o?"occupied":"available",occupant:o,
    sizeLabel:g.size?`ICAO Code ${g.size}`:"nicht angegeben"};
  });
  const filterAirline=String(req.query.airline||"").trim().toUpperCase();
  res.json({
   version:"13.0",icao,source:"OpenStreetMap parking positions + VATSIM live data",
   requestedAirline:filterAirline||null,requestedAircraft:req.query.aircraft||null,
   aircraftInfo:requestedAircraft,bounds:data.bounds,
   totals:{gates:gates.length,available:gates.filter(x=>!x.occupied).length,occupied:occ.length},
   vatsimUpdatedAt:vatsimCache.at?new Date(vatsimCache.at).toISOString():null,
   debug:{aircraftInsideAirport:pilots.filter(p=>inside(p,data.bounds)).length,assignedAircraft:occ.length},
   gates
  });
 }catch(e){console.error(e);res.status(502).json({error:"Gate-Daten konnten nicht geladen werden.",details:e.message});}
});
app.get("/api/refresh/:icao",(req,res)=>{
 const i=String(req.params.icao||"").toUpperCase();gateCache.delete(i);airportCache.delete(i);
 for(const k of osmCache.keys())osmCache.delete(k);
 res.json({ok:true,icao:i});
});
app.listen(PORT,"0.0.0.0",()=>console.log(`VATSIM Gate Finder v13 listening on ${PORT}`));
