import{saveDocument,listDocuments,deleteDocument}from'./db.js';
const $=s=>document.querySelector(s);const $$=s=>[...document.querySelectorAll(s)];
const state={settings:JSON.parse(localStorage.getItem('c2-settings')||'{"callsign":"Jefe de sección","unit":"Puesto de mando"}'),messages:JSON.parse(localStorage.getItem('c2-messages')||'[]'),markers:JSON.parse(localStorage.getItem('c2-markers')||'[]'),pendingMarker:null,watchId:null,userMarker:null,lastHeading:0};
const persist=(key,value)=>localStorage.setItem(key,JSON.stringify(value));

let map;let c2MapLayer=null;
const MAP_VERSION='wms-real-v14';
const SPAIN_BOUNDS=L.latLngBounds([25.0,-20.0],[46.0,6.0]);
const MAP_BG='#d8ddcf';
const MAP_LAYERS={
  ign:{label:'IGN topográfico',url:'https://www.ign.es/wms-inspire/mapa-raster',layers:'mtn_rasterizado',format:'image/png',attribution:'© Instituto Geográfico Nacional / CNIG'},
  pnoa:{label:'Vista aérea PNOA',url:'https://www.ign.es/wms-inspire/pnoa-ma',layers:'OI.OrthoimageCoverage',format:'image/jpeg',attribution:'© Instituto Geográfico Nacional / PNOA'}
};

