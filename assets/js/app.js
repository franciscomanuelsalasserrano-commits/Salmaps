import{saveDocument,listDocuments,deleteDocument}from'./db.js';
const $=s=>document.querySelector(s);const $$=s=>[...document.querySelectorAll(s)];
const state={settings:JSON.parse(localStorage.getItem('c2-settings')||'{"callsign":"Jefe de sección","unit":"Puesto de mando"}'),messages:JSON.parse(localStorage.getItem('c2-messages')||'[]'),markers:JSON.parse(localStorage.getItem('c2-markers')||'[]'),pendingMarker:null,watchId:null,userMarker:null,lastHeading:0,activeLayerKey:null};
const persist=(key,value)=>localStorage.setItem(key,JSON.stringify(value));

let map;
let activeMapLayer=null;
let mapRefreshTimer=null;
const MAP_BG='#d8ddcf';
const SPAIN_BOUNDS=L.latLngBounds([25,-20],[46,6]);
const MAP_LAYERS={
  ign:{label:'IGN topográfico',attribution:'© Instituto Geográfico Nacional / CNIG',services:[
    {type:'wms',url:'https://www.ign.es/wms-inspire/mapa-raster',layers:'mtn_rasterizado',format:'image/png'},
    {type:'api',url:'https://api-maps.ign.es/collections/mtn_rasterizado/map',format:'png'}
  ]},
  pnoa:{label:'Vista aérea PNOA',attribution:'© Instituto Geográfico Nacional / PNOA',services:[
    {type:'wms',url:'https://www.ign.es/wms-inspire/pnoa-ma',layers:'OI.OrthoimageCoverage',format:'image/jpeg'},
    {type:'api',url:'https://api-maps.idee.es/collections/OI.OrthoimageCoverage/map',format:'png'}
  ]}
};

