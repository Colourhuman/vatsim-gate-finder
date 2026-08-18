const express=require("express");
const app=express();
const PORT=process.env.PORT||10000;
app.use(express.static(__dirname));
app.use(express.json());

const VATSIM_URL="https://data.vatsim.net/v3/vatsim-data.json";
const NOMINATIM_URL=icao=>`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=&q=${encodeURIComponent(icao+" airport")}`;
const OSM_MAP_URL="https://api.openstreetmap.org/api/0.6/map";
const IFATC_URL=icao=>`https://www.ifatc.org/gates?code=${encodeURIComponent(icao)}`;
const IFATC_TTL=24*60*60*1000;
const ifatcCache=new Map();

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

const AIRLINES = {
  EWG:"Eurowings",DLH:"Lufthansa",CFG:"Condor",RYR:"Ryanair",WZZ:"Wizz Air",
  EZY:"easyJet",TUI:"TUI fly",AUA:"Austrian Airlines",SWR:"SWISS",KLM:"KLM",
  AFR:"Air France",BAW:"British Airways",TAP:"TAP Air Portugal",SAS:"SAS",
  LOT:"LOT Polish Airlines",FIN:"Finnair",UAE:"Emirates",QTR:"Qatar Airways",
  SIA:"Singapore Airlines",THY:"Turkish Airlines",ACA:"Air Canada",DAL:"Delta Air Lines",
  UAL:"United Airlines",AAL:"American Airlines",VIR:"Virgin Atlantic",
  IBE:"Iberia",VLG:"Vueling",IBB:"IBERIA Express",TAR:"TAROM",BEL:"Brussels Airlines",
  SWU:"Air Europa",TVS:"Smartwings",TRA:"Transavia",NAX:"Norwegian",
  SAS:"SAS Scandinavian Airlines",AZA:"ITA Airways",ITY:"ITA Airways"
};
const AIRPORT_RULES={
 EDDK:{A:["DLH","AUA","SWR","LOT","TAP","SAS","FIN","THY","ACA","UAL","EWG"],B:["DLH","AUA","SWR","LOT","TAP","SAS","FIN","THY","ACA","UAL","EWG"],C:["DLH","AUA","SWR","LOT","TAP","SAS","FIN","THY","ACA","UAL","EWG"],D:"NON_STAR",E:["FDX","GEC","DAN","UPS"],F:["FDX","GEC","DAN","UPS"],W:["FDX","GEC","DAN","UPS"]},
 EDDF:{A:["DLH","AUA","TAP","AEE","SWR","UAL"],B:"STAR_NON_SCHENGEN",C:"STAR_NON_SCHENGEN",D:"T2_NON_STAR",E:"T2_NON_STAR",F:"MIXED",J:["CAL","CES","CPA","CSN","ETD","GFA","KAC","KAL","OMA","QTR","SVA","TWB","UAE"]},
 EDDL:{A:["DLH","AUA","SWR","LOT","TAP","SAS","FIN","THY","ACA","UAL"],B:"SCHENGEN",C:"NON_SCHENGEN"}
};
const STAR_ALLIANCE=new Set(["DLH","AUA","SWR","LOT","TAP","SAS","FIN","THY","ACA","UAL","SIA","ANA","THA","ETH","AEE","CCA"]);
function verifiedAirlineRule(icao,ref,selected){
 if(!selected)return {state:"unknown",label:"Airline nicht ausgewählt"};
 const rules=AIRPORT_RULES[icao];if(!rules)return {state:"unknown",label:"Keine verifizierte Airline-Regel"};
 const area=(String(ref||"").match(/^[A-Z]+/i)||[""])[0].toUpperCase(),rule=rules[area];
 if(!rule)return {state:"unknown",label:"Für diesen Stand keine verifizierte Airline-Regel"};
 if(Array.isArray(rule))return rule.includes(selected)?{state:"match",label:"typische Nutzung bestätigt"}:{state:"mismatch",label:"nicht in dieser Airline-Gruppe"};
 if(rule==="NON_STAR")return STAR_ALLIANCE.has(selected)?{state:"mismatch",label:"Terminal 2: Non-Star"}:{state:"match",label:"Terminal 2: Non-Star"};
 if(rule==="T2_NON_STAR")return STAR_ALLIANCE.has(selected)?{state:"mismatch",label:"Terminal 2: überwiegend Non-Star"}:{state:"match",label:"Terminal 2: überwiegend Non-Star"};
 if(rule==="STAR_NON_SCHENGEN")return STAR_ALLIANCE.has(selected)?{state:"match",label:"Star Alliance / Non-Schengen"}:{state:"unknown",label:"Schengen-Status fehlt"};
 if(rule==="SCHENGEN"||rule==="NON_SCHENGEN")return {state:"unknown",label:"Schengen-Status des Fluges fehlt"};
 return {state:"unknown",label:"gemischte/nicht verifizierte Nutzung"};
}
function normalizeAirline(v){
  const raw=String(v||"").trim().toUpperCase();
  if(!raw)return "";
  if(AIRLINES[raw])return raw;
  const hit=Object.entries(AIRLINES).find(([k,n])=>n.toUpperCase()===raw);
  return hit?hit[0]:raw;
}
function airlineMatches(tags, selected){
  if(!selected)return null;
  const raw=String(tags||"").toUpperCase();
  if(!raw)return null; // unknown, not false
  const aliases={
    EWG:["EWG","EW","EUROWINGS"],DLH:["DLH","LH","LUFTHANSA"],CFG:["CFG","DE","CONDOR"],
    RYR:["RYR","FR","RYANAIR"],WZZ:["WZZ","W6","WIZZAIR"],EZY:["EZY","U2","EASYJET"],
    TUI:["TUI","X3","TUIFLY"],AUA:["AUA","OS"],SWR:["SWR","LX"],KLM:["KLM","KL"],
    AFR:["AFR","AF"],BAW:["BAW","BA"],TAP:["TAP","TP"],SAS:["SAS","SK"],
    LOT:["LOT","LO"],FIN:["FIN","AY"],UAE:["UAE","EK"],QTR:["QTR","QR"],
    SIA:["SIA","SQ"],THY:["THY","TK"],ACA:["ACA","AC"],DAL:["DAL","DL"],
    UAL:["UAL","UA"],AAL:["AAL","AA"],VIR:["VIR","VS"],IBE:["IBE","IB"],
    VLG:["VLG","VY"],BEL:["BEL","SN"],TRA:["TRA","HV"],NAX:["NAX","DY"],
    AZA:["AZA","AZ"],ITY:["ITY","AZ"]
  };
  const wanted=aliases[selected]||[selected];
  return wanted.some(x=>raw.split(/[;,|/\\s]+/).includes(x)) ||
         wanted.some(x=>raw.includes(x));
}
function extractGateRef(name){const m=String(name||"").trim().match(/(?:^|[\\s-])([A-Z]{0,2}\\d+[A-Z]{0,2})$/i);return m?m[1].toUpperCase():null;}
function parseIfatc(html){
 const rows=html.match(/<tr[\s\S]*?<\/tr>/gi)||[],map=new Map();
 for(const row of rows){
  const cells=(row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi)||[]).map(cleanHtml);
  if(cells.length<3)continue;const cls=String(cells[cells.length-1]).trim().toUpperCase(),ref=extractGateRef(cells[0]);
  if(!/^[ABCDEF]$/.test(cls)||!ref)continue;map.set(normalizeRef(ref),{ifatcClass:cls,ifatcName:cells[0]});
 }
 return map;
}
async function loadIfatc(icao){
 const c=ifatcCache.get(icao);if(c&&Date.now()-c.at<IFATC_TTL)return c.data;
 const r=await fetch(IFATC_URL(icao),{headers:{"User-Agent":"VATSIM-Gate-Finder/15.0","Accept":"text/html"}});
 if(!r.ok)throw new Error(`IFATC HTTP ${r.status}`);const data=parseIfatc(await r.text());ifatcCache.set(icao,{at:Date.now(),data});return data;
}
const CLASS_DESC={A:"Code A · <15 m",B:"Code B · <24 m",C:"Code C · max. ca. 36 m",D:"Code D · max. ca. 52 m",E:"Code E · max. ca. 65 m",F:"Code F · max. ca. 80 m"};
function sizeLabel(g){
 if(g.ifatcClass)return CLASS_DESC[g.ifatcClass]||`Code ${g.ifatcClass}`;
 if(g.size)return `ICAO Reference Code ${g.size}`;
 if(Number.isFinite(g.maxWingspan))return `max. Spannweite ${g.maxWingspan} m`;
 return "Größe nicht verifiziert";
}

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
  const cat=String(n.tags["aircraft:reference_code"]||n.tags["aircraft:size"]||n.tags["aircraft:category"]||"").toUpperCase();
  const span=Number(n.tags["aircraft:max_wingspan"]||n.tags["max_wingspan"]||"");
  const airlineTags=[n.tags.airline,n.tags.operator,n.tags.owner,n.tags["airline:icao"],n.tags["operator:icao"]].filter(Boolean).join(";");
  out.push({id:`n:${n.id}`,ref:String(ref).trim(),lat:n.lat,lon:n.lon,
   kind:"parking_position",size:/^[ABCDEF]$/.test(cat)?cat:null,
   maxWingspan:Number.isFinite(span)&&span>0?span:null,airlineTags});
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
  const cat=String(t["aircraft:reference_code"]||t["aircraft:size"]||t["aircraft:category"]||"").toUpperCase();
  const span=Number(t["aircraft:max_wingspan"]||t["max_wingspan"]||"");
  const airlineTags=[t.airline,t.operator,t.owner,t["airline:icao"],t["operator:icao"]].filter(Boolean).join(";");
  out.push({id:`w:${m[1]||refs[refs.length-1]}`,ref:String(ref).trim(),lat:last.lat,lon:last.lon,
   kind:"parking_position",size:/^[ABCDEF]$/.test(cat)?cat:null,
   maxWingspan:Number.isFinite(span)&&span>0?span:null,airlineTags});
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
 const r=await fetch(NOMINATIM_URL(icao),{headers:{"User-Agent":"VATSIM-Gate-Finder/15.0"}});
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
  const r=await fetch(`${OSM_MAP_URL}?bbox=${w},${s},${e},${n}`,{headers:{"User-Agent":"VATSIM-Gate-Finder/15.0","Accept":"application/xml"},signal:controller.signal});
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
  if(!dup.size&&p.size)Object.assign(dup,{size:p.size,sizeLabel:p.sizeLabel});
  if(!dup.maxWingspan&&p.maxWingspan)dup.maxWingspan=p.maxWingspan;
  if(!dup.airlineTags&&p.airlineTags)dup.airlineTags=p.airlineTags;
 }
 unique.sort((a,b)=>String(a.ref).localeCompare(String(b.ref),undefined,{numeric:true}));
 return {bounds:b,positions:unique};
}
async function vatsim(){
 if(Date.now()-vatsimCache.at<VATSIM_TTL)return vatsimCache.pilots;
 const r=await fetch(VATSIM_URL,{headers:{"User-Agent":"VATSIM-Gate-Finder/15.0"}});
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
function aircraftFitsClass(span,cls){const max={A:15,B:24,C:36,D:52,E:65,F:80}[cls];return Number.isFinite(span)&&max?span<=max:null;}
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
app.get("/api/airlines",(req,res)=>res.json({airlines:Object.entries(AIRLINES).map(([icao,name])=>({icao,name}))}));
app.get("/api/health",(q,res)=>res.json({ok:true,version:"15.0",vatsimFeedAgeSeconds:vatsimCache.at?Math.round((Date.now()-vatsimCache.at)/1000):null}));
app.get("/api/gates",async(req,res)=>{
 const icao=String(req.query.icao||"").trim().toUpperCase(),airline=normalizeAirline(req.query.airline||""),aircraftInput=String(req.query.aircraft||"").trim();
 if(!/^[A-Z0-9]{4}$/.test(icao))return res.status(400).json({error:"Bitte einen gültigen 4-stelligen ICAO-Code eingeben."});
 try{
  let data=gateCache.get(icao);if(!data||Date.now()-data.at>OSM_TTL){data=await loadPositions(icao);data.at=Date.now();gateCache.set(icao,data);}
  let sizeMap=new Map();try{sizeMap=await loadIfatc(icao)}catch(e){console.warn("IFATC size enrichment:",e.message)}
  const enriched=data.positions.map(g=>({...g,...(sizeMap.get(normalizeRef(g.ref))||{})}));
  const pilots=await vatsim().catch(()=>[]),occ=occupancy(enriched,pilots,data.bounds),map=new Map(occ.map(x=>[x.gateIndex,x])),requestedAircraft=normalizeAircraft(aircraftInput);
  const gates=enriched.map((g,i)=>{const o=map.get(i)||null,rule=verifiedAirlineRule(icao,g.ref,airline);return {...g,occupied:!!o,status:o?"occupied":"available",occupant:o,airlineMatch:rule.state,airlineRuleLabel:rule.label,aircraftMatch:requestedAircraft.span&&g.ifatcClass?aircraftFitsClass(requestedAircraft.span,g.ifatcClass):null,sizeLabel:sizeLabel(g)};});
  res.json({version:"15.0",icao,source:"OSM parking positions + IFATC exact-reference size class + VATSIM live data",airlines:Object.entries(AIRLINES).map(([icao,name])=>({icao,name})),requestedAirline:airline||null,requestedAircraft:aircraftInput||null,aircraftInfo:requestedAircraft,bounds:data.bounds,totals:{gates:gates.length,available:gates.filter(x=>!x.occupied).length,occupied:occ.length},vatsimUpdatedAt:vatsimCache.at?new Date(vatsimCache.at).toISOString():null,debug:{aircraftInsideAirport:pilots.filter(p=>inside(p,data.bounds)).length,assignedAircraft:occ.length,sizeEnrichedGates:gates.filter(g=>g.ifatcClass).length},gates});
 }catch(e){console.error(e);res.status(502).json({error:"Gate-Daten konnten nicht geladen werden.",details:e.message});}
});
app.get("/api/refresh/:icao",(req,res)=>{
 const i=String(req.params.icao||"").toUpperCase();gateCache.delete(i);airportCache.delete(i);
 for(const k of osmCache.keys())osmCache.delete(k);
 res.json({ok:true,icao:i});
});
app.listen(PORT,"0.0.0.0",()=>console.log(`VATSIM Gate Finder v13 listening on ${PORT}`));
