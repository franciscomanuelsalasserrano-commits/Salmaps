import{saveDocument,listDocuments,deleteDocument}from'./db.js';
const $=s=>document.querySelector(s);const $$=s=>[...document.querySelectorAll(s)];
const state={settings:JSON.parse(localStorage.getItem('c2-settings')||'{"callsign":"Jefe de sección","unit":"Puesto de mando"}'),messages:JSON.parse(localStorage.getItem('c2-messages')||'[]'),markers:JSON.parse(localStorage.getItem('c2-markers')||'[]'),pendingMarker:null,watchId:null,userMarker:null,lastHeading:0,activeLayerKey:null};
const persist=(key,value)=>localStorage.setItem(key,JSON.stringify(value));

let map;
let overviewLayer=null;
let detailLayer=null;
let renderTimer=null;
let renderSeq=0;
let overviewSeq=0;
const SPAIN_BOUNDS=L.latLngBounds([[25,-20],[46,6]]);
const MAP_BG='#d8ddcf';
const MAP_LAYERS={
  ign:{label:'IGN topográfico',url:'https://www.ign.es/wms-inspire/mapa-raster',layers:'mtn_rasterizado',format:'image/jpeg',attribution:'© Instituto Geográfico Nacional / CNIG'},
  pnoa:{label:'Vista aérea PNOA',url:'https://www.ign.es/wms-inspire/pnoa-ma',layers:'OI.OrthoimageCoverage',format:'image/jpeg',attribution:'© Instituto Geográfico Nacional / PNOA'}
};

