import{saveDocument,listDocuments,deleteDocument}from'./db.js';
const $=s=>document.querySelector(s);const $$=s=>[...document.querySelectorAll(s)];
const state={settings:JSON.parse(localStorage.getItem('c2-settings')||'{"callsign":"Jefe de sección","unit":"Puesto de mando"}'),messages:JSON.parse(localStorage.getItem('c2-messages')||'[]'),markers:JSON.parse(localStorage.getItem('c2-markers')||'[]'),pendingMarker:null,watchId:null,userMarker:null,lastHeading:0,activeLayerKey:null};
const persist=(key,value)=>localStorage.setItem(key,JSON.stringify(value));

let map;
let activeMapLayer=null;
let mapRefreshTimer=null;
const SPAIN_BOUNDS=L.latLngBounds([25,-20],[46,6]);
const MAP_BG='#d8ddcf';
const MAP_VERSION='wms-completo-no-tiles-v3';
const MAP_LAYERS={
  ign:{label:'IGN topográfico',attribution:'© Instituto Geográfico Nacional / CNIG',services:[
    {type:'wms3857',url:'https://www.ign.es/wms-inspire/mapa-raster',layers:'mtn_rasterizado',format:'image/png'},
    {type:'api',url:'https://api-maps.ign.es/collections/mtn_rasterizado/map',format:'png'}
  ]},
  pnoa:{label:'Vista aérea PNOA',attribution:'© Instituto Geográfico Nacional / PNOA',services:[
    {type:'wms3857',url:'https://www.ign.es/wms-inspire/pnoa-ma',layers:'OI.OrthoimageCoverage',format:'image/jpeg'},
    {type:'api',url:'https://api-maps.idee.es/collections/OI.OrthoimageCoverage/map',format:'png'}
  ]}
};

