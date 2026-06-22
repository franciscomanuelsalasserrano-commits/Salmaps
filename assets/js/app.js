import{saveDocument,listDocuments,deleteDocument}from'./db.js';
const $=s=>document.querySelector(s);const $$=s=>[...document.querySelectorAll(s)];
const savedLayer=localStorage.getItem('c2-map-layer');
const initialLayer=['carto','osm','ign','pnoa','esri'].includes(savedLayer)?savedLayer:'carto';
const state={settings:JSON.parse(localStorage.getItem('c2-settings')||'{"callsign":"Jefe de sección","unit":"Puesto de mando"}'),messages:JSON.parse(localStorage.getItem('c2-messages')||'[]'),markers:JSON.parse(localStorage.getItem('c2-markers')||'[]'),mapLayer:initialLayer,pendingMarker:null,watchId:null,userMarker:null,accuracyCircle:null,userLatLng:null,userHeading:0,gpsOverlay:null,currentBaseLayer:null};
const persist=(key,value)=>localStorage.setItem(key,JSON.stringify(value));

function initNav(){$$('.nav-btn').forEach(btn=>btn.addEventListener('click',()=>{const name=btn.dataset.view;$$('.nav-btn').forEach(x=>x.classList.toggle('active',x===btn));$$('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));if(name==='map')scheduleMapResize()}))}
function updateNetwork(){const on=navigator.onLine;$('#onlineDot').className=`dot ${on?'on':'off'}`;$('#onlineText').textContent=on?'Con conexión':'Sin conexión'}
window.addEventListener('online',updateNetwork);window.addEventListener('offline',updateNetwork);

const map=L.map('map',{zoomControl:false,preferCanvas:true,zoomSnap:1,zoomDelta:1,wheelDebounceTime:80}).setView([40.4168,-3.7038],6);
L.control.zoom({position:'bottomright'}).addTo(map);
map.createPane('gpsPane');map.getPane('gpsPane').style.zIndex=750;map.getPane('gpsPane').style.pointerEvents='none';

const emptyTile='data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
const tileCommon={tileSize:256,keepBuffer:2,updateWhenIdle:false,updateWhenZooming:true,crossOrigin:false,detectRetina:false,errorTileUrl:emptyTile};
function tileLayer(url,options={}){return L.tileLayer(url,{...tileCommon,...options}).on('tileerror',()=>setMapLoading(false))}
const baseLayers={
  carto:()=>tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',{subdomains:'abcd',maxZoom:20,maxNativeZoom:20,attribution:'&copy; OpenStreetMap &copy; CARTO'}),
  osm:()=>tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{subdomains:'abc',maxZoom:19,maxNativeZoom:19,attribution:'&copy; OpenStreetMap contributors'}),
  ign:()=>tileLayer('https://www.ign.es/wmts/ign-base?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=IGNBaseTodo&STYLE=default&TILEMATRIXSET=GoogleMapsCompatible&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg',{maxZoom:19,maxNativeZoom:18,attribution:'&copy; Instituto Geogr&aacute;fico Nacional de Espa&ntilde;a'}),
  pnoa:()=>tileLayer('https://www.ign.es/wmts/pnoa-ma?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=OI.OrthoimageCoverage&STYLE=default&TILEMATRIXSET=GoogleMapsCompatible&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg',{maxZoom:19,maxNativeZoom:18,attribution:'PNOA &copy; Instituto Geogr&aacute;fico Nacional de Espa&ntilde;a'}),
  esri:()=>tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,maxNativeZoom:19,attribution:'Tiles &copy; Esri'})
};
function setMapLoading(on){document.body.classList.toggle('map-loading',!!on)}
let resizeTimer;
function scheduleMapResize(){clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{map.invalidateSize(true);updateGpsOverlay()},180)}
function setBaseLayer(key){
  const next=baseLayers[key]?key:'carto';
  if(state.currentBaseLayer)map.removeLayer(state.currentBaseLayer);
  setMapLoading(true);
  const layer=baseLayers[next]();
  layer.on('loading',()=>setMapLoading(true));
  layer.on('load',()=>{setMapLoading(false);scheduleMapResize()});
  state.currentBaseLayer=layer.addTo(map);
  state.mapLayer=next;localStorage.setItem('c2-map-layer',next);
  const select=$('#mapLayerSelect');if(select)select.value=next;
  scheduleMapResize();setTimeout(()=>setMapLoading(false),3500);
}
setBaseLayer(state.mapLayer);
$('#mapLayerSelect')?.addEventListener('change',e=>setBaseLayer(e.target.value));
map.on('move zoom resize',updateGpsOverlay);map.on('moveend zoomend load',scheduleMapResize);window.addEventListener('resize',scheduleMapResize);setTimeout(scheduleMapResize,500);

function iconFor(type){const cls=type==='warning'?'warning-marker':type;return L.divIcon({className:'',html:`<div class="tactical-marker ${cls}"></div>`,iconSize:[22,22],iconAnchor:[11,11]})}
function drawMarkers(){state.markers.forEach(m=>L.marker([m.lat,m.lng],{icon:iconFor(m.type)}).addTo(map).bindPopup(`<strong>${escapeHtml(m.name)}</strong><br>${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}`))}drawMarkers();

function setGpsStatus(text,bad=false){const el=$('#gpsStatus');if(el){el.textContent=text;el.classList.toggle('bad',!!bad)}}
function gpsHtml(heading=0){const h=Math.round(Number.isFinite(heading)?heading:0);return `<div class="gps-marker" style="--gps-heading:${h}deg"><div class="gps-ring"></div><div class="gps-triangle"></div><div class="gps-dot"></div></div>`}
function ensureGpsOverlay(){if(state.gpsOverlay)return state.gpsOverlay;const el=document.createElement('div');el.id='gpsOverlay';el.className='gps-overlay';el.innerHTML=gpsHtml(0);$('#map').appendChild(el);state.gpsOverlay=el;return el}
function updateGpsOverlay(){if(!state.userLatLng)return;const el=ensureGpsOverlay();const p=map.latLngToContainerPoint(state.userLatLng);el.style.transform=`translate(${Math.round(p.x)}px,${Math.round(p.y)}px)`;el.innerHTML=gpsHtml(state.userHeading||0);}
function userIcon(heading=0){return L.divIcon({className:'user-position-icon',html:gpsHtml(heading),iconSize:[64,64],iconAnchor:[32,32]})}
function updateUserHeading(heading){if(!Number.isFinite(heading))return;state.userHeading=(heading+360)%360;if(state.userMarker)state.userMarker.setIcon(userIcon(state.userHeading));updateGpsOverlay()}
function enableCompass(){if(state.compassReady)return;state.compassReady=true;const handler=e=>{let h=null;if(typeof e.webkitCompassHeading==='number')h=e.webkitCompassHeading;else if(typeof e.alpha==='number')h=360-e.alpha;if(h!==null)updateUserHeading(h)};try{if(window.DeviceOrientationEvent&&typeof DeviceOrientationEvent.requestPermission==='function')DeviceOrientationEvent.requestPermission().then(r=>{if(r==='granted')window.addEventListener('deviceorientation',handler,true)}).catch(()=>{});else{window.addEventListener('deviceorientationabsolute',handler,true);window.addEventListener('deviceorientation',handler,true)}}catch{}}
function updatePosition(pos,center=true){
  const{latitude:lat,longitude:lng,accuracy=0,heading}=pos.coords;const ll=L.latLng(lat,lng);state.userLatLng=ll;
  $('#coords').textContent=`${lat.toFixed(6)}, ${lng.toFixed(6)}`;$('#accuracy').textContent=`Precisión: ±${Math.round(accuracy||0)} m`;setGpsStatus('GPS activo: triángulo azul en pantalla');
  if(Number.isFinite(heading)&&heading>=0)state.userHeading=heading;
  if(state.userMarker){state.userMarker.setLatLng(ll);state.userMarker.setIcon(userIcon(state.userHeading))}
  else state.userMarker=L.marker(ll,{icon:userIcon(state.userHeading),pane:'gpsPane',zIndexOffset:10000,interactive:false}).addTo(map);
  if(state.accuracyCircle)state.accuracyCircle.setLatLng(ll).setRadius(Math.max(accuracy||10,8));
  else state.accuracyCircle=L.circle(ll,{radius:Math.max(accuracy||10,8),pane:'gpsPane',color:'#1677ff',weight:2,fillColor:'#1677ff',fillOpacity:.12,interactive:false}).addTo(map);
  ensureGpsOverlay();
  if(center)map.setView(ll,Math.max(map.getZoom(),17),{animate:false});
  setTimeout(()=>{updateGpsOverlay();state.userMarker?.bringToFront?.()},80);setTimeout(updateGpsOverlay,400);
}
function explainGeoError(e){if(!window.isSecureContext&&location.protocol!=='file:')return'El GPS exige HTTPS o localhost.';if(e?.code===1)return'Permiso de ubicación denegado. Activa Ubicación para esta web/app.';if(e?.code===2)return'El móvil no pudo calcular posición. Activa GPS y datos móviles/Wi‑Fi.';if(e?.code===3)return'El GPS tardó demasiado. Prueba de nuevo al aire libre.';return e?.message||'Error desconocido de GPS'}
function geoError(e){const msg=explainGeoError(e);setGpsStatus(msg,true);alert(`No se pudo obtener la posición: ${msg}`)}
function requestPosition(center=true){if(!navigator.geolocation){setGpsStatus('Geolocalización no disponible',true);return alert('Geolocalización no disponible en este navegador.')}setGpsStatus('Buscando GPS…');enableCompass();navigator.geolocation.getCurrentPosition(p=>updatePosition(p,center),err=>{if(err?.code===3){navigator.geolocation.getCurrentPosition(p=>updatePosition(p,center),geoError,{enableHighAccuracy:false,timeout:25000,maximumAge:60000});return}geoError(err)},{enableHighAccuracy:true,timeout:22000,maximumAge:5000})}
$('#locateBtn').addEventListener('click',()=>requestPosition(true));
$('#trackBtn').addEventListener('click',()=>{enableCompass();if(state.watchId!==null){navigator.geolocation.clearWatch(state.watchId);state.watchId=null;$('#trackBtn').textContent='Iniciar seguimiento';setGpsStatus('Seguimiento detenido');return}if(!navigator.geolocation)return alert('Geolocalización no disponible');setGpsStatus('Iniciando seguimiento GPS…');requestPosition(true);state.watchId=navigator.geolocation.watchPosition(p=>updatePosition(p,true),geoError,{enableHighAccuracy:true,maximumAge:3000,timeout:25000});$('#trackBtn').textContent='Detener seguimiento'});

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

if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(console.error));initNav();updateNetwork();loadSettings();renderMessages();renderDocuments();