function initNav(){$$('.nav-btn').forEach(btn=>btn.addEventListener('click',()=>{const name=btn.dataset.view;$$('.nav-btn').forEach(x=>x.classList.toggle('active',x===btn));$$('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));if(name==='map')setTimeout(()=>refreshMap(),140)}))}
function updateNetwork(){const on=navigator.onLine;$('#onlineDot').className=`dot ${on?'on':'off'}`;$('#onlineText').textContent=on?'Con conexión':'Sin conexión';if(on)refreshMap()}
window.addEventListener('online',updateNetwork);window.addEventListener('offline',updateNetwork);

function clamp(v,min,max){return Math.max(min,Math.min(max,v))}
function clampBoundsToSpain(b){const south=clamp(b.getSouth(),SPAIN_BOUNDS.getSouth(),SPAIN_BOUNDS.getNorth());const north=clamp(b.getNorth(),SPAIN_BOUNDS.getSouth(),SPAIN_BOUNDS.getNorth());const west=clamp(b.getWest(),SPAIN_BOUNDS.getWest(),SPAIN_BOUNDS.getEast());const east=clamp(b.getEast(),SPAIN_BOUNDS.getWest(),SPAIN_BOUNDS.getEast());if(north<=south||east<=west)return map.getBounds();return L.latLngBounds([[south,west],[north,east]])}
function paddedBounds(pxFactor=1.15){const size=map.getSize();const padX=Math.max(320,Math.min(1200,size.x*pxFactor));const padY=Math.max(320,Math.min(1200,size.y*pxFactor));const nw=map.containerPointToLatLng([-padX,-padY]);const se=map.containerPointToLatLng([size.x+padX,size.y+padY]);return clampBoundsToSpain(L.latLngBounds(nw,se))}
function projectBounds3857(bounds){const sw=map.options.crs.project(bounds.getSouthWest());const ne=map.options.crs.project(bounds.getNorthEast());return{minx:Math.min(sw.x,ne.x),miny:Math.min(sw.y,ne.y),maxx:Math.max(sw.x,ne.x),maxy:Math.max(sw.y,ne.y)}}
function overlayPixelSize(bounds,scale=1.25,max=2200,min=512){const nw=map.latLngToContainerPoint(bounds.getNorthWest());const se=map.latLngToContainerPoint(bounds.getSouthEast());let w=Math.max(1,Math.abs(se.x-nw.x))*scale;let h=Math.max(1,Math.abs(se.y-nw.y))*scale;const f=Math.min(1,max/Math.max(w,h));w*=f;h*=f;return{w:Math.round(clamp(w,min,max)),h:Math.round(clamp(h,min,max))}}
function wmsUrl(cfg,bounds,width,height){const b=projectBounds3857(bounds);const params=new URLSearchParams({SERVICE:'WMS',VERSION:'1.1.1',REQUEST:'GetMap',LAYERS:cfg.layers,STYLES:'',SRS:'EPSG:3857',BBOX:[b.minx,b.miny,b.maxx,b.maxy].join(','),WIDTH:String(width),HEIGHT:String(height),FORMAT:cfg.format,TRANSPARENT:'FALSE',BGCOLOR:'0xd8ddcf',EXCEPTIONS:'application/vnd.ogc.se_inimage'});return`${cfg.url}?${params.toString()}&_=${Date.now()}`}
function preloadImage(url){return new Promise((resolve,reject)=>{const img=new Image();img.decoding='async';img.onload=()=>resolve(url);img.onerror=reject;img.src=url})}
function addOverlay(url,bounds,pane,className,opacity=1){return L.imageOverlay(url,bounds,{pane,interactive:false,opacity,className})}
async function loadOverview(force=false){if(!map||!state.activeLayerKey||!navigator.onLine)return;const cfg=MAP_LAYERS[state.activeLayerKey];if(!force&&overviewLayer)return;const token=++overviewSeq;const bounds=SPAIN_BOUNDS;const dims={w:1800,h:1500};const url=wmsUrl(cfg,bounds,dims.w,dims.h);try{await preloadImage(url);if(token!==overviewSeq||!map)return;const layer=addOverlay(url,bounds,'overviewPane','single-map-overview',1).addTo(map);const old=overviewLayer;overviewLayer=layer;if(old&&old!==overviewLayer)setTimeout(()=>{try{map.removeLayer(old)}catch{}},80)}catch(e){/* no se borra el plano anterior si falla */}}
function queueRender(delay=90){clearTimeout(renderTimer);renderTimer=setTimeout(()=>renderDetail(),delay)}
async function renderDetail(){if(!map||!state.activeLayerKey||!navigator.onLine)return;const size=map.getSize();if(size.x<20||size.y<20){queueRender(250);return}const cfg=MAP_LAYERS[state.activeLayerKey];const bounds=paddedBounds(1.25);const scale=Math.min(Math.max(window.devicePixelRatio||1,1),1.45);const dims=overlayPixelSize(bounds,scale,2400,640);const url=wmsUrl(cfg,bounds,dims.w,dims.h);const token=++renderSeq;try{await preloadImage(url);if(token!==renderSeq||!map)return;const layer=addOverlay(url,bounds,'detailPane','single-map-detail',1).addTo(map);const old=detailLayer;detailLayer=layer;if(old&&old!==detailLayer)setTimeout(()=>{try{map.removeLayer(old)}catch{}},120)}catch(e){if(token===renderSeq)setTimeout(()=>queueRender(700),700)}}
function refreshMap(){if(!map)return;map.invalidateSize(true);loadOverview(false);queueRender(40)}
function setMapLayer(key){if(!MAP_LAYERS[key])key='ign';state.activeLayerKey=key;localStorage.setItem('c2-map-layer',key);renderSeq++;overviewSeq++;if(detailLayer){try{map.removeLayer(detailLayer)}catch{} detailLayer=null}if(overviewLayer){try{map.removeLayer(overviewLayer)}catch{} overviewLayer=null}const select=$('#mapLayerSelect');if(select)select.value=key;map.attributionControl?.setPrefix(false);if(map.attributionControl){map.attributionControl.removeAttribution(MAP_LAYERS.ign.attribution);map.attributionControl.removeAttribution(MAP_LAYERS.pnoa.attribution);map.attributionControl.addAttribution(MAP_LAYERS[key].attribution)}loadOverview(true);queueRender(30)}
function initMap(){
  map=L.map('map',{zoomControl:false,preferCanvas:false,fadeAnimation:false,zoomAnimation:true,markerZoomAnimation:true,inertia:true,worldCopyJump:false,minZoom:3,maxZoom:20,maxBounds:SPAIN_BOUNDS,maxBoundsViscosity:.18}).setView([40.4168,-3.7038],6);
  map.createPane('overviewPane');map.getPane('overviewPane').style.zIndex=180;map.getPane('overviewPane').style.pointerEvents='none';
  map.createPane('detailPane');map.getPane('detailPane').style.zIndex=220;map.getPane('detailPane').style.pointerEvents='none';
  map.createPane('positionPane');map.getPane('positionPane').style.zIndex=950;map.getPane('positionPane').style.pointerEvents='none';
  L.control.zoom({position:'bottomright'}).addTo(map);
  const saved=localStorage.getItem('c2-map-layer');setMapLayer(saved&&MAP_LAYERS[saved]?saved:'ign');
  $('#mapLayerSelect')?.addEventListener('change',e=>setMapLayer(e.target.value));
  $('#reloadMapBtn')?.addEventListener('click',()=>{loadOverview(true);queueRender(0)});
  map.on('zoomstart movestart',()=>loadOverview(false));
  map.on('zoomend moveend resize viewreset',()=>{map.invalidateSize(true);queueRender(35)});
  ['resize','orientationchange'].forEach(ev=>window.addEventListener(ev,()=>setTimeout(refreshMap,240)));
  setTimeout(refreshMap,300);setTimeout(refreshMap,1300);
}

function iconFor(type){const cls=type==='warning'?'warning-marker':type;return L.divIcon({className:'',html:`<div class="tactical-marker ${cls}"></div>`,iconSize:[22,22],iconAnchor:[11,11]})}
function drawMarkers(){state.markers.forEach(m=>L.marker([m.lat,m.lng],{icon:iconFor(m.type),zIndexOffset:600}).addTo(map).bindPopup(`<strong>${escapeHtml(m.name)}</strong><br>${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}`))}
function userPositionIcon(heading=0){const h=Number.isFinite(heading)?heading:0;return L.divIcon({className:'user-position-icon',html:`<div class="user-position-wrap-v3" style="--heading:${h}deg"><div class="user-position-bearing"></div><div class="user-position-center"></div></div>`,iconSize:[56,56],iconAnchor:[28,28]})}
function updatePosition(pos,center=true){
  const{latitude:lat,longitude:lng,accuracy,heading}=pos.coords;
  const h=Number.isFinite(heading)?heading:state.lastHeading;state.lastHeading=Number.isFinite(h)?h:0;
  $('#coords').textContent=`${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  $('#accuracy').textContent=`Precisión: ±${Math.round(accuracy)} m`;
  const gpsStatus=$('#gpsStatus');if(gpsStatus)gpsStatus.textContent='GPS activo';
  const latlng=L.latLng(lat,lng);
  if(state.userMarker){state.userMarker.setLatLng(latlng);state.userMarker.setIcon(userPositionIcon(state.lastHeading))}
  else state.userMarker=L.marker(latlng,{icon:userPositionIcon(state.lastHeading),pane:'positionPane',zIndexOffset:9000,keyboard:false,interactive:false,riseOnHover:false}).addTo(map).bindPopup('Mi posición');
  state.userMarker.setZIndexOffset(9000);
  if(center){map.setView(latlng,Math.max(map.getZoom(),17),{animate:false});setTimeout(()=>refreshMap(),120)}
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

if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').then(reg=>reg.update()).catch(console.error));initNav();updateNetwork();loadSettings();renderMessages();renderDocuments();