function initNav(){$$('.nav-btn').forEach(btn=>btn.addEventListener('click',()=>{const name=btn.dataset.view;$$('.nav-btn').forEach(x=>x.classList.toggle('active',x===btn));$$('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));if(name==='map')setTimeout(()=>{map?.invalidateSize(true);refreshMap('nav')},180)}))}
function updateNetwork(){const on=navigator.onLine;$('#onlineDot').className=`dot ${on?'on':'off'}`;$('#onlineText').textContent=on?'Con conexión':'Sin conexión';if(on)refreshMap('online')}
window.addEventListener('online',updateNetwork);window.addEventListener('offline',updateNetwork);

function clamp(n,min,max){return Math.max(min,Math.min(max,n))}
function validBounds(bounds){return bounds&&Number.isFinite(bounds.getWest())&&Number.isFinite(bounds.getSouth())&&Number.isFinite(bounds.getEast())&&Number.isFinite(bounds.getNorth())&&bounds.getEast()>bounds.getWest()&&bounds.getNorth()>bounds.getSouth()}
function clampToSpain(bounds){
  const west=clamp(bounds.getWest(),SPAIN_BOUNDS.getWest(),SPAIN_BOUNDS.getEast());
  const east=clamp(bounds.getEast(),SPAIN_BOUNDS.getWest(),SPAIN_BOUNDS.getEast());
  const south=clamp(bounds.getSouth(),SPAIN_BOUNDS.getSouth(),SPAIN_BOUNDS.getNorth());
  const north=clamp(bounds.getNorth(),SPAIN_BOUNDS.getSouth(),SPAIN_BOUNDS.getNorth());
  if(east<=west||north<=south)return map?.getBounds?.()||SPAIN_BOUNDS;
  return L.latLngBounds([south,west],[north,east]);
}
function expandedViewBounds(pad){
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
function lonLatBbox(bounds){return [bounds.getWest(),bounds.getSouth(),bounds.getEast(),bounds.getNorth()].map(v=>Number(v).toFixed(7)).join(',')}
function buildMapUrl(service,bounds,width,height,token){
  const w=String(Math.round(width));const h=String(Math.round(height));
  if(service.type==='api'){
    const params=new URLSearchParams({f:service.format||'png',bbox:lonLatBbox(bounds),width:w,height:h,_:token});
    return `${service.url}?${params.toString()}`;
  }
  const params=new URLSearchParams({
    SERVICE:'WMS',VERSION:'1.1.1',REQUEST:'GetMap',LAYERS:service.layers,STYLES:'',SRS:'EPSG:3857',
    BBOX:mercatorBbox(bounds),WIDTH:w,HEIGHT:h,FORMAT:service.format||'image/png',TRANSPARENT:'FALSE',BGCOLOR:'0xD8DDCF',_:token
  });
  return `${service.url}?${params.toString()}`;
}
function preloadImage(src,timeout=26000){
  return new Promise((resolve,reject)=>{
    const img=new Image();let done=false;
    const finish=ok=>{if(done)return;done=true;clearTimeout(timer);ok?resolve(img):reject(new Error('No cargó el plano'))};
    const timer=setTimeout(()=>finish(false),timeout);
    img.onload=()=>finish(img.naturalWidth>32&&img.naturalHeight>32);
    img.onerror=()=>finish(false);
    img.decoding='async';img.loading='eager';img.referrerPolicy='no-referrer-when-downgrade';img.src=src;
  })
}
async function firstServiceUrl(config,bounds,width,height,reason,timeout=26000){
  let lastError;
  const token=`${MAP_VERSION}-${reason}-z${map.getZoom()}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  for(const service of config.services){
    const url=buildMapUrl(service,bounds,width,height,token);
    try{await preloadImage(url,timeout);return url}catch(err){lastError=err;console.warn('Servicio de plano falló; pruebo respaldo',service.type,err)}
  }
  throw lastError||new Error('No cargó ningún servicio de plano');
}

class SingleImageMapLayer{
  constructor(config){
    this.config=config;this.map=null;this.container=null;this.overview=null;this.current=null;this.next=null;this.seq=0;this.overviewSeq=0;this.timer=null;this.lastZoom=null;
    this.boundPosition=()=>this.positionAll();
    this.boundMoveEnd=()=>this.schedule('mover',90);
    this.boundZoomEnd=()=>this.schedule('zoom',30);
    this.boundResize=()=>this.schedule('resize',120);
  }
  addTo(mapInstance){
    this.map=mapInstance;
    this.container=document.createElement('div');
    this.container.className='single-wms-layer';
    this.map.getContainer().insertBefore(this.container,this.map.getContainer().firstChild);
    this.map.on('move zoom resize viewreset',this.boundPosition);
    this.map.on('moveend',this.boundMoveEnd);
    this.map.on('zoomend',this.boundZoomEnd);
    this.map.on('resize',this.boundResize);
    this.loadOverview('inicio');
    this.refreshNow('inicio',true);
    return this;
  }
  remove(){
    clearTimeout(this.timer);this.seq++;this.overviewSeq++;
    if(this.map){
      this.map.off('move zoom resize viewreset',this.boundPosition);
      this.map.off('moveend',this.boundMoveEnd);this.map.off('zoomend',this.boundZoomEnd);this.map.off('resize',this.boundResize);
    }
    if(this.container)this.container.remove();
    this.map=null;this.container=null;this.overview=null;this.current=null;this.next=null;
  }
  schedule(reason='vista',delay=90){clearTimeout(this.timer);this.timer=setTimeout(()=>this.refreshNow(reason,false),delay)}
  positionEntry(entry){
    if(!entry||!entry.img||!this.map)return;
    const nw=this.map.latLngToContainerPoint(entry.bounds.getNorthWest());
    const se=this.map.latLngToContainerPoint(entry.bounds.getSouthEast());
    const left=Math.round(nw.x),top=Math.round(nw.y),width=Math.max(1,Math.round(se.x-nw.x)),height=Math.max(1,Math.round(se.y-nw.y));
    entry.img.style.transform=`translate3d(${left}px,${top}px,0)`;
    entry.img.style.width=`${width}px`;entry.img.style.height=`${height}px`;
  }
  positionAll(){[this.overview,this.current,this.next].forEach(e=>this.positionEntry(e))}
  makeEntry(url,bounds,className,opacity=1){
    const img=document.createElement('img');
    img.className=className;img.alt='';img.decoding='async';img.draggable=false;img.style.opacity=String(opacity);img.src=url;
    this.container.appendChild(img);
    const entry={img,bounds};this.positionEntry(entry);return entry;
  }
  removeEntry(entry){if(entry?.img?.parentNode)entry.img.parentNode.removeChild(entry.img)}
  overviewSize(){
    const size=this.map.getSize();
    const ratio=Math.max(1,size.y/Math.max(size.x,1));
    return {width:clamp(Math.round(size.x*1.9),1100,2200),height:clamp(Math.round(size.x*1.9*ratio),1100,3200)};
  }
  detailPad(){
    const z=this.map.getZoom();
    return z>=17?.55:z>=15?.7:z>=13?.9:z>=10?1.15:1.35;
  }
  detailScale(){
    const z=this.map.getZoom();const dpr=window.devicePixelRatio||1;
    const base=z>=17?3.2:z>=15?2.85:z>=13?2.45:z>=11?2.15:1.85;
    return clamp(Math.max(dpr,base),1.5,3.2);
  }
  sizeFor(bounds,scale){
    const size=this.map.getSize();const view=this.map.getBounds();
    const xRatio=Math.max(1,(bounds.getEast()-bounds.getWest())/Math.max(.000001,view.getEast()-view.getWest()));
    const yRatio=Math.max(1,(bounds.getNorth()-bounds.getSouth())/Math.max(.000001,view.getNorth()-view.getSouth()));
    return {width:clamp(Math.round(size.x*scale*xRatio),900,4096),height:clamp(Math.round(size.y*scale*yRatio),900,4096)};
  }
  async loadOverview(reason='base'){
    if(!this.map||!this.container||!navigator.onLine)return;
    const token=++this.overviewSeq;const {width,height}=this.overviewSize();
    try{
      const url=await firstServiceUrl(this.config,SPAIN_BOUNDS,width,height,`${reason}-base`,28000);
      if(!this.map||token!==this.overviewSeq)return;
      const entry=this.makeEntry(url,SPAIN_BOUNDS,'single-wms-img single-wms-overview',1);
      const old=this.overview;this.overview=entry;this.positionAll();if(old)this.removeEntry(old);
    }catch(err){console.warn('No cargó la base general de España',err)}
  }
  async refreshNow(reason='vista',force=false){
    clearTimeout(this.timer);
    if(!this.map||!this.container||!navigator.onLine)return;
    const zoom=this.map.getZoom();
    const currentView=this.map.getBounds();
    if(!force&&this.current&&this.lastZoom===zoom&&this.current.bounds.pad(-0.18).contains(currentView))return;
    const token=++this.seq;
    const bounds=expandedViewBounds(this.detailPad());
    if(!validBounds(bounds)){this.schedule('bounds',160);return}
    const {width,height}=this.sizeFor(bounds,this.detailScale());
    try{
      const url=await firstServiceUrl(this.config,bounds,width,height,`${reason}-detalle`,30000);
      if(!this.map||token!==this.seq)return;
      const entry=this.makeEntry(url,bounds,'single-wms-img single-wms-detail',0);
      this.next=entry;this.positionAll();
      requestAnimationFrame(()=>{if(!this.map||token!==this.seq)return;entry.img.style.opacity='1';setTimeout(()=>{if(!this.map||token!==this.seq)return;const old=this.current;this.current=entry;this.next=null;this.lastZoom=this.map.getZoom();if(old)this.removeEntry(old);this.positionAll()},180)});
    }catch(err){
      console.warn('No cargó el detalle; se mantiene el plano anterior',err);
      if(!this.overview)this.loadOverview('respaldo');
    }
  }
}

function refreshMap(reason='manual'){if(!map)return;map.invalidateSize(true);if(activeMapLayer){if(!activeMapLayer.overview||['boton','arranque','online','nav','resize','orientationchange'].includes(reason))activeMapLayer.loadOverview(reason);activeMapLayer.refreshNow(reason,true)}}
function setMapLayer(key){
  if(!MAP_LAYERS[key])key='ign';
  state.activeLayerKey=key;localStorage.setItem('c2-map-layer',key);
  if(activeMapLayer){activeMapLayer.remove();activeMapLayer=null}
  activeMapLayer=new SingleImageMapLayer(MAP_LAYERS[key]).addTo(map);
  const select=$('#mapLayerSelect');if(select)select.value=key;
}
function initMap(){
  map=L.map('map',{zoomControl:false,preferCanvas:false,fadeAnimation:false,zoomAnimation:true,markerZoomAnimation:true,inertia:true,worldCopyJump:false,minZoom:5,maxZoom:19,maxBounds:SPAIN_BOUNDS,maxBoundsViscosity:.65}).setView([40.4168,-3.7038],6);
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
