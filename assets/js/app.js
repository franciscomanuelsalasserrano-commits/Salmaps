import{saveDocument,listDocuments,deleteDocument}from'./db.js';
const $=s=>document.querySelector(s);const $$=s=>[...document.querySelectorAll(s)];
const state={settings:JSON.parse(localStorage.getItem('c2-settings')||'{"callsign":"Jefe de sección","unit":"Puesto de mando"}'),messages:JSON.parse(localStorage.getItem('c2-messages')||'[]'),markers:JSON.parse(localStorage.getItem('c2-markers')||'[]'),pendingMarker:null,watchId:null,userMarker:null,lastHeading:0,activeLayerKey:null};
const persist=(key,value)=>localStorage.setItem(key,JSON.stringify(value));

let map;let activeBaseLayer=null;let activeDetailLayer=null;let prefetchTimer=null;
const TRANSPARENT_TILE='data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
const MAP_BACKGROUND='#d8ddcf';
const MAP_LAYERS={
  ign:{
    label:'IGN topográfico',
    url:'https://www.ign.es/wmts/mapa-raster?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=MTN&STYLE=default&FORMAT=image/jpeg&TILEMATRIXSET=GoogleMapsCompatible&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
    attribution:'© Instituto Geográfico Nacional / CNIG',
    maxNativeZoom:18,
    overviewZoom:8
  },
  pnoa:{
    label:'Vista aérea PNOA',
    url:'https://www.ign.es/wmts/pnoa-ma?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=OI.OrthoimageCoverage&STYLE=default&FORMAT=image/jpeg&TILEMATRIXSET=GoogleMapsCompatible&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
    attribution:'© Instituto Geográfico Nacional / PNOA',
    maxNativeZoom:19,
    overviewZoom:9
  }
};

