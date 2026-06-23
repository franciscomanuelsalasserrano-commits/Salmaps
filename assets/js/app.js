import{saveDocument,listDocuments,deleteDocument}from'./db.js';
const $=s=>document.querySelector(s);const $$=s=>[...document.querySelectorAll(s)];
const state={settings:JSON.parse(localStorage.getItem('c2-settings')||'{"callsign":"Jefe de sección","unit":"Puesto de mando"}'),messages:JSON.parse(localStorage.getItem('c2-messages')||'[]'),markers:JSON.parse(localStorage.getItem('c2-markers')||'[]'),pendingMarker:null,watchId:null,userMarker:null,lastHeading:0,activeLayerKey:null};
const persist=(key,value)=>localStorage.setItem(key,JSON.stringify(value));

let map;
let activeMapLayer=null;
let mapRefreshTimer=null;
const SPAIN_BOUNDS=L.latLngBounds([25,-20],[46,6]);
const MAP_BG='#d8ddcf';
const MAP_VERSION='atak-detail-hidden-v10';
const EMPTY_TILE='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const MAP_LAYERS={
  ign:{
    label:'IGN topográfico',
    attribution:'© Instituto Geográfico Nacional / CNIG',
    base:{url:'https://www.ign.es/wms-inspire/mapa-raster',layers:'mtn_rasterizado',format:'image/png'},
    detail:'https://www.ign.es/wmts/mapa-raster?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=MTN&STYLE=default&TILEMATRIXSET=GoogleMapsCompatible&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg'
  },
  pnoa:{
    label:'Vista aérea PNOA',
    attribution:'© Instituto Geográfico Nacional / PNOA',
    base:{url:'https://www.ign.es/wms-inspire/pnoa-ma',layers:'OI.OrthoimageCoverage',format:'image/jpeg'},
    detail:'https://www.ign.es/wmts/pnoa-ma?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=OI.OrthoimageCoverage&STYLE=default&TILEMATRIXSET=GoogleMapsCompatible&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg'
  }
};