function initNav(){$$('.nav-btn').forEach(btn=>btn.addEventListener('click',()=>{const name=btn.dataset.view;$$('.nav-btn').forEach(x=>x.classList.toggle('active',x===btn));$$('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));if(name==='map')setTimeout(()=>{map?.invalidateSize(true);refreshMap('nav')},180)}))}
function updateNetwork(){const on=navigator.onLine;$('#onlineDot').className=`dot ${on?'on':'off'}`;$('#onlineText').textContent=on?'Con conexión':'Sin conexión';if(on)refreshMap('online')}
window.addEventListener('online',updateNetwork);window.addEventListener('offline',updateNetwork);

function clamp(n,min,max){return Math.max(min,Math.min(max,n))}
function safeNum(v){return Number.isFinite(v)?v:0}
function validBounds(bounds){return bounds&&Number.isFinite(bounds.getWest())&&Number.isFinite(bounds.getSouth())&&Number.isFinite(bounds.getEast())&&Number.isFinite(bounds.getNorth())&&bounds.getEast()>bounds.getWest()&&bounds.getNorth()>bounds.getSouth()}
function viewBoundsWithPadding(pad=.18){
  const b=map.getBounds();
  const latPad=(b.getNorth()-b.getSouth())*pad;
  const lngPad=(b.getEast()-b.getWest())*pad;
  return L.latLngBounds([b.getSouth()-latPad,b.getWest()-lngPad],[b.getNorth()+latPad,b.getEast()+lngPad]);
}
function projectedBbox(bounds){
  const sw=map.options.crs.project(bounds.getSouthWest());
  const ne=map.options.crs.project(bounds.getNorthEast());
  return [sw.x,sw.y,ne.x,ne.y].map(v=>safeNum(v).toFixed(2)).join(',');
}
function latLngBbox(bounds){return [bounds.getWest(),bounds.getSouth(),bounds.getEast(),bounds.getNorth()].map(v=>safeNum(v).toFixed(7)).join(',')}
function buildServiceUrl(service,bounds,width,height,stamp){
  const w=String(Math.round(width));const h=String(Math.round(height));
  if(service.type==='api'){
    const params=new URLSearchParams({f:service.format||'png',bbox:latLngBbox(bounds),width:w,height:h,_:stamp});
    return `${service.url}?${params.toString()}`;
  }
  const params=new URLSearchParams({
    SERVICE:'WMS',VERSION:'1.1.1',REQUEST:'GetMap',LAYERS:service.layers,STYLES:'',SRS:'EPSG:3857',
    BBOX:projectedBbox(bounds),WIDTH:w,HEIGHT:h,FORMAT:service.format||'image/png',TRANSPARENT:'FALSE',BGCOLOR:'0xD8DDCF',_:stamp
  });
  return `${service.url}?${params.toString()}`;
}
function loadImage(src,timeout=28000){
  return new Promise((resolve,reject)=>{
    const img=new Image();let done=false;
    const finish=(ok)=>{if(done)return;done=true;clearTimeout(timer);ok?resolve(img):reject(new Error('No cargó el plano'))};
    const timer=setTimeout(()=>finish(false),timeout);
    img.onload=()=>finish(true);
    img.onerror=()=>finish(false);
    img.decoding='async';img.loading='eager';img.referrerPolicy='no-referrer-when-downgrade';img.src=src;
  })
}
async function firstWorkingUrl(services,bounds,width,height,stamp,timeout){
  let lastErr;
  for(const service of services){
    const url=buildServiceUrl(service,bounds,width,height,stamp);
    try{await loadImage(url,timeout);return url}catch(err){lastErr=err;console.warn('Plano falló, pruebo respaldo',service.type,err)}
  }
  throw lastErr||new Error('No cargó ningún servicio de plano');
}

class FullViewMapLayer{
  constructor(config){
    this.config=config;this.map=null;this.overview=null;this.current=null;this.next=null;this.seq=0;this.overviewSeq=0;this.timer=null;this.lastRefreshAt=0;
    this.onResize=()=>this.schedule('resize',120);this.onMoveEnd=()=>this.schedule('move',90);this.onZoomEnd=()=>this.schedule('zoom',40);this.onViewReset=()=>this.schedule('reset',60);
  }
  addTo(mapInstance){
    this.map=mapInstance;
    this.loadOverview('inicio');
    this.refreshNow('inicio');
    this.map.on('moveend',this.onMoveEnd);
    this.map.on('zoomend',this.onZoomEnd);
    this.map.on('resize',this.onResize);
    this.map.on('viewreset',this.onViewReset);
    return this;
  }
  remove(){
    clearTimeout(this.timer);this.seq++;this.overviewSeq++;
    if(this.map){
      this.map.off('moveend',this.onMoveEnd);this.map.off('zoomend',this.onZoomEnd);this.map.off('resize',this.onResize);this.map.off('viewreset',this.onViewReset);
      [this.overview,this.current,this.next].forEach(layer=>{if(layer){try{this.map.removeLayer(layer)}catch{}}});
    }
    this.map=null;this.overview=null;this.current=null;this.next=null;
  }
  schedule(reason='vista',delay=90){clearTimeout(this.timer);this.timer=setTimeout(()=>this.refreshNow(reason),delay)}
  detailScale(){
    const z=this.map?.getZoom?.()||6;
    const dpr=window.devicePixelRatio||1;
    const wanted=z>=17?3.6:z>=15?3.2:z>=13?2.75:z>=11?2.35:z>=9?2.05:1.7;
    return clamp(Math.max(dpr,wanted),1.5,3.6);
  }
  sizeFor(bounds,scale=1){
    const size=this.map.getSize();
    const view=this.map.getBounds();
    const xRatio=Math.max(1,(bounds.getEast()-bounds.getWest())/Math.max(.000001,view.getEast()-view.getWest()));
    const yRatio=Math.max(1,(bounds.getNorth()-bounds.getSouth())/Math.max(.000001,view.getNorth()-view.getSouth()));
    return {width:clamp(Math.round(size.x*scale*xRatio),720,4096),height:clamp(Math.round(size.y*scale*yRatio),720,4096)};
  }
  async loadOverview(reason='base'){
    if(!this.map||!navigator.onLine)return;
    const token=++this.overviewSeq;
    const size=this.map.getSize();
    const ratio=Math.max(1,size.y/Math.max(1,size.x));
    const width=clamp(Math.round(size.x*1.55),900,1800);
    const height=clamp(Math.round(width*ratio),900,2600);
    const stamp=`${reason}-base-${Date.now()}-${token}`;
    try{
      const url=await firstWorkingUrl(this.config.services,SPAIN_BOUNDS,width,height,stamp,30000);
      if(!this.map||token!==this.overviewSeq)return;
      const layer=L.imageOverlay(url,SPAIN_BOUNDS,{pane:'baseMapPane',opacity:1,interactive:false,attribution:this.config.attribution,className:'full-map-image full-map-overview'}).addTo(this.map);
      if(this.overview&&this.overview!==layer){try{this.map.removeLayer(this.overview)}catch{}}
      this.overview=layer;
    }catch(err){console.warn('No cargó plano base',err)}
  }
  async refreshNow(reason='vista'){
    clearTimeout(this.timer);
    if(!this.map||!navigator.onLine)return;
    const token=++this.seq;
    const z=this.map.getZoom();
    const pad=z>=16?.10:z>=14?.13:z>=11?.17:.22;
    const bounds=viewBoundsWithPadding(pad);
    if(!validBounds(bounds)){this.schedule('bounds',180);return}
    const scale=this.detailScale();
    const {width,height}=this.sizeFor(bounds,scale);
    const stamp=`${reason}-z${z.toFixed(2)}-${Date.now()}-${token}`;
    try{
      const url=await firstWorkingUrl(this.config.services,bounds,width,height,stamp,30000);
      if(!this.map||token!==this.seq)return;
      const layer=L.imageOverlay(url,bounds,{pane:'detailMapPane',opacity:0,interactive:false,attribution:this.config.attribution,className:'full-map-image full-map-detail'}).addTo(this.map);
      this.next=layer;
      requestAnimationFrame(()=>{
        if(!this.map||token!==this.seq)return;
        layer.setOpacity(1);
        setTimeout(()=>{if(!this.map||token!==this.seq)return;if(this.current&&this.current!==layer){try{this.map.removeLayer(this.current)}catch{}}this.current=layer;this.next=null;this.lastRefreshAt=Date.now()},80);
      });
    }catch(err){
      console.warn('No cargó detalle; se mantiene plano anterior',err);
      if(!this.overview)this.loadOverview('respaldo');
    }
  }
}

function refreshMap(reason='manual'){if(!map)return;map.invalidateSize(true);if(activeMapLayer){activeMapLayer.loadOverview(reason);activeMapLayer.refreshNow(reason)}}
function setMapLayer(key){
  if(!MAP_LAYERS[key])key='ign';
  state.activeLayerKey=key;localStorage.setItem('c2-map-layer',key);
  if(activeMapLayer){activeMapLayer.remove();activeMapLayer=null}
  activeMapLayer=new FullViewMapLayer(MAP_LAYERS[key]).addTo(map);
  const select=$('#mapLayerSelect');if(select)select.value=key;
}
function initMap(){
  map=L.map('map',{zoomControl:false,preferCanvas:false,fadeAnimation:false,zoomAnimation:true,markerZoomAnimation:true,inertia:true,worldCopyJump:false,minZoom:5,maxZoom:19,maxBounds:SPAIN_BOUNDS,maxBoundsViscosity:.65}).setView([40.4168,-3.7038],6);
  map.createPane('baseMapPane');map.getPane('baseMapPane').style.zIndex=180;map.getPane('baseMapPane').style.pointerEvents='none';
  map.createPane('detailMapPane');map.getPane('detailMapPane').style.zIndex=190;map.getPane('detailMapPane').style.pointerEvents='none';
  map.createPane('positionPane');map.getPane('positionPane').style.zIndex=950;map.getPane('positionPane').style.pointerEvents='none';
  L.control.zoom({position:'bottomright'}).addTo(map);
  const saved=localStorage.getItem('c2-map-layer');setMapLayer(saved&&MAP_LAYERS[saved]?saved:'ign');
  $('#mapLayerSelect')?.addEventListener('change',e=>setMapLayer(e.target.value));
  $('#reloadMapBtn')?.addEventListener('click',()=>{clearTimeout(mapRefreshTimer);refreshMap('boton')});
  map.on('zoomstart movestart',()=>{clearTimeout(mapRefreshTimer)});
  map.on('zoomend',()=>{clearTimeout(mapRefreshTimer);mapRefreshTimer=setTimeout(()=>refreshMap('zoomend'),70)});
  map.on('moveend',()=>{clearTimeout(mapRefreshTimer);mapRefreshTimer=setTimeout(()=>refreshMap('moveend'),120)});
  ['resize','orientationchange'].forEach(ev=>window.addEventListener(ev,()=>setTimeout(()=>refreshMap(ev),260)));
  setTimeout(()=>refreshMap('arranque'),380);
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

if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js?v=mapzoom-real-v1').then(reg=>reg.update()).catch(console.error));initNav();updateNetwork();loadSettings();renderMessages();renderDocuments();