function initNav(){$$('.nav-btn').forEach(btn=>btn.addEventListener('click',()=>{const name=btn.dataset.view;$$('.nav-btn').forEach(x=>x.classList.toggle('active',x===btn));$$('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));if(name==='map')setTimeout(()=>{map?.invalidateSize(true);refreshMap()},140)}))}
function updateNetwork(){const on=navigator.onLine;$('#onlineDot').className=`dot ${on?'on':'off'}`;$('#onlineText').textContent=on?'Con conexión':'Sin conexión';if(on)refreshMap()}
window.addEventListener('online',updateNetwork);window.addEventListener('offline',updateNetwork);

function layerUrl(cfg,x,y,z){return cfg.url.replaceAll('{z}',String(z)).replaceAll('{x}',String(x)).replaceAll('{y}',String(y)).replaceAll('{-y}',String((2**z-1)-y))}
function retryTile(e){const tile=e?.tile;if(!tile||tile.dataset.retryDone==='1')return;tile.dataset.retryDone='1';const src=tile.src;setTimeout(()=>{tile.src=src+(src.includes('?')?'&':'?')+'retry='+Date.now()},450)}
function makeLeafletTileLayer(cfg,mode){
  const isBase=mode==='base';
  const layer=L.tileLayer(cfg.url,{
    minZoom:3,
    maxZoom:20,
    maxNativeZoom:isBase?cfg.overviewZoom:cfg.maxNativeZoom,
    tileSize:256,
    zoomOffset:0,
    detectRetina:false,
    updateWhenIdle:isBase?false:true,
    updateWhenZooming:false,
    keepBuffer:isBase?16:8,
    noWrap:true,
    bounds:[[25,-20],[46,6]],
    errorTileUrl:TRANSPARENT_TILE,
    attribution:isBase?cfg.attribution:'',
    className:isBase?'atak-base-tile':'atak-detail-tile'
  });
  layer.on('tileerror',retryTile);
  layer.on('load',()=>schedulePrefetch(isBase?80:30,3));
  return layer;
}
function prefetchTilesAtZoom(cfg,z,extra=2,limitMax=260){
  if(!map||!navigator.onLine||!cfg)return;
  z=Math.max(3,Math.min(cfg.maxNativeZoom,Math.round(z)));
  const bounds=map.getPixelBounds();
  const size=256;
  const min=bounds.min.divideBy(size).floor().subtract([extra,extra]);
  const max=bounds.max.divideBy(size).floor().add([extra,extra]);
  const limit=(2**z)-1;
  const minX=Math.max(0,min.x),maxX=Math.min(limit,max.x),minY=Math.max(0,min.y),maxY=Math.min(limit,max.y);
  const total=(maxX-minX+1)*(maxY-minY+1);if(total<=0||total>limitMax)return;
  for(let x=minX;x<=maxX;x++)for(let y=minY;y<=maxY;y++){const img=new Image();img.decoding='async';img.loading='eager';img.src=layerUrl(cfg,x,y,z)}
}
function warmUpView(extra=3){
  const cfg=MAP_LAYERS[state.activeLayerKey]||MAP_LAYERS.ign;if(!map||!cfg)return;
  const z=Math.round(map.getZoom());
  prefetchTilesAtZoom(cfg,Math.min(z,cfg.overviewZoom),extra+1,180);
  if(z>cfg.overviewZoom)prefetchTilesAtZoom(cfg,z,extra,320);
  if(z>cfg.overviewZoom+1)prefetchTilesAtZoom(cfg,z-1,extra,220);
}
function schedulePrefetch(delay=160,extra=3){clearTimeout(prefetchTimer);prefetchTimer=setTimeout(()=>warmUpView(extra),delay)}
function refreshMap(){if(!map)return;map.invalidateSize(true);activeBaseLayer?.redraw();activeDetailLayer?.redraw();schedulePrefetch(40,4)}
function setMapLayer(key){
  if(!MAP_LAYERS[key])key='ign';
  state.activeLayerKey=key;
  localStorage.setItem('c2-map-layer',key);
  if(activeDetailLayer){map.removeLayer(activeDetailLayer);activeDetailLayer=null}
  if(activeBaseLayer){map.removeLayer(activeBaseLayer);activeBaseLayer=null}
  const cfg=MAP_LAYERS[key];
  activeBaseLayer=makeLeafletTileLayer(cfg,'base').addTo(map);
  activeDetailLayer=makeLeafletTileLayer(cfg,'detail').addTo(map);
  const select=$('#mapLayerSelect');if(select)select.value=key;
  document.body.dataset.mapLayer=key;
  schedulePrefetch(0,5);
  setTimeout(()=>schedulePrefetch(350,5),350);
}
function initMap(){
  map=L.map('map',{zoomControl:false,preferCanvas:false,fadeAnimation:false,zoomAnimation:true,markerZoomAnimation:true,inertia:true,inertiaDeceleration:3000,worldCopyJump:false,minZoom:3,maxZoom:20,maxBounds:[[25,-20],[46,6]],maxBoundsViscosity:.25}).setView([40.4168,-3.7038],6);
  map.createPane('positionPane');map.getPane('positionPane').style.zIndex=950;map.getPane('positionPane').style.pointerEvents='none';
  L.control.zoom({position:'bottomright'}).addTo(map);
  const saved=localStorage.getItem('c2-map-layer');setMapLayer(saved&&MAP_LAYERS[saved]?saved:'ign');
  $('#mapLayerSelect')?.addEventListener('change',e=>setMapLayer(e.target.value));
  $('#reloadMapBtn')?.addEventListener('click',refreshMap);
  map.on('movestart zoomstart',()=>schedulePrefetch(0,4));
  map.on('move zoom',()=>schedulePrefetch(120,3));
  map.on('moveend zoomend resize viewreset',()=>{map.invalidateSize(true);schedulePrefetch(20,5)});
  ['resize','orientationchange'].forEach(ev=>window.addEventListener(ev,()=>setTimeout(refreshMap,220)));
  setTimeout(refreshMap,250);setTimeout(()=>schedulePrefetch(0,6),900);
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
  if(center){map.setView(latlng,Math.max(map.getZoom(),17),{animate:false});setTimeout(()=>schedulePrefetch(0,3),120)}
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