function initNav(){$$('.nav-btn').forEach(btn=>btn.addEventListener('click',()=>{const name=btn.dataset.view;$$('.nav-btn').forEach(x=>x.classList.toggle('active',x===btn));$$('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));if(name==='map')setTimeout(()=>{map?.invalidateSize(true);c2MapLayer?.hardRefresh('nav')},120)}))}
function updateNetwork(){const on=navigator.onLine;$('#onlineDot').className=`dot ${on?'on':'off'}`;$('#onlineText').textContent=on?'Con conexión':'Sin conexión';if(on)c2MapLayer?.hardRefresh('online')}
window.addEventListener('online',updateNetwork);window.addEventListener('offline',updateNetwork);

function clamp(n,min,max){return Math.max(min,Math.min(max,n))}
function projectedBbox(bounds){
  const crs=map.options.crs;
  const sw=crs.project(bounds.getSouthWest());
  const ne=crs.project(bounds.getNorthEast());
  return [sw.x,sw.y,ne.x,ne.y].map(v=>Number(v).toFixed(2)).join(',');
}
function validBounds(bounds){return bounds&&Number.isFinite(bounds.getWest())&&Number.isFinite(bounds.getEast())&&Number.isFinite(bounds.getNorth())&&Number.isFinite(bounds.getSouth())&&bounds.getEast()>bounds.getWest()&&bounds.getNorth()>bounds.getSouth()}
function clampBoundsToSpain(bounds){
  const west=clamp(bounds.getWest(),SPAIN_BOUNDS.getWest(),SPAIN_BOUNDS.getEast());
  const east=clamp(bounds.getEast(),SPAIN_BOUNDS.getWest(),SPAIN_BOUNDS.getEast());
  const south=clamp(bounds.getSouth(),SPAIN_BOUNDS.getSouth(),SPAIN_BOUNDS.getNorth());
  const north=clamp(bounds.getNorth(),SPAIN_BOUNDS.getSouth(),SPAIN_BOUNDS.getNorth());
  if(east<=west||north<=south)return map.getBounds();
  return L.latLngBounds([south,west],[north,east]);
}
function paddedViewBounds(pad){
  const b=map.getBounds();
  const lat=(b.getNorth()-b.getSouth())*pad;
  const lng=(b.getEast()-b.getWest())*pad;
  return clampBoundsToSpain(L.latLngBounds([b.getSouth()-lat,b.getWest()-lng],[b.getNorth()+lat,b.getEast()+lng]));
}
function wmsUrl(cfg,bounds,width,height,tag){
  const params=new URLSearchParams({
    SERVICE:'WMS',VERSION:'1.1.1',REQUEST:'GetMap',LAYERS:cfg.layers,STYLES:'',SRS:'EPSG:3857',
    BBOX:projectedBbox(bounds),WIDTH:String(Math.round(width)),HEIGHT:String(Math.round(height)),
    FORMAT:cfg.format,TRANSPARENT:'FALSE',BGCOLOR:'0xD8DDCF',EXCEPTIONS:'INIMAGE',
    _: `${MAP_VERSION}-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  });
  return `${cfg.url}?${params.toString()}`;
}
function imageOk(img){return img&&img.naturalWidth>24&&img.naturalHeight>24}
function loadImage(src,timeout=22000){
  return new Promise((resolve,reject)=>{
    const img=new Image();let done=false;
    const finish=(ok)=>{if(done)return;done=true;clearTimeout(timer);ok?resolve(img):reject(new Error('imagen WMS no cargada'))};
    const timer=setTimeout(()=>finish(false),timeout);
    img.onload=()=>finish(imageOk(img));
    img.onerror=()=>finish(false);
    img.decoding='async';img.loading='eager';img.referrerPolicy='no-referrer-when-downgrade';img.src=src;
  });
}

class FullWmsLayer{
  constructor(cfg){
    this.cfg=cfg;this.map=null;this.root=null;this.fallback=null;this.current=null;this.loading=null;this.seq=0;this.timer=null;this.pending=false;this.lastGoodUrl='';this.lastGoodBounds=null;
    this.onMove=()=>this.positionAll();
    this.onZoomStart=()=>this.keepFallback();
    this.onEnd=()=>this.schedule('view',140);
    this.onZoomEnd=()=>this.schedule('zoom',20);
    this.onResize=()=>this.schedule('resize',120);
  }
  addTo(mapInstance){
    this.map=mapInstance;
    this.root=document.createElement('div');this.root.className='c2-wms-root';
    this.map.getContainer().appendChild(this.root);
    this.map.on('move zoom viewreset resize',this.onMove);
    this.map.on('zoomstart',this.onZoomStart);
    this.map.on('moveend',this.onEnd);
    this.map.on('zoomend',this.onZoomEnd);
    this.map.on('resize',this.onResize);
    this.refresh('inicio');
    setTimeout(()=>this.refresh('inicio2'),800);
    return this;
  }
  remove(){
    clearTimeout(this.timer);this.seq++;
    if(this.map){this.map.off('move zoom viewreset resize',this.onMove);this.map.off('zoomstart',this.onZoomStart);this.map.off('moveend',this.onEnd);this.map.off('zoomend',this.onZoomEnd);this.map.off('resize',this.onResize)}
    this.root?.remove();this.root=null;this.current=null;this.loading=null;this.fallback=null;this.map=null;
  }
  schedule(reason,delay=120){clearTimeout(this.timer);this.timer=setTimeout(()=>this.refresh(reason),delay)}
  hardRefresh(reason='manual'){this.keepFallback();this.refresh(reason,true)}
  padForZoom(){const z=this.map.getZoom();return z>=18?.18:z>=17?.25:z>=16?.32:z>=15?.42:z>=13?.55:z>=10?.75:1.0}
  imageSizeFor(bounds){
    const size=this.map.getSize();const b=this.map.getBounds();const dpr=clamp(window.devicePixelRatio||1,1,3);
    const wRatio=Math.max(1,(bounds.getEast()-bounds.getWest())/Math.max(.000001,b.getEast()-b.getWest()));
    const hRatio=Math.max(1,(bounds.getNorth()-bounds.getSouth())/Math.max(.000001,b.getNorth()-b.getSouth()));
    const z=this.map.getZoom();
    const quality=z>=16?2.05:z>=14?1.75:z>=11?1.45:1.25;
    const max=z>=16?3600:z>=13?3000:2400;
    const width=clamp(Math.round(size.x*wRatio*dpr*quality),900,max);
    const height=clamp(Math.round(size.y*hRatio*dpr*quality),900,max);
    return {width,height};
  }
  keepFallback(){
    if(!this.lastGoodUrl||!this.root)return;
    if(!this.fallback){
      const img=new Image();img.className='c2-wms-fallback';img.alt='';img.draggable=false;img.decoding='async';img.src=this.lastGoodUrl;this.root.prepend(img);this.fallback=img;
    }else if(this.fallback.src!==this.lastGoodUrl){this.fallback.src=this.lastGoodUrl}
  }
  positionEntry(entry){
    if(!entry||!entry.img||!entry.bounds||!this.map)return;
    const nw=this.map.latLngToContainerPoint(entry.bounds.getNorthWest());
    const se=this.map.latLngToContainerPoint(entry.bounds.getSouthEast());
    const left=Math.round(nw.x);const top=Math.round(nw.y);const width=Math.max(1,Math.round(se.x-nw.x));const height=Math.max(1,Math.round(se.y-nw.y));
    entry.img.style.transform=`translate3d(${left}px,${top}px,0)`;entry.img.style.width=`${width}px`;entry.img.style.height=`${height}px`;
  }
  positionAll(){this.positionEntry(this.current);this.positionEntry(this.loading)}
  async refresh(reason='view',force=false){
    if(!this.map||!this.root||!navigator.onLine)return;
    if(this.pending&&!force){this.schedule(reason,180);return}
    const bounds=paddedViewBounds(this.padForZoom());if(!validBounds(bounds))return;
    const {width,height}=this.imageSizeFor(bounds);
    const token=++this.seq;this.pending=true;this.keepFallback();
    const url=wmsUrl(this.cfg,bounds,width,height,`${reason}-z${this.map.getZoom().toFixed(2)}`);
    try{
      const loadingImg=await loadImage(url,24000);
      if(!this.map||!this.root||token!==this.seq)return;
      loadingImg.className='c2-wms-img c2-wms-loading';loadingImg.alt='';loadingImg.draggable=false;loadingImg.decoding='async';loadingImg.loading='eager';
      const loading={img:loadingImg,bounds,token};this.loading=loading;
      this.root.appendChild(loadingImg);this.positionEntry(loading);
      requestAnimationFrame(()=>{
        if(!this.map||token!==this.seq)return;
        loadingImg.classList.remove('c2-wms-loading');loadingImg.classList.add('c2-wms-current');
        const old=this.current;this.current=loading;this.loading=null;this.lastGoodUrl=url;this.lastGoodBounds=bounds;this.keepFallback();
        setTimeout(()=>{if(old?.img&&old!==this.current)old.img.remove()},260);
      });
    }catch(err){
      console.warn('Plano WMS no cargó; se mantiene el plano anterior',err);
    }finally{if(token===this.seq)this.pending=false}
  }
}

function initMap(){
  map=L.map('map',{zoomControl:false,preferCanvas:false,fadeAnimation:false,zoomAnimation:true,markerZoomAnimation:true,inertia:true,worldCopyJump:false,minZoom:5,maxZoom:19,maxBounds:SPAIN_BOUNDS,maxBoundsViscosity:.45}).setView([40.4168,-3.7038],6);
  map.createPane('positionPane');map.getPane('positionPane').style.zIndex=950;map.getPane('positionPane').style.pointerEvents='none';
  L.control.zoom({position:'bottomright'}).addTo(map);
  const saved=localStorage.getItem('c2-map-layer');setMapLayer(saved&&MAP_LAYERS[saved]?saved:'ign');
  $('#mapLayerSelect')?.addEventListener('change',e=>setMapLayer(e.target.value));
  $('#reloadMapBtn')?.addEventListener('click',()=>c2MapLayer?.hardRefresh('boton'));
  ['resize','orientationchange'].forEach(ev=>window.addEventListener(ev,()=>setTimeout(()=>{map.invalidateSize(true);c2MapLayer?.hardRefresh(ev)},250)));
}
function setMapLayer(key){
  if(!MAP_LAYERS[key])key='ign';
  localStorage.setItem('c2-map-layer',key);
  if(c2MapLayer)c2MapLayer.remove();
  c2MapLayer=new FullWmsLayer(MAP_LAYERS[key]).addTo(map);
  const select=$('#mapLayerSelect');if(select)select.value=key;
}

initMap();
function iconFor(type){const cls=type==='warning'?'warning-marker':type;return L.divIcon({className:'',html:`<div class="tactical-marker ${cls}"></div>`,iconSize:[22,22],iconAnchor:[11,11]})}
function drawMarkers(){state.markers.forEach(m=>L.marker([m.lat,m.lng],{icon:iconFor(m.type),zIndexOffset:600}).addTo(map).bindPopup(`<strong>${escapeHtml(m.name)}</strong><br>${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}`))}drawMarkers();
function userPositionIcon(heading=0){const h=Number.isFinite(heading)?heading:0;return L.divIcon({className:'user-position-icon',html:`<div class="user-position-wrap" style="--heading:${h}deg"><div class="user-position-bearing"></div><div class="user-position-center"></div></div>`,iconSize:[56,56],iconAnchor:[28,28]})}
function updatePosition(pos,center=true){
  const{latitude:lat,longitude:lng,accuracy,heading}=pos.coords;const h=Number.isFinite(heading)?heading:state.lastHeading;state.lastHeading=Number.isFinite(h)?h:0;
  $('#coords').textContent=`${lat.toFixed(6)}, ${lng.toFixed(6)}`;$('#accuracy').textContent=`Precisión: ±${Math.round(accuracy)} m`;const gps=$('#gpsStatus');if(gps)gps.textContent='GPS activo';
  const latlng=L.latLng(lat,lng);
  if(state.userMarker){state.userMarker.setLatLng(latlng);state.userMarker.setIcon(userPositionIcon(state.lastHeading))}
  else state.userMarker=L.marker(latlng,{icon:userPositionIcon(state.lastHeading),pane:'positionPane',zIndexOffset:9000,keyboard:false,interactive:false}).addTo(map).bindPopup('Mi posición');
  if(center){map.setView(latlng,Math.max(map.getZoom(),17),{animate:false});setTimeout(()=>c2MapLayer?.hardRefresh('gps'),120)}
}
function geoError(e){const msg=e?.message||'Error desconocido';const gps=$('#gpsStatus');if(gps)gps.textContent=`GPS: ${msg}`;alert(`No se pudo obtener la posición: ${msg}. Comprueba permisos y que la web esté en HTTPS.`)}
function askPosition(center=true){if(!navigator.geolocation){alert('Geolocalización no disponible');return}const gps=$('#gpsStatus');if(gps)gps.textContent='Buscando GPS…';navigator.geolocation.getCurrentPosition(p=>updatePosition(p,center),geoError,{enableHighAccuracy:true,timeout:15000,maximumAge:1000})}
$('#locateBtn').addEventListener('click',()=>askPosition(true));
$('#trackBtn').addEventListener('click',()=>{if(state.watchId!==null){navigator.geolocation.clearWatch(state.watchId);state.watchId=null;$('#trackBtn').textContent='Iniciar seguimiento';const gps=$('#gpsStatus');if(gps)gps.textContent='Seguimiento detenido';return}if(!navigator.geolocation)return alert('Geolocalización no disponible');const gps=$('#gpsStatus');if(gps)gps.textContent='Seguimiento GPS activo';state.watchId=navigator.geolocation.watchPosition(p=>updatePosition(p,false),geoError,{enableHighAccuracy:true,maximumAge:1000,timeout:15000});$('#trackBtn').textContent='Detener seguimiento'});
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

if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(console.error));initNav();updateNetwork();loadSettings();renderMessages();renderDocuments();