function initNav(){$$('.nav-btn').forEach(btn=>btn.addEventListener('click',()=>{const name=btn.dataset.view;$$('.nav-btn').forEach(x=>x.classList.toggle('active',x===btn));$$('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));if(name==='map')setTimeout(()=>{map?.invalidateSize(true);refreshMap('nav')},180)}))}
function updateNetwork(){const on=navigator.onLine;$('#onlineDot').className=`dot ${on?'on':'off'}`;$('#onlineText').textContent=on?'Con conexión':'Sin conexión';if(on)refreshMap('online')}
window.addEventListener('online',updateNetwork);window.addEventListener('offline',updateNetwork);

function clamp(n,min,max){return Math.max(min,Math.min(max,n))}
function boundsOK(bounds){return bounds&&Number.isFinite(bounds.getWest())&&Number.isFinite(bounds.getSouth())&&Number.isFinite(bounds.getEast())&&Number.isFinite(bounds.getNorth())&&bounds.getEast()>bounds.getWest()&&bounds.getNorth()>bounds.getSouth()}
function clampToSpain(bounds){
  const west=clamp(bounds.getWest(),SPAIN_BOUNDS.getWest(),SPAIN_BOUNDS.getEast());
  const east=clamp(bounds.getEast(),SPAIN_BOUNDS.getWest(),SPAIN_BOUNDS.getEast());
  const south=clamp(bounds.getSouth(),SPAIN_BOUNDS.getSouth(),SPAIN_BOUNDS.getNorth());
  const north=clamp(bounds.getNorth(),SPAIN_BOUNDS.getSouth(),SPAIN_BOUNDS.getNorth());
  if(east<=west||north<=south)return SPAIN_BOUNDS;
  return L.latLngBounds([south,west],[north,east]);
}
function expandedBounds(pad){
  const b=map.getBounds();
  const latPad=(b.getNorth()-b.getSouth())*pad;
  const lngPad=(b.getEast()-b.getWest())*pad;
  return clampToSpain(L.latLngBounds([b.getSouth()-latPad,b.getWest()-lngPad],[b.getNorth()+latPad,b.getEast()+lngPad]));
}
function mercatorBbox(bounds){
  const sw=map.options.crs.project(bounds.getSouthWest());
  const ne=map.options.crs.project(bounds.getNorthEast());
  return [sw.x,sw.y,ne.x,ne.y].map(v=>Number(v).toFixed(2)).join(',');
}
function makeWmsUrl(base,bounds,width,height,reason){
  const params=new URLSearchParams({
    SERVICE:'WMS',VERSION:'1.1.1',REQUEST:'GetMap',LAYERS:base.layers,STYLES:'',SRS:'EPSG:3857',
    BBOX:mercatorBbox(bounds),WIDTH:String(Math.round(width)),HEIGHT:String(Math.round(height)),
    FORMAT:base.format||'image/png',TRANSPARENT:'FALSE',BGCOLOR:'0xD8DDCF',_:`${MAP_VERSION}-${reason}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  });
  return `${base.url}?${params.toString()}`;
}
function preloadImage(src,timeout=18000){
  return new Promise((resolve,reject)=>{
    const img=new Image();let done=false;
    const finish=ok=>{if(done)return;done=true;clearTimeout(timer);ok?resolve(img):reject(new Error('No cargó imagen'))};
    const timer=setTimeout(()=>finish(false),timeout);
    img.onload=()=>finish(img.naturalWidth>20&&img.naturalHeight>20);
    img.onerror=()=>finish(false);
    img.decoding='async';img.loading='eager';img.referrerPolicy='no-referrer-when-downgrade';img.src=src;
  });
}
function tileUrl(template,x,y,z){return template.replace(/\{z\}/g,z).replace(/\{x\}/g,x).replace(/\{y\}/g,y)}
function preloadTile(src,timeout=11000){
  return new Promise(resolve=>{
    const img=new Image();let done=false;
    const finish=ok=>{if(done)return;done=true;clearTimeout(timer);if(!ok)img.src=EMPTY_TILE;resolve(img)};
    const timer=setTimeout(()=>finish(false),timeout);
    img.onload=()=>finish(img.naturalWidth>1&&img.naturalHeight>1);
    img.onerror=()=>finish(false);
    img.decoding='async';img.loading='eager';img.referrerPolicy='no-referrer-when-downgrade';img.src=src;
  });
}
function tileBounds(x,y,z){
  const s=256;
  const nw=map.unproject(L.point(x*s,y*s),z);
  const se=map.unproject(L.point((x+1)*s,(y+1)*s),z);
  return L.latLngBounds(se,nw);
}
function tilesForBounds(bounds,z,maxTiles=96){
  const s=256;
  const nw=map.project(bounds.getNorthWest(),z).divideBy(s).floor();
  const se=map.project(bounds.getSouthEast(),z).divideBy(s).floor();
  const max=Math.pow(2,z)-1;
  const minX=clamp(nw.x,0,max),maxX=clamp(se.x,0,max),minY=clamp(nw.y,0,max),maxY=clamp(se.y,0,max);
  const tiles=[];
  for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++)tiles.push({x,y,z,bounds:tileBounds(x,y,z)});
  if(tiles.length<=maxTiles)return tiles;
  const center=map.project(map.getCenter(),z).divideBy(s);
  return tiles.sort((a,b)=>(Math.hypot(a.x-center.x,a.y-center.y)-Math.hypot(b.x-center.x,b.y-center.y))).slice(0,maxTiles);
}

class AtakMapLayer{
  constructor(config){
    this.config=config;this.map=null;this.overview=null;this.base=null;this.activeDetail=null;this.loadingDetail=null;this.overviewSeq=0;this.baseSeq=0;this.detailSeq=0;this.timer=null;this.pendingReason='inicio';
    this.onPosition=()=>this.positionSnapshots();
    this.onBaseRefresh=()=>this.schedule('mover',120);
    this.onZoomRefresh=()=>this.schedule('zoom',40);
    this.onResize=()=>this.schedule('resize',150);
  }
  addTo(mapInstance){
    this.map=mapInstance;
    this.loadOverview('inicio');
    this.refreshBase('inicio');
    this.refreshDetail('inicio');
    this.map.on('move zoom resize viewreset',this.onPosition);
    this.map.on('moveend',this.onBaseRefresh);
    this.map.on('zoomend',this.onZoomRefresh);
    this.map.on('resize',this.onResize);
    return this;
  }
  remove(){
    clearTimeout(this.timer);this.overviewSeq++;this.baseSeq++;this.detailSeq++;
    if(this.map){this.map.off('move zoom resize viewreset',this.onPosition);this.map.off('moveend',this.onBaseRefresh);this.map.off('zoomend',this.onZoomRefresh);this.map.off('resize',this.onResize)}
    [this.overview,this.base,this.activeDetail,this.loadingDetail].forEach(l=>{if(!l)return;if(l.container){try{l.container.remove()}catch(e){}}else if(this.map){try{this.map.removeLayer(l)}catch(e){}}});
    this.map=null;this.overview=null;this.base=null;this.activeDetail=null;this.loadingDetail=null;
  }
  schedule(reason,delay=100){clearTimeout(this.timer);this.pendingReason=reason;this.timer=setTimeout(()=>this.refresh(reason),delay)}
  refresh(reason='manual'){if(!this.map||!navigator.onLine)return;this.refreshBase(reason);this.refreshDetail(reason)}
  viewPad(){const z=this.map.getZoom();return z>=17?1.05:z>=15?1.25:z>=13?1.55:z>=10?1.9:2.4}
  baseSize(bounds){
    const size=this.map.getSize();const view=this.map.getBounds();const dpr=window.devicePixelRatio||1;
    const xRatio=Math.max(1,(bounds.getEast()-bounds.getWest())/Math.max(.000001,view.getEast()-view.getWest()));
    const yRatio=Math.max(1,(bounds.getNorth()-bounds.getSouth())/Math.max(.000001,view.getNorth()-view.getSouth()));
    const scale=clamp(dpr*1.15,1.2,2.25);
    return {width:clamp(Math.round(size.x*xRatio*scale),700,2600),height:clamp(Math.round(size.y*yRatio*scale),700,2600)};
  }
  async loadOverview(reason='overview'){
    if(!this.map||!navigator.onLine)return;
    const token=++this.overviewSeq;
    const size=this.map.getSize();const ratio=Math.max(1,size.y/Math.max(size.x,1));
    const width=clamp(Math.round(size.x*1.45),900,1600);const height=clamp(Math.round(width*ratio),900,2600);
    try{
      const url=makeWmsUrl(this.config.base,SPAIN_BOUNDS,width,height,`${reason}-spain`);
      await preloadImage(url,18000);
      if(!this.map||token!==this.overviewSeq)return;
      const next=L.imageOverlay(url,SPAIN_BOUNDS,{pane:'basePane',opacity:1,interactive:false,className:'map-base-overview',zIndex:1,attribution:this.config.attribution}).addTo(this.map);
      const old=this.overview;this.overview=next;if(old)this.map.removeLayer(old);
    }catch(err){console.warn('No se pudo cargar base general',err)}
  }
  async refreshBase(reason='vista'){
    if(!this.map||!navigator.onLine)return;
    const token=++this.baseSeq;
    const bounds=expandedBounds(this.viewPad());
    if(!boundsOK(bounds))return;
    const {width,height}=this.baseSize(bounds);
    try{
      const url=makeWmsUrl(this.config.base,bounds,width,height,`${reason}-base-z${this.map.getZoom()}`);
      await preloadImage(url,16000);
      if(!this.map||token!==this.baseSeq)return;
      const next=L.imageOverlay(url,bounds,{pane:'basePane',opacity:1,interactive:false,className:'map-base-view',zIndex:2,attribution:this.config.attribution}).addTo(this.map);
      const old=this.base;this.base=next;if(old)setTimeout(()=>{if(this.map&&old!==this.base)this.map.removeLayer(old)},120);
    }catch(err){console.warn('No se pudo cargar base de vista; mantengo la anterior',err);if(!this.overview)this.loadOverview('respaldo')}
  }
  detailPad(){const z=this.map.getZoom();return z>=17?.35:z>=15?.55:z>=13?.75:z>=10?1.05:1.35}
  positionSnapshot(snapshot){
    if(!snapshot||!this.map)return;
    snapshot.entries.forEach(entry=>{
      const nw=this.map.latLngToContainerPoint(entry.bounds.getNorthWest());
      const se=this.map.latLngToContainerPoint(entry.bounds.getSouthEast());
      const left=Math.round(nw.x),top=Math.round(nw.y),width=Math.max(1,Math.round(se.x-nw.x)),height=Math.max(1,Math.round(se.y-nw.y));
      entry.img.style.transform=`translate3d(${left}px,${top}px,0)`;
      entry.img.style.width=`${width}px`;entry.img.style.height=`${height}px`;
    });
  }
  positionSnapshots(){this.positionSnapshot(this.activeDetail);this.positionSnapshot(this.loadingDetail)}
  async refreshDetail(reason='detalle'){
    if(!this.map||!navigator.onLine)return;
    const token=++this.detailSeq;
    if(this.loadingDetail?.container){try{this.loadingDetail.container.remove()}catch(e){}this.loadingDetail=null}
    const z=clamp(Math.round(this.map.getZoom()),5,18);
    const bounds=expandedBounds(this.detailPad());
    const tiles=tilesForBounds(bounds,z,100);
    if(!tiles.length)return;
    const container=document.createElement('div');
    container.className='static-detail-snapshot';
    container.style.opacity='0';
    this.map.getPane('detailPane').appendChild(container);
    const snapshot={container,entries:[],z,token};
    this.loadingDetail=snapshot;
    try{
      const loaded=await Promise.all(tiles.map(async t=>({tile:t,img:await preloadTile(tileUrl(this.config.detail,t.x,t.y,t.z),11500)})));
      if(!this.map||token!==this.detailSeq){container.remove();return}
      loaded.forEach(({tile,img})=>{
        img.className='static-detail-img';img.alt='';img.draggable=false;img.decoding='async';img.loading='eager';
        container.appendChild(img);snapshot.entries.push({img,bounds:tile.bounds});
      });
      this.positionSnapshot(snapshot);
      requestAnimationFrame(()=>{
        if(!this.map||token!==this.detailSeq){container.remove();return}
        container.style.opacity='1';
        const old=this.activeDetail;this.activeDetail=snapshot;this.loadingDetail=null;
        setTimeout(()=>{if(this.map&&old?.container&&old!==this.activeDetail)old.container.remove()},220);
      });
    }catch(err){console.warn('No se pudo preparar detalle completo; mantengo base',err);container.remove();if(this.loadingDetail===snapshot)this.loadingDetail=null}
  }
}}

function refreshMap(reason='manual'){if(!map)return;map.invalidateSize(true);if(activeMapLayer){if(['boton','arranque','online','nav','resize','orientationchange'].includes(reason))activeMapLayer.loadOverview(reason);activeMapLayer.refresh(reason)}}
function setMapLayer(key){
  if(!MAP_LAYERS[key])key='ign';
  state.activeLayerKey=key;localStorage.setItem('c2-map-layer',key);
  if(activeMapLayer){activeMapLayer.remove();activeMapLayer=null}
  activeMapLayer=new AtakMapLayer(MAP_LAYERS[key]).addTo(map);
  const select=$('#mapLayerSelect');if(select)select.value=key;
}
function initMap(){
  map=L.map('map',{zoomControl:false,preferCanvas:false,fadeAnimation:false,zoomAnimation:true,markerZoomAnimation:true,inertia:true,worldCopyJump:false,minZoom:5,maxZoom:19,maxBounds:SPAIN_BOUNDS,maxBoundsViscosity:.65}).setView([40.4168,-3.7038],6);
  map.createPane('basePane');map.getPane('basePane').style.zIndex=150;map.getPane('basePane').style.pointerEvents='none';
  map.createPane('detailPane');map.getPane('detailPane').style.zIndex=260;map.getPane('detailPane').style.pointerEvents='none';
  map.createPane('positionPane');map.getPane('positionPane').style.zIndex=950;map.getPane('positionPane').style.pointerEvents='none';
  L.control.zoom({position:'bottomright'}).addTo(map);
  const saved=localStorage.getItem('c2-map-layer');setMapLayer(saved&&MAP_LAYERS[saved]?saved:'ign');
  $('#mapLayerSelect')?.addEventListener('change',e=>setMapLayer(e.target.value));
  $('#reloadMapBtn')?.addEventListener('click',()=>{clearTimeout(mapRefreshTimer);refreshMap('boton')});
  map.on('zoomstart movestart',()=>{clearTimeout(mapRefreshTimer)});
  ['resize','orientationchange'].forEach(ev=>window.addEventListener(ev,()=>setTimeout(()=>refreshMap(ev),280)));
  setTimeout(()=>refreshMap('arranque'),450);
}

function iconFor(type){const cls=type==='warning'?'warning-marker':type;return L.divIcon({className:'',html:`<div class="tactical-marker ${cls}"></div>`,iconSize:[22,22],iconAnchor:[11,11]})}
function drawMarkers(){state.markers.forEach(m=>L.marker([m.lat,m.lng],{icon:iconFor(m.type),zIndexOffset:600}).addTo(map).bindPopup(`<strong>${escapeHtml(m.name)}</strong><br>${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}`))}
function userPositionIcon(heading=0){const h=Number.isFinite(heading)?heading:0;return L.divIcon({className:'user-position-icon',html:`<div class="user-position-wrap-v3" style="--heading:${h}deg"><div class="user-position-bearing"></div><div class="user-position-center"></div></div>`,iconSize:[56,56],iconAnchor:[28,28]})}
function updatePosition(pos,center=true){
  const{latitude:lat,longitude:lng,accuracy,heading}=pos.coords;
  const h=Number.isFinite(heading)?heading:state.lastHeading;state.lastHeading=Number.isFinite(h)?h:0;
  $('#coords').textContent=`${lat.toFixed(6)}, ${lng.toFixed(6)}`;$('#accuracy').textContent=`Precisión: ±${Math.round(accuracy)} m`;
  const gpsStatus=$('#gpsStatus');if(gpsStatus)gpsStatus.textContent='GPS activo';
  const latlng=L.latLng(lat,lng);
  if(state.userMarker){state.userMarker.setLatLng(latlng);state.userMarker.setIcon(userPositionIcon(state.lastHeading))}
  else state.userMarker=L.marker(latlng,{icon:userPositionIcon(state.lastHeading),pane:'positionPane',zIndexOffset:9000,keyboard:false,interactive:false,riseOnHover:false}).addTo(map).bindPopup('Mi posición');
  state.userMarker.setZIndexOffset(9000);
  if(center){map.setView(latlng,Math.max(map.getZoom(),17),{animate:false});setTimeout(()=>refreshMap('gps'),150)}
}
function geoError(e){const msg=e?.message||'Error desconocido';const gpsStatus=$('#gpsStatus');if(gpsStatus)gpsStatus.textContent=`GPS: ${msg}`;alert(`No se pudo obtener la posición: ${msg}. Comprueba permisos y que la web esté en HTTPS.`)}
function askPosition(center=true){if(!navigator.geolocation){alert('Geolocalización no disponible');return}const gpsStatus=$('#gpsStatus');if(gpsStatus)gpsStatus.textContent='Buscando GPS…';navigator.geolocation.getCurrentPosition(p=>updatePosition(p,center),geoError,{enableHighAccuracy:true,timeout:15000,maximumAge:1000})}

initMap();drawMarkers();
$('#locateBtn')?.addEventListener('click',()=>askPosition(true));
$('#trackBtn')?.addEventListener('click',()=>{if(state.watchId!==null){navigator.geolocation.clearWatch(state.watchId);state.watchId=null;$('#trackBtn').textContent='Iniciar seguimiento';const gpsStatus=$('#gpsStatus');if(gpsStatus)gpsStatus.textContent='Seguimiento detenido';return}if(!navigator.geolocation)return alert('Geolocalización no disponible');const gpsStatus=$('#gpsStatus');if(gpsStatus)gpsStatus.textContent='Seguimiento GPS activo';state.watchId=navigator.geolocation.watchPosition(p=>updatePosition(p,false),geoError,{enableHighAccuracy:true,maximumAge:1000,timeout:15000});$('#trackBtn').textContent='Detener seguimiento'});
$('#addMarkerBtn').addEventListener('click',()=>$('#markerDialog').showModal());$('#markerForm').addEventListener('submit',e=>{if(e.submitter?.value==='cancel')return;state.pendingMarker={name:$('#markerName').value.trim(),type:$('#markerType').value};alert('Pulsa una ubicación del mapa para colocar el punto.')});map.on('click',e=>{if(!state.pendingMarker)return;const m={id:crypto.randomUUID(),...state.pendingMarker,lat:e.latlng.lat,lng:e.latlng.lng,createdAt:new Date().toISOString()};state.markers.push(m);persist('c2-markers',state.markers);L.marker(e.latlng,{icon:iconFor(m.type),zIndexOffset:600}).addTo(map).bindPopup(`<strong>${escapeHtml(m.name)}</strong>`).openPopup();state.pendingMarker=null;$('#markerForm').reset()});

function escapeHtml(v){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function renderMessages(){const box=$('#messageList');box.innerHTML=state.messages.length?'':'<div class="empty">Todavía no hay mensajes.</div>';state.messages.forEach(m=>{const el=document.createElement('article');el.className='message mine';el.innerHTML=`<header><strong>${escapeHtml(m.author)}</strong><time>${new Date(m.createdAt).toLocaleString()}</time></header><p>${escapeHtml(m.text)}</p>`;box.append(el)});box.scrollTop=box.scrollHeight}
$('#chatForm').addEventListener('submit',e=>{e.preventDefault();const input=$('#chatInput'),text=input.value.trim();if(!text)return;state.messages.push({id:crypto.randomUUID(),author:state.settings.callsign||'Usuario',text,createdAt:new Date().toISOString()});persist('c2-messages',state.messages);input.value='';renderMessages()});$('#clearChatBtn').addEventListener('click',()=>{if(confirm('¿Vaciar todos los mensajes locales?')){state.messages=[];persist('c2-messages',[]);renderMessages()}});

function humanSize(n){if(n<1024)return`${n} B`;if(n<1048576)return`${(n/1024).toFixed(1)} KB`;return`${(n/1048576).toFixed(1)} MB`}
async function renderDocuments(){const docs=await listDocuments(),box=$('#documentList');box.innerHTML=docs.length?'':'<div class="empty">No hay documentos almacenados.</div>';docs.forEach(d=>{const el=document.createElement('article');el.className='document';el.innerHTML=`<div class="doc-icon">${escapeHtml(d.name.split('.').pop().slice(0,4).toUpperCase())}</div><div><strong>${escapeHtml(d.name)}</strong><small>${humanSize(d.size)} · ${new Date(d.createdAt).toLocaleString()}</small></div><div class="doc-actions"><button data-download>Descargar</button><button data-delete>Eliminar</button></div>`;el.querySelector('[data-download]').onclick=()=>{const url=URL.createObjectURL(d.blob),a=document.createElement('a');a.href=url;a.download=d.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};el.querySelector('[data-delete]').onclick=async()=>{if(confirm(`¿Eliminar ${d.name}?`)){await deleteDocument(d.id);renderDocuments()}};box.append(el)})}
async function addFiles(files){for(const f of files){try{await saveDocument(f)}catch(err){alert(`No se pudo guardar ${f.name}: ${err.message}`)}}renderDocuments()}
$('#fileInput').addEventListener('change',e=>addFiles(e.target.files));const dz=$('#dropZone');['dragenter','dragover'].forEach(t=>dz.addEventListener(t,e=>{e.preventDefault();dz.classList.add('drag')}));['dragleave','drop'].forEach(t=>dz.addEventListener(t,e=>{e.preventDefault();dz.classList.remove('drag')}));dz.addEventListener('drop',e=>addFiles(e.dataTransfer.files));

function loadSettings(){$('#callsignInput').value=state.settings.callsign||'';$('#unitInput').value=state.settings.unit||'';$('#unitLabel').textContent=state.settings.unit||'Puesto de mando'}
$('#settingsForm').addEventListener('submit',e=>{e.preventDefault();state.settings={callsign:$('#callsignInput').value.trim()||'Usuario',unit:$('#unitInput').value.trim()||'Puesto de mando'};persist('c2-settings',state.settings);loadSettings();alert('Ajustes guardados')});
$('#exportBtn').addEventListener('click',()=>{const payload={version:1,exportedAt:new Date().toISOString(),settings:state.settings,messages:state.messages,markers:state.markers};const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`seccion-c2-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)});
$('#importInput').addEventListener('change',async e=>{try{const data=JSON.parse(await e.target.files[0].text());if(!data||data.version!==1)throw new Error('Formato no compatible');state.settings=data.settings||state.settings;state.messages=Array.isArray(data.messages)?data.messages:[];state.markers=Array.isArray(data.markers)?data.markers:[];persist('c2-settings',state.settings);persist('c2-messages',state.messages);persist('c2-markers',state.markers);location.reload()}catch(err){alert(`Importación fallida: ${err.message}`)}});

if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js?v=wms-no-tiles-v3').then(reg=>reg.update()).catch(console.error));initNav();updateNetwork();loadSettings();renderMessages();renderDocuments();
