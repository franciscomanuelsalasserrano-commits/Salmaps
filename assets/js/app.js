import{saveDocument,listDocuments,deleteDocument}from'./db.js';
const $=s=>document.querySelector(s);const $$=s=>[...document.querySelectorAll(s)];
const state={settings:JSON.parse(localStorage.getItem('c2-settings')||'{"callsign":"Jefe de sección","unit":"Puesto de mando"}'),messages:JSON.parse(localStorage.getItem('c2-messages')||'[]'),markers:JSON.parse(localStorage.getItem('c2-markers')||'[]'),pendingMarker:null,watchId:null,userMarker:null,accuracyCircle:null,lastHeading:0,lastUserLatLng:null,lastUserAccuracy:null,activeMapLayer:null};
const persist=(key,value)=>localStorage.setItem(key,JSON.stringify(value));

let map;
function initNav(){$$('.nav-btn').forEach(btn=>btn.addEventListener('click',()=>{const name=btn.dataset.view;$$('.nav-btn').forEach(x=>x.classList.toggle('active',x===btn));$$('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));if(name==='map')setTimeout(()=>{map.invalidateSize(true);activeLayer?.refreshNow()},160)}))}
function updateNetwork(){const on=navigator.onLine;$('#onlineDot').className=`dot ${on?'on':'off'}`;$('#onlineText').textContent=on?'Con conexión':'Sin conexión'}
window.addEventListener('online',()=>{updateNetwork();activeLayer?.refreshNow()});window.addEventListener('offline',updateNetwork);

const TRANSPARENT_TILE='data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
const MAP_LAYERS={
  ign:{label:'IGN topográfico',url:'https://tms-mapa-raster.ign.es/1.0.0/mapa-raster/{z}/{x}/{-y}.jpeg',attribution:'© Instituto Geográfico Nacional / CNIG',maxNativeZoom:18},
  pnoa:{label:'Vista aérea PNOA',url:'https://tms-pnoa-ma.idee.es/1.0.0/pnoa-ma/{z}/{x}/{-y}.jpeg',attribution:'© Instituto Geográfico Nacional / PNOA',maxNativeZoom:18}
};
let activeLayer=null,attributionControl=null;

class FastIgnTileLayer{
  constructor(config){this.config=config;this.map=null;this.layer=null;this.prefetchDone=new Set();this.boundPrefetch=()=>this.prefetchVisibleTiles(2);}
  addTo(mapInstance){
    this.map=mapInstance;
    this.layer=L.tileLayer(this.config.url,{
      attribution:this.config.attribution,
      minZoom:3,
      maxZoom:20,
      maxNativeZoom:this.config.maxNativeZoom||18,
      tileSize:256,
      detectRetina:false,
      updateWhenIdle:false,
      updateWhenZooming:false,
      keepBuffer:8,
      crossOrigin:true,
      noWrap:true,
      errorTileUrl:TRANSPARENT_TILE,
      className:'ign-fast-tile'
    });
    this.layer.on('tileerror',e=>this.retryTile(e));
    this.layer.on('load',()=>this.prefetchVisibleTiles(2));
    this.layer.addTo(this.map);
    this.map.on('moveend zoomend resize',this.boundPrefetch);
    setTimeout(()=>this.prefetchVisibleTiles(3),250);
    return this;
  }
  remove(){
    if(!this.map)return;
    this.map.off('moveend zoomend resize',this.boundPrefetch);
    if(this.layer){this.layer.off();this.map.removeLayer(this.layer)}
    this.layer=null;this.map=null;this.prefetchDone.clear();
  }
  refreshNow(){
    if(!this.map||!this.layer)return;
    this.prefetchDone.clear();
    this.layer.redraw();
    setTimeout(()=>this.prefetchVisibleTiles(3),120);
  }
  preloadAndMove(center,zoom,onDone){
    if(!this.map)return false;
    this.map.setView(center,zoom,{animate:false});
    setTimeout(()=>{this.prefetchVisibleTiles(3);if(onDone)onDone();},160);
    return true;
  }
  retryTile(e){
    const tile=e?.tile;if(!tile)return;
    if(tile.dataset.retryDone==='1'){tile.style.visibility='hidden';return}
    tile.dataset.retryDone='1';
    const original=tile.src;
    setTimeout(()=>{tile.style.visibility='';tile.src=original+(original.includes('?')?'&':'?')+'retry='+Date.now()},500);
  }
  tileUrl(x,y,z){
    const limit=Math.pow(2,z)-1;
    const invY=limit-y;
    return this.config.url.replace('{z}',z).replace('{x}',x).replace('{-y}',invY).replace('{y}',y);
  }
  prefetchVisibleTiles(extra=2){
    if(!this.map||!this.layer||!navigator.onLine)return;
    const z=Math.round(this.map.getZoom());
    if(z<3||z>18)return;
    const tileSize=256;
    const bounds=this.map.getPixelBounds();
    const min=bounds.min.divideBy(tileSize).floor().subtract([extra,extra]);
    const max=bounds.max.divideBy(tileSize).floor().add([extra,extra]);
    const limit=Math.pow(2,z)-1;
    const minX=Math.max(0,min.x),maxX=Math.min(limit,max.x),minY=Math.max(0,min.y),maxY=Math.min(limit,max.y);
    const total=(maxX-minX+1)*(maxY-minY+1);
    if(total<=0||total>120)return;
    for(let x=minX;x<=maxX;x++)for(let y=minY;y<=maxY;y++){
      const key=`${z}/${x}/${y}`;
      if(this.prefetchDone.has(key))continue;
      this.prefetchDone.add(key);
      const img=new Image();
      img.decoding='async';
      img.src=this.tileUrl(x,y,z);
    }
    if(this.prefetchDone.size>500)this.prefetchDone=new Set([...this.prefetchDone].slice(-240));
  }
}
function setMapLayer(key){
  if(!MAP_LAYERS[key])key='ign';
  localStorage.setItem('c2-map-layer',key);
  if(activeLayer){activeLayer.remove();activeLayer=null}
  activeLayer=new FastIgnTileLayer(MAP_LAYERS[key]).addTo(map);
  const select=$('#mapLayerSelect');if(select)select.value=key;
  setTimeout(()=>{map.invalidateSize(true);activeLayer?.prefetchVisibleTiles?.(3);refreshUserLocationOverlay()},120);
}
function reloadMap(){map.invalidateSize(true);activeLayer?.refreshNow();refreshUserLocationOverlay()}
function initMap(){
  map=L.map('map',{zoomControl:false,preferCanvas:false,fadeAnimation:true,zoomAnimation:true,markerZoomAnimation:true,inertia:true,worldCopyJump:false,maxZoom:20,minZoom:3,maxBounds:[[25,-20],[46,6]],maxBoundsViscosity:.15}).setView([40.4168,-3.7038],6);
  map.createPane('positionPane');map.getPane('positionPane').style.zIndex=900;map.getPane('positionPane').style.pointerEvents='none';
  L.control.zoom({position:'bottomright'}).addTo(map);attributionControl=map.attributionControl;
  const saved=localStorage.getItem('c2-map-layer');setMapLayer(saved&&MAP_LAYERS[saved]?saved:'ign');
  $('#mapLayerSelect')?.addEventListener('change',e=>setMapLayer(e.target.value));
  $('#reloadMapBtn')?.addEventListener('click',reloadMap);
  ['move','moveend','zoom','zoomend','resize','viewreset'].forEach(ev=>map.on(ev,refreshUserLocationOverlay));
  ['resize','orientationchange'].forEach(ev=>window.addEventListener(ev,()=>setTimeout(()=>{map.invalidateSize(true);activeLayer?.prefetchVisibleTiles?.(3);refreshUserLocationOverlay()},260)));
  setTimeout(()=>{map.invalidateSize(true);activeLayer?.prefetchVisibleTiles?.(3);refreshUserLocationOverlay()},300);
  setTimeout(()=>{map.invalidateSize(true);activeLayer?.prefetchVisibleTiles?.(3);refreshUserLocationOverlay()},1200);
}

function iconFor(type){const cls=type==='warning'?'warning-marker':type;return L.divIcon({className:'',html:`<div class="tactical-marker ${cls}"></div>`,iconSize:[22,22],iconAnchor:[11,11]})}
function drawMarkers(){state.markers.forEach(m=>L.marker([m.lat,m.lng],{icon:iconFor(m.type),zIndexOffset:600}).addTo(map).bindPopup(`<strong>${escapeHtml(m.name)}</strong><br>${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}`))}
function userPositionIcon(heading=0){const h=Number.isFinite(heading)?heading:0;return L.divIcon({className:'user-position-icon',html:`<div class="user-position-wrap user-position-wrap-v2" style="--heading:${h}deg"><div class="user-position-bearing"></div><div class="user-position-center"></div></div>`,iconSize:[56,56],iconAnchor:[28,28]})}
function ensureUserLocationOverlay(){return null}
function refreshUserLocationOverlay(){/* solo queda el marcador GPS real de Leaflet */}px`;el.style.top=`${Math.round(pt.y)}px`;el.style.setProperty('--heading',`${Number.isFinite(state.lastHeading)?state.lastHeading:0}deg`);el.hidden=false}
function updatePosition(pos,center=true){const{latitude:lat,longitude:lng,accuracy,heading}=pos.coords;const h=Number.isFinite(heading)?heading:state.lastHeading;state.lastHeading=Number.isFinite(h)?h:0;$('#coords').textContent=`${lat.toFixed(6)}, ${lng.toFixed(6)}`;$('#accuracy').textContent=`Precisión: ±${Math.round(accuracy)} m`;const gpsStatus=$('#gpsStatus');if(gpsStatus)gpsStatus.textContent='GPS activo';if(state.accuracyCircle){map.removeLayer(state.accuracyCircle);state.accuracyCircle=null}const latlng=L.latLng(lat,lng);state.lastUserLatLng=latlng;state.lastUserAccuracy=accuracy;refreshUserLocationOverlay();if(state.userMarker){state.userMarker.setLatLng(latlng);state.userMarker.setIcon(userPositionIcon(state.lastHeading))}else state.userMarker=L.marker(latlng,{icon:userPositionIcon(state.lastHeading),pane:'positionPane',zIndexOffset:6000,keyboard:false,interactive:false,riseOnHover:false}).addTo(map);state.userMarker.setZIndexOffset(6000);const afterMove=()=>{if(state.userMarker)state.userMarker.setLatLng(latlng);refreshUserLocationOverlay();setTimeout(refreshUserLocationOverlay,80)};if(center){const targetZoom=Math.max(map.getZoom(),17);if(activeLayer&&typeof activeLayer.preloadAndMove==='function'){const started=activeLayer.preloadAndMove(latlng,targetZoom,afterMove);if(started)return}map.setView(latlng,targetZoom,{animate:false});setTimeout(()=>{activeLayer?.refreshNow();afterMove()},350)}else afterMove()}
function geoError(e){const msg=e?.message||'Error desconocido';const gpsStatus=$('#gpsStatus');if(gpsStatus)gpsStatus.textContent=`GPS: ${msg}`;alert(`No se pudo obtener la posición: ${msg}. Comprueba permisos y que la web esté en HTTPS.`)}
function askPosition(center=true){if(!navigator.geolocation){alert('Geolocalización no disponible');return}const gpsStatus=$('#gpsStatus');if(gpsStatus)gpsStatus.textContent='Buscando GPS…';navigator.geolocation.getCurrentPosition(p=>updatePosition(p,center),geoError,{enableHighAccuracy:true,timeout:15000,maximumAge:1000})}

initMap();drawMarkers();
$('#locateBtn').addEventListener('click',()=>askPosition(true));
$('#trackBtn').addEventListener('click',()=>{if(state.watchId!==null){navigator.geolocation.clearWatch(state.watchId);state.watchId=null;$('#trackBtn').textContent='Iniciar seguimiento';const gpsStatus=$('#gpsStatus');if(gpsStatus)gpsStatus.textContent='Seguimiento detenido';return}if(!navigator.geolocation)return alert('Geolocalización no disponible');const gpsStatus=$('#gpsStatus');if(gpsStatus)gpsStatus.textContent='Seguimiento GPS activo';state.watchId=navigator.geolocation.watchPosition(p=>updatePosition(p,false),geoError,{enableHighAccuracy:true,maximumAge:1000,timeout:15000});$('#trackBtn').textContent='Detener seguimiento'});
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
