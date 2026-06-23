import{saveDocument,listDocuments,deleteDocument}from'./db.js';
const $=s=>document.querySelector(s);const $$=s=>[...document.querySelectorAll(s)];
const state={settings:JSON.parse(localStorage.getItem('c2-settings')||'{"callsign":"Jefe de sección","unit":"Puesto de mando"}'),messages:JSON.parse(localStorage.getItem('c2-messages')||'[]'),markers:JSON.parse(localStorage.getItem('c2-markers')||'[]'),pendingMarker:null,watchId:null,userMarker:null,lastHeading:0,activeLayerKey:null};
const persist=(key,value)=>localStorage.setItem(key,JSON.stringify(value));

let map;
let activeMapLayer=null;
let mapRefreshTimer=null;
const SPAIN_BOUNDS=L.latLngBounds([25,-20],[46,6]);
const MAP_BG='#d8ddcf';
const MAP_LAYERS={
  ign:{label:'IGN topográfico completo',endpoint:'https://api-maps.ign.es/collections/mtn_rasterizado/map',attribution:'© Instituto Geográfico Nacional / CNIG'},
  pnoa:{label:'Vista aérea PNOA completa',endpoint:'https://api-maps.idee.es/collections/OI.OrthoimageCoverage/map',attribution:'© Instituto Geográfico Nacional / PNOA'}
};

