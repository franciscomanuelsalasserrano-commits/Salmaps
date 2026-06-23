import{saveDocument,listDocuments,deleteDocument}from'./db.js';
const $=s=>document.querySelector(s);const $$=s=>[...document.querySelectorAll(s)];
const state={settings:JSON.parse(localStorage.getItem('c2-settings')||'{"callsign":"Jefe de sección","unit":"Puesto de mando"}'),messages:JSON.parse(localStorage.getItem('c2-messages')||'[]'),markers:JSON.parse(localStorage.getItem('c2-markers')||'[]'),pendingMarker:null,watchId:null,userMarker:null,accuracyCircle:null};
const persist=(key,value)=>localStorage.setItem(key,JSON.stringify(value));

function initNav(){$$('.nav-btn').forEach(btn=>btn.addEventListener('click',()=>{const name=btn.dataset.view;$$('.nav-btn').forEach(x=>x.classList.toggle('active',x===btn));$$('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));if(name==='map')setTimeout(()=>map.invalidateSize(),100)}))}
function updateNetwork(){const on=navigator.onLine;$('#onlineDot').className=`dot ${on?'on':'off'}`;$('#onlineText').textContent=on?'Con conexión':'Sin conexión'}
window.addEventListener('online',updateNetwork);window.addEventListener('offline',updateNetwork);

/* MAPA: carga uniforme de planos
   En Leaflet las teselas llegan por separado por red. Para que no se vea el mosaico
   a cuadrados, la app cubre el mapa durante cada zoom/cambio de capa y solo lo
   muestra cuando la vista visible ya ha terminado de cargar o se ha agotado un
   tiempo máximo de seguridad. */
const MAP_LAYER_KEY='c2-map-layer-uniform-v8';
const EMPTY_TILE='data:image/svg+xml;charset=utf-8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#101713"/><path d="M0 0H256V256H0Z" fill="none" stroke="#1f2a23" stroke-width="2"/></svg>');
const tileDefaults={
  minZoom:3,
  maxZoom:19,
  tileSize:256,
  updateWhenIdle:true,
  updateWhenZooming:false,
  updateInterval:350,
  keepBuffer:4,
  detectRetina:false,
  errorTileUrl:EMPTY_TILE,
  crossOrigin:false
};
const map=L.map('map',{
  zoomControl:false,
  preferCanvas:true,
  fadeAnimation:false,
  zoomAnimation:true,
  markerZoomAnimation:true,
  minZoom:3,
  maxZoom:19,
  inertia:true,
  zoomSnap:1,
  zoomDelta:1,
  wheelPxPerZoomLevel:120
}).setView([40.4168,-3.7038],6);
L.control.zoom({position:'bottomright'}).addTo(map);
const baseLayerFactories={
  osm:()=>L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{...tileDefaults,subdomains:'abc',maxNativeZoom:19,attribution:'&copy; OpenStreetMap contributors'}),
  ign:()=>L.tileLayer('https://www.ign.es/wmts/mapa-raster?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=MTN&STYLE=default&TILEMATRIXSET=GoogleMapsCompatible&FORMAT=image/jpeg&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',{...tileDefaults,noWrap:true,maxNativeZoom:18,attribution:'&copy; Instituto Geográfico Nacional de España'}),
  pnoa:()=>L.tileLayer('https://www.ign.es/wmts/pnoa-ma?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=OI.OrthoimageCoverage&STYLE=default&TILEMATRIXSET=GoogleMapsCompatible&FORMAT=image/jpeg&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',{...tileDefaults,noWrap:true,maxNativeZoom:19,attribution:'PNOA &copy; Instituto Geográfico Nacional de España'}),
  esri:()=>L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{...tileDefaults,noWrap:true,maxNativeZoom:19,attribution:'Tiles &copy; Esri'})
};
let activeBaseLayer=null;
let activeBaseKey=localStorage.getItem(MAP_LAYER_KEY)||'osm';
let loadToken=0;
let loadTimeout=null;
let hideTimeout=null;
if(!baseLayerFactories[activeBaseKey])activeBaseKey='osm';
if($('#baseLayerSelect'))$('#baseLayerSelect').value=activeBaseKey;
function setMapShield(active,text='Cargando plano completo…'){
  const view=$('#view-map'),shield=$('#mapShield');
  if(!view||!shield)return;
  if(text)shield.querySelector('[data-map-shield-text]').textContent=text;
  clearTimeout(hideTimeout);
  if(active){view.classList.add('map-uniform-loading');map.getContainer().classList.add('map-busy');return}
  hideTimeout=setTimeout(()=>{view.classList.remove('map-uniform-loading');map.getContainer().classList.remove('map-busy')},140);
}
function beginMapLoad(text='Cargando plano completo…',maxMs=14000){
  loadToken+=1;
  const token=loadToken;
  clearTimeout(loadTimeout);
  setMapShield(true,text);
  loadTimeout=setTimeout(()=>finishMapLoad(token),maxMs);
  return token;
}
function currentTilesReady(layer){
  const container=layer?.getContainer?.();
  if(!container)return true;
  const tiles=[...container.querySelectorAll('img.leaflet-tile')].filter(img=>img.isConnected&&img.offsetParent!==null);
  if(!tiles.length)return false;
  return tiles.every(img=>img.complete&&img.naturalWidth>0);
}
function waitForLayerReady(layer,token,attempt=0){
  if(token!==loadToken)return;
  if(currentTilesReady(layer)||attempt>90){finishMapLoad(token);return}
  setTimeout(()=>waitForLayerReady(layer,token,attempt+1),120);
}
function finishMapLoad(token){
  if(token!==loadToken)return;
  clearTimeout(loadTimeout);
  requestAnimationFrame(()=>{
    map.invalidateSize({pan:false});
    setTimeout(()=>setMapShield(false),120);
  });
}
function bindLayerEvents(layer){
  layer.on('loading',()=>{
    if(layer._uniformSwitchToken){layer._uniformLoadToken=layer._uniformSwitchToken;return}
    layer._uniformLoadToken=beginMapLoad('Cargando plano completo…');
  });
  layer.on('load',()=>{const token=layer._uniformLoadToken||loadToken;layer._uniformSwitchToken=null;waitForLayerReady(layer,token)});
  layer.on('tileerror',e=>{if(e?.tile){e.tile.alt='';e.tile.src=EMPTY_TILE;e.tile.classList.add('leaflet-tile-loaded')}});
}
function setBaseLayer(key,initial=false){
  if(!baseLayerFactories[key])key='osm';
  const previous=activeBaseLayer;
  const next=baseLayerFactories[key]();
  const token=beginMapLoad(initial?'Cargando plano completo…':'Cambiando capa…',initial?15000:16000);
  activeBaseKey=key;
  localStorage.setItem(MAP_LAYER_KEY,key);
  next._uniformSwitchToken=token;
  bindLayerEvents(next);
  next.setOpacity(0);
  next.addTo(map);
  activeBaseLayer=next;
  const reveal=()=>{
    if(token!==loadToken)return;
    next.setOpacity(1);
    if(previous&&map.hasLayer(previous))map.removeLayer(previous);
    next._uniformSwitchToken=null;
    waitForLayerReady(next,token);
  };
  next.once('load',reveal);
  setTimeout(reveal,initial?6500:8000);
}
function reloadVisiblePlan(){
  if(!activeBaseLayer)return;
  const token=beginMapLoad('Recargando plano…');
  activeBaseLayer._uniformSwitchToken=token;
  activeBaseLayer._uniformLoadToken=token;
  activeBaseLayer.redraw();
}
map.on('zoomstart',()=>beginMapLoad('Ampliando plano…',16000));
map.on('zoomend',()=>setTimeout(()=>waitForLayerReady(activeBaseLayer,loadToken),350));
map.on('moveend resize',()=>setTimeout(()=>map.invalidateSize({pan:false}),80));
if($('#baseLayerSelect'))$('#baseLayerSelect').addEventListener('change',e=>setBaseLayer(e.target.value));
if($('#reloadMapBtn'))$('#reloadMapBtn').addEventListener('click',reloadVisiblePlan);
setBaseLayer(activeBaseKey,true);

function iconFor(type){const cls=type==='warning'?'warning-marker':type;return L.divIcon({className:'',html:`<div class="tactical-marker ${cls}"></div>`,iconSize:[22,22],iconAnchor:[11,11]})}
function drawMarkers(){state.markers.forEach(m=>L.marker([m.lat,m.lng],{icon:iconFor(m.type)}).addTo(map).bindPopup(`<strong>${escapeHtml(m.name)}</strong><br>${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}`))}drawMarkers();
function updatePosition(pos,center=true){const{latitude:lat,longitude:lng,accuracy}=pos.coords;$('#coords').textContent=`${lat.toFixed(6)}, ${lng.toFixed(6)}`;$('#accuracy').textContent=`Precisión: ±${Math.round(accuracy)} m`;if(state.userMarker)state.userMarker.setLatLng([lat,lng]);else state.userMarker=L.circleMarker([lat,lng],{radius:8,color:'#fff',weight:3,fillColor:'#4a8ee8',fillOpacity:1}).addTo(map).bindPopup('Mi posición');if(state.accuracyCircle)state.accuracyCircle.setLatLng([lat,lng]).setRadius(accuracy);else state.accuracyCircle=L.circle([lat,lng],{radius:accuracy,color:'#4a8ee8',weight:1,fillOpacity:.08}).addTo(map);if(center)map.setView([lat,lng],Math.max(map.getZoom(),16))}
function geoError(e){alert(`No se pudo obtener la posición: ${e.message}. Comprueba permisos y que la web esté en HTTPS.`)}
$('#locateBtn').addEventListener('click',()=>navigator.geolocation?navigator.geolocation.getCurrentPosition(p=>updatePosition(p,true),geoError,{enableHighAccuracy:true,timeout:12000,maximumAge:5000}):alert('Geolocalización no disponible'));
$('#trackBtn').addEventListener('click',()=>{if(state.watchId!==null){navigator.geolocation.clearWatch(state.watchId);state.watchId=null;$('#trackBtn').textContent='Iniciar seguimiento';return}if(!navigator.geolocation)return alert('Geolocalización no disponible');state.watchId=navigator.geolocation.watchPosition(p=>updatePosition(p,false),geoError,{enableHighAccuracy:true,maximumAge:3000,timeout:15000});$('#trackBtn').textContent='Detener seguimiento'});
$('#addMarkerBtn').addEventListener('click',()=>$('#markerDialog').showModal());$('#markerForm').addEventListener('submit',e=>{if(e.submitter?.value==='cancel')return;state.pendingMarker={name:$('#markerName').value.trim(),type:$('#markerType').value};alert('Pulsa una ubicación del mapa para colocar el punto.')});map.on('click',e=>{if(!state.pendingMarker)return;const m={id:crypto.randomUUID(),...state.pendingMarker,lat:e.latlng.lat,lng:e.latlng.lng,createdAt:new Date().toISOString()};state.markers.push(m);persist('c2-markers',state.markers);L.marker(e.latlng,{icon:iconFor(m.type)}).addTo(map).bindPopup(`<strong>${escapeHtml(m.name)}</strong>`).openPopup();state.pendingMarker=null;$('#markerForm').reset()});

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

if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').then(reg=>{reg.update();if(reg.waiting)reg.waiting.postMessage({type:'SKIP_WAITING'})}).catch(console.error));initNav();updateNetwork();loadSettings();renderMessages();renderDocuments();