function initNav(){$$('.nav-btn').forEach(btn=>btn.addEventListener('click',()=>{const name=btn.dataset.view;$$('.nav-btn').forEach(x=>x.classList.toggle('active',x===btn));$$('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));if(name==='map')setTimeout(()=>{map?.invalidateSize(true);refreshMap()},140)}))}
function updateNetwork(){const on=navigator.onLine;$('#onlineDot').className=`dot ${on?'on':'off'}`;$('#onlineText').textContent=on?'Con conexión':'Sin conexión';if(on)refreshMap()}
window.addEventListener('online',updateNetwork);window.addEventListener('offline',updateNetwork);

function clamp(n,min,max){return Math.max(min,Math.min(max,n))}
function validBounds(bounds){return bounds&&Number.isFinite(bounds.getWest())&&Number.isFinite(bounds.getSouth())&&Number.isFinite(bounds.getEast())&&Number.isFinite(bounds.getNorth())&&bounds.getEast()>bounds.getWest()&&bounds.getNorth()>bounds.getSouth()}
function clampToSpain(bounds){
  const west=clamp(bounds.getWest(),SPAIN_BOUNDS.getWest(),SPAIN_BOUNDS.getEast());
  const east=clamp(bounds.getEast(),SPAIN_BOUNDS.getWest(),SPAIN_BOUNDS.getEast());
  const south=clamp(bounds.getSouth(),SPAIN_BOUNDS.getSouth(),SPAIN_BOUNDS.getNorth());
  const north=clamp(bounds.getNorth(),SPAIN_BOUNDS.getSouth(),SPAIN_BOUNDS.getNorth());
  if(east<=west||north<=south)return map.getBounds();
  return L.latLngBounds([south,west],[north,east]);
}
function paddedViewBounds(pad=.32){
  const b=map.getBounds();
  const latPad=(b.getNorth()-b.getSouth())*pad;
  const lngPad=(b.getEast()-b.getWest())*pad;
  return clampToSpain(L.latLngBounds([b.getSouth()-latPad,b.getWest()-lngPad],[b.getNorth()+latPad,b.getEast()+lngPad]));
}
function buildApiMapUrl(cfg,bounds,width,height,stamp=''){
  const b=clampToSpain(bounds);
  const bbox=[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()].map(v=>Number(v).toFixed(7)).join(',');
  const params=new URLSearchParams({
    f:'png',
    bbox,
    width:String(Math.round(width)),
    height:String(Math.round(height))
  });
  // Forzamos petición nueva en cada zoom/movimiento. Si el navegador reutiliza una imagen antigua,
  // parece que las capas no suben o no bajan de escala.
  if(stamp)params.set('_',stamp);
  return `${cfg.endpoint}?${params.toString()}`;
}
function loadImage(src,timeout=45000){
  return new Promise((resolve,reject)=>{
    const img=new Image();let done=false;
    const finish=(ok)=>{if(done)return;done=true;clearTimeout(timer);ok?resolve(img):reject(new Error('No cargó el plano'))};
    const timer=setTimeout(()=>finish(false),timeout);
    img.onload=()=>finish(true);
    img.onerror=()=>finish(false);
    img.decoding='async';
    img.loading='eager';
    img.src=src;
  })
}

class CompleteMapLayer{
  constructor(config){
    this.config=config;this.map=null;this.overview=null;this.current=null;this.next=null;
    this.seq=0;this.overviewSeq=0;this.timer=null;this.pending=false;
    this.boundSchedule=()=>this.schedule(80);
    this.boundRefresh=()=>this.refreshNow('reset');
    this.boundZoomStart=()=>{clearTimeout(this.timer);this.pending=true};
  }
  addTo(mapInstance){
    this.map=mapInstance;
    this.loadOverview();
    this.refreshNow('inicio');
    // moveend y zoomend son los únicos momentos en los que se pide la imagen completa nueva.
    // Durante el gesto se mantiene el plano anterior para no ver fondo negro.
    this.map.on('movestart zoomstart',this.boundZoomStart);
    this.map.on('moveend zoomend resize',this.boundSchedule);
    this.map.on('viewreset',this.boundRefresh);
    return this;
  }
  remove(){
    clearTimeout(this.timer);this.seq++;this.overviewSeq++;
    if(this.map){
      this.map.off('movestart zoomstart',this.boundZoomStart);
      this.map.off('moveend zoomend resize',this.boundSchedule);
      this.map.off('viewreset',this.boundRefresh);
      [this.overview,this.current,this.next].forEach(layer=>{if(layer){try{this.map.removeLayer(layer)}catch{}}});
    }
    this.map=null;this.overview=null;this.current=null;this.next=null;
  }
  schedule(delay=100){clearTimeout(this.timer);this.timer=setTimeout(()=>this.refreshNow('vista'),delay)}
  dpr(){
    const z=this.map?.getZoom?.()||6;
    const device=window.devicePixelRatio||1;
    // A más zoom, más píxeles pedimos al servicio para que suba el detalle topográfico/aéreo.
    const target=z>=17?3.2:z>=15?2.9:z>=13?2.55:z>=10?2.25:1.9;
    return Math.min(Math.max(device,target),3.2);
  }
  imageSize(bounds,quality=1){
    const size=this.map.getSize();
    const dpr=this.dpr()*quality;
    const viewBounds=this.map.getBounds();
    const widthRatio=Math.max(1,(bounds.getEast()-bounds.getWest())/Math.max(.000001,viewBounds.getEast()-viewBounds.getWest()));
    const heightRatio=Math.max(1,(bounds.getNorth()-bounds.getSouth())/Math.max(.000001,viewBounds.getNorth()-viewBounds.getSouth()));
    return {
      width:Math.round(clamp(size.x*dpr*widthRatio,720,4096)),
      height:Math.round(clamp(size.y*dpr*heightRatio,720,4096))
    };
  }
  async loadOverview(){
    if(!this.map||!navigator.onLine)return;
    const token=++this.overviewSeq;
    const size=this.map.getSize();
    const w=Math.round(clamp(size.x*1.6,900,1800));
    const h=Math.round(clamp(size.y*1.6,900,1800));
    const url=buildApiMapUrl(this.config,SPAIN_BOUNDS,w,h,`overview-${Date.now()}-${token}`);
    try{
      await loadImage(url,45000);
      if(!this.map||token!==this.overviewSeq)return;
      const layer=L.imageOverlay(url,SPAIN_BOUNDS,{pane:'baseMapPane',opacity:1,interactive:false,attribution:this.config.attribution,className:'complete-map-image complete-map-overview'});
      layer.addTo(this.map);
      if(this.overview&&this.overview!==layer){try{this.map.removeLayer(this.overview)}catch{}}
      this.overview=layer;
    }catch(err){console.warn('overview map failed',err)}
  }
  async refreshNow(reason='vista'){
    clearTimeout(this.timer);
    if(!this.map||!navigator.onLine)return;
    const token=++this.seq;
    this.pending=true;
    const zoom=this.map.getZoom();
    const bounds=paddedViewBounds(zoom>=14?.20:zoom>=10?.26:.34);
    if(!validBounds(bounds)){this.schedule(220);return}
    const tryLoad=async(quality)=>{
      const {width,height}=this.imageSize(bounds,quality);
      const url=buildApiMapUrl(this.config,bounds,width,height,`${reason}-z${zoom}-${Date.now()}-${token}-${quality}`);
      await loadImage(url,45000);
      return url;
    };
    try{
      let url;
      try{url=await tryLoad(1)}catch(firstErr){console.warn('detail map high failed, retry normal',firstErr);url=await tryLoad(.72)}
      if(!this.map||token!==this.seq)return;
      const layer=L.imageOverlay(url,bounds,{pane:'detailMapPane',opacity:1,interactive:false,attribution:this.config.attribution,className:'complete-map-image complete-map-detail'});
      this.next=layer;
      layer.addTo(this.map);
      requestAnimationFrame(()=>{
        if(!this.map||token!==this.seq)return;
        if(this.current&&this.current!==layer){try{this.map.removeLayer(this.current)}catch{}}
        this.current=layer;this.next=null;this.pending=false;
      });
    }catch(err){
      // No quitamos la capa anterior nunca. Si una petición falla, se conserva el plano que ya estaba visible.
      console.warn('detail map failed; keeping previous map',err);
      this.pending=false;
      if(!this.overview)this.loadOverview();
    }
  }
}

function refreshMap(){if(!map)return;map.invalidateSize(true);if(activeMapLayer){activeMapLayer.refreshNow('manual')}}
function setMapLayer(key){
  if(!MAP_LAYERS[key])key='ign';
  state.activeLayerKey=key;
  localStorage.setItem('c2-map-layer',key);
  if(activeMapLayer){activeMapLayer.remove();activeMapLayer=null}
  activeMapLayer=new CompleteMapLayer(MAP_LAYERS[key]).addTo(map);
  const select=$('#mapLayerSelect');if(select)select.value=key;
}
function initMap(){
  map=L.map('map',{zoomControl:false,preferCanvas:false,fadeAnimation:false,zoomAnimation:true,markerZoomAnimation:true,inertia:true,worldCopyJump:false,minZoom:3,maxZoom:20,maxBounds:SPAIN_BOUNDS,maxBoundsViscosity:.2}).setView([40.4168,-3.7038],6);
  map.createPane('baseMapPane');map.getPane('baseMapPane').style.zIndex=180;map.getPane('baseMapPane').style.pointerEvents='none';
  map.createPane('detailMapPane');map.getPane('detailMapPane').style.zIndex=190;map.getPane('detailMapPane').style.pointerEvents='none';
  map.createPane('positionPane');map.getPane('positionPane').style.zIndex=950;map.getPane('positionPane').style.pointerEvents='none';
  L.control.zoom({position:'bottomright'}).addTo(map);
  const saved=localStorage.getItem('c2-map-layer');setMapLayer(saved&&MAP_LAYERS[saved]?saved:'ign');
  $('#mapLayerSelect')?.addEventListener('change',e=>setMapLayer(e.target.value));
  $('#reloadMapBtn')?.addEventListener('click',()=>{clearTimeout(mapRefreshTimer);refreshMap()});
  map.on('movestart zoomstart',()=>{clearTimeout(mapRefreshTimer)});
  map.on('moveend zoomend resize',()=>{clearTimeout(mapRefreshTimer);mapRefreshTimer=setTimeout(refreshMap,80)});
  ['resize','orientationchange'].forEach(ev=>window.addEventListener(ev,()=>setTimeout(refreshMap,260)));
  setTimeout(refreshMap,180);
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
  if(center){map.setView(latlng,Math.max(map.getZoom(),17),{animate:false});setTimeout(refreshMap,120)}
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
