import{saveDocument,listDocuments,deleteDocument}from'./db.js';
const $=s=>document.querySelector(s);const $$=s=>[...document.querySelectorAll(s)];
const state={settings:JSON.parse(localStorage.getItem('c2-settings')||'{"callsign":"Jefe de sección","unit":"Puesto de mando"}'),messages:JSON.parse(localStorage.getItem('c2-messages')||'[]'),markers:JSON.parse(localStorage.getItem('c2-markers')||'[]'),pendingMarker:null,watchId:null,userFeature:null,lastHeading:0};
const persist=(key,value)=>localStorage.setItem(key,JSON.stringify(value));

let map=null,view=null,vectorSource=null,vectorLayer=null,activeRaster=null,pendingRaster=null,refreshTimer=null,layerSwitchSeq=0;
const MAP_VERSION='ol-wms-v1';
const MAP_BG='#d8ddcf';
const SPAIN_EXTENT_LONLAT=[-20,25,6,46];
const MAP_LAYERS={
  ign:{label:'IGN topográfico militar',url:'https://www.ign.es/wms-inspire/mapa-raster',layers:'mtn_rasterizado',format:'image/png',attribution:'© Instituto Geográfico Nacional / CNIG'},
  pnoa:{label:'Vista aérea PNOA',url:'https://www.ign.es/wms-inspire/pnoa-ma',layers:'OI.OrthoimageCoverage',format:'image/jpeg',attribution:'© Instituto Geográfico Nacional / PNOA'}
};

function initNav(){
  $$('.nav-btn').forEach(btn=>btn.addEventListener('click',()=>{
    const name=btn.dataset.view;
    $$('.nav-btn').forEach(x=>x.classList.toggle('active',x===btn));
    $$('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));
    if(name==='map')setTimeout(()=>{map?.updateSize();refreshRaster('nav',true)},120);
  }));
}
function updateNetwork(){const on=navigator.onLine;$('#onlineDot').className=`dot ${on?'on':'off'}`;$('#onlineText').textContent=on?'Con conexión':'Sin conexión';if(on)refreshRaster('online',true)}
window.addEventListener('online',updateNetwork);window.addEventListener('offline',updateNetwork);

function buildWmsSource(cfg){
  return new ol.source.ImageWMS({
    url:cfg.url,
    ratio:3.2,
    hidpi:true,
    projection:'EPSG:3857',
    params:{
      SERVICE:'WMS',VERSION:'1.1.1',REQUEST:'GetMap',LAYERS:cfg.layers,STYLES:'',
      FORMAT:cfg.format,TRANSPARENT:false,BGCOLOR:'0xD8DDCF',EXCEPTIONS:'INIMAGE',_t:`${MAP_VERSION}-${Date.now()}`
    }
  });
}
function buildRasterLayer(key,opacity=1){
  const cfg=MAP_LAYERS[key]||MAP_LAYERS.ign;
  const source=buildWmsSource(cfg);
  const layer=new ol.layer.Image({source,opacity,zIndex:1,className:'c2-raster-layer'});
  return{key,cfg,source,layer};
}
function refreshRaster(reason='manual',force=false){
  clearTimeout(refreshTimer);
  refreshTimer=setTimeout(()=>{
    if(!activeRaster?.source||!navigator.onLine)return;
    activeRaster.source.updateParams({_t:`${MAP_VERSION}-${reason}-z${view?.getZoom()?.toFixed?.(2)||0}-${Date.now()}`});
  },force?20:120);
}
function setMapLayer(key){
  if(!MAP_LAYERS[key])key='ign';
  const select=$('#mapLayerSelect');if(select)select.value=key;
  localStorage.setItem('c2-map-layer',key);
  if(!map)return;
  const seq=++layerSwitchSeq;
  if(pendingRaster){map.removeLayer(pendingRaster.layer);pendingRaster=null;}
  const next=buildRasterLayer(key,activeRaster?0:1);
  pendingRaster=next;
  map.addLayer(next.layer);
  const promote=()=>{
    if(seq!==layerSwitchSeq)return;
    next.layer.setOpacity(1);
    next.layer.setZIndex(1);
    if(activeRaster&&activeRaster.layer!==next.layer)map.removeLayer(activeRaster.layer);
    activeRaster=next;pendingRaster=null;
    refreshRaster('cambio-capa',true);
  };
  const fail=()=>{
    if(seq!==layerSwitchSeq)return;
    next.layer.setOpacity(0);
    setTimeout(()=>{if(pendingRaster===next){map.removeLayer(next.layer);pendingRaster=null;}},200);
    if(!activeRaster){activeRaster=next;next.layer.setOpacity(1);}
  };
  next.source.once('imageloadend',promote);
  next.source.once('imageloaderror',fail);
  if(!activeRaster)activeRaster=next;
  setTimeout(()=>{if(pendingRaster===next&&seq===layerSwitchSeq)promote();},4500);
}
function initMap(){
  if(!window.ol){
    const mapEl=$('#map');if(mapEl)mapEl.innerHTML='<div class="map-error">No se ha podido cargar la librería de mapas. Comprueba conexión.</div>';
    return;
  }
  const extent=ol.proj.transformExtent(SPAIN_EXTENT_LONLAT,'EPSG:4326','EPSG:3857');
  vectorSource=new ol.source.Vector();
  vectorLayer=new ol.layer.Vector({source:vectorSource,zIndex:20,style:featureStyle});
  view=new ol.View({
    center:ol.proj.fromLonLat([-3.7038,40.4168]),zoom:6,minZoom:5,maxZoom:19,extent,
    constrainOnlyCenter:true,smoothExtentConstraint:true,smoothResolutionConstraint:true
  });
  map=new ol.Map({target:'map',view,layers:[vectorLayer]});
  const saved=localStorage.getItem('c2-map-layer');setMapLayer(saved&&MAP_LAYERS[saved]?saved:'ign');
  $('#mapLayerSelect')?.addEventListener('change',e=>setMapLayer(e.target.value));
  $('#reloadMapBtn')?.addEventListener('click',()=>refreshRaster('boton',true));
  map.on('moveend',()=>refreshRaster('moveend'));
  map.on('singleclick',evt=>handleMapClick(evt));
  ['resize','orientationchange'].forEach(ev=>window.addEventListener(ev,()=>setTimeout(()=>{map?.updateSize();refreshRaster(ev,true)},260)));
}

function colorFor(type){return type==='warning'?'#e3b54e':type==='objective'?'#d26058':type==='medical'?'#51a774':'#4d86d8'}
function tacticalStyle(type){return new ol.style.Style({image:new ol.style.RegularShape({points:4,radius:11,angle:Math.PI/4,fill:new ol.style.Fill({color:colorFor(type)}),stroke:new ol.style.Stroke({color:'#fff',width:2})})})}
function gpsStyle(feature){
  const heading=Number(feature.get('heading'))||0;
  return new ol.style.Style({
    image:new ol.style.RegularShape({points:3,radius:21,rotation:heading*Math.PI/180,angle:0,fill:new ol.style.Fill({color:'#1e88ff'}),stroke:new ol.style.Stroke({color:'#fff',width:4})}),
    zIndex:999
  });
}
function featureStyle(feature){return feature.get('kind')==='gps'?gpsStyle(feature):tacticalStyle(feature.get('type'))}
function drawMarkers(){
  if(!vectorSource)return;
  state.markers.forEach(m=>{
    const f=new ol.Feature({geometry:new ol.geom.Point(ol.proj.fromLonLat([m.lng,m.lat])),kind:'marker',type:m.type,name:m.name,lat:m.lat,lng:m.lng});
    vectorSource.addFeature(f);
  });
}
function handleMapClick(evt){
  if(!state.pendingMarker||!vectorSource)return;
  const [lng,lat]=ol.proj.toLonLat(evt.coordinate);
  const m={id:crypto.randomUUID(),...state.pendingMarker,lat,lng,createdAt:new Date().toISOString()};
  state.markers.push(m);persist('c2-markers',state.markers);
  const f=new ol.Feature({geometry:new ol.geom.Point(evt.coordinate),kind:'marker',type:m.type,name:m.name,lat:m.lat,lng:m.lng});
  vectorSource.addFeature(f);state.pendingMarker=null;$('#markerForm').reset();
}

function updatePosition(pos,center=true){
  if(!map||!vectorSource)return;
  const{latitude:lat,longitude:lng,accuracy,heading}=pos.coords;
  const h=Number.isFinite(heading)?heading:state.lastHeading;state.lastHeading=Number.isFinite(h)?h:0;
  $('#coords').textContent=`${lat.toFixed(6)}, ${lng.toFixed(6)}`;$('#accuracy').textContent=`Precisión: ±${Math.round(accuracy)} m`;const gps=$('#gpsStatus');if(gps)gps.textContent='GPS activo';
  const coordinate=ol.proj.fromLonLat([lng,lat]);
  if(state.userFeature){state.userFeature.getGeometry().setCoordinates(coordinate);state.userFeature.set('heading',state.lastHeading);state.userFeature.changed();}
  else{state.userFeature=new ol.Feature({geometry:new ol.geom.Point(coordinate),kind:'gps',heading:state.lastHeading});vectorSource.addFeature(state.userFeature);}
  if(center){view.setCenter(coordinate);view.setZoom(Math.max(view.getZoom(),17));setTimeout(()=>refreshRaster('gps',true),180)}
}
function geoError(e){const msg=e?.message||'Error desconocido';const gps=$('#gpsStatus');if(gps)gps.textContent=`GPS: ${msg}`;alert(`No se pudo obtener la posición: ${msg}. Comprueba permisos y que la web esté en HTTPS.`)}
function askPosition(center=true){if(!navigator.geolocation){alert('Geolocalización no disponible');return}const gps=$('#gpsStatus');if(gps)gps.textContent='Buscando GPS…';navigator.geolocation.getCurrentPosition(p=>updatePosition(p,center),geoError,{enableHighAccuracy:true,timeout:15000,maximumAge:1000})}

function escapeHtml(v){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function renderMessages(){const box=$('#messageList');box.innerHTML=state.messages.length?'':'<div class="empty">Todavía no hay mensajes.</div>';state.messages.forEach(m=>{const el=document.createElement('article');el.className='message mine';el.innerHTML=`<header><strong>${escapeHtml(m.author)}</strong><time>${new Date(m.createdAt).toLocaleString()}</time></header><p>${escapeHtml(m.text)}</p>`;box.append(el)});box.scrollTop=box.scrollHeight}
function humanSize(n){if(n<1024)return`${n} B`;if(n<1048576)return`${(n/1024).toFixed(1)} KB`;return`${(n/1048576).toFixed(1)} MB`}
async function renderDocuments(){const docs=await listDocuments(),box=$('#documentList');box.innerHTML=docs.length?'':'<div class="empty">No hay documentos almacenados.</div>';docs.forEach(d=>{const el=document.createElement('article');el.className='document';el.innerHTML=`<div class="doc-icon">${escapeHtml(d.name.split('.').pop().slice(0,4).toUpperCase())}</div><div><strong>${escapeHtml(d.name)}</strong><small>${humanSize(d.size)} · ${new Date(d.createdAt).toLocaleString()}</small></div><div class="doc-actions"><button data-download>Descargar</button><button data-delete>Eliminar</button></div>`;el.querySelector('[data-download]').onclick=()=>{const url=URL.createObjectURL(d.blob),a=document.createElement('a');a.href=url;a.download=d.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};el.querySelector('[data-delete]').onclick=async()=>{if(confirm(`¿Eliminar ${d.name}?`)){await deleteDocument(d.id);renderDocuments()}};box.append(el)})}
async function addFiles(files){for(const f of files){try{await saveDocument(f)}catch(err){alert(`No se pudo guardar ${f.name}: ${err.message}`)}}renderDocuments()}
function loadSettings(){$('#callsignInput').value=state.settings.callsign||'';$('#unitInput').value=state.settings.unit||'';$('#unitLabel').textContent=state.settings.unit||'Puesto de mando'}

function initUi(){
  $('#locateBtn')?.addEventListener('click',()=>askPosition(true));
  $('#trackBtn')?.addEventListener('click',()=>{if(state.watchId!==null){navigator.geolocation.clearWatch(state.watchId);state.watchId=null;$('#trackBtn').textContent='Iniciar seguimiento';const gps=$('#gpsStatus');if(gps)gps.textContent='Seguimiento detenido';return}if(!navigator.geolocation)return alert('Geolocalización no disponible');const gps=$('#gpsStatus');if(gps)gps.textContent='Seguimiento GPS activo';state.watchId=navigator.geolocation.watchPosition(p=>updatePosition(p,false),geoError,{enableHighAccuracy:true,maximumAge:1000,timeout:15000});$('#trackBtn').textContent='Detener seguimiento'});
  $('#addMarkerBtn')?.addEventListener('click',()=>$('#markerDialog').showModal());
  $('#markerForm')?.addEventListener('submit',e=>{if(e.submitter?.value==='cancel')return;state.pendingMarker={name:$('#markerName').value.trim(),type:$('#markerType').value};alert('Pulsa una ubicación del mapa para colocar el punto.')});
  $('#chatForm')?.addEventListener('submit',e=>{e.preventDefault();const input=$('#chatInput'),text=input.value.trim();if(!text)return;state.messages.push({id:crypto.randomUUID(),author:state.settings.callsign||'Usuario',text,createdAt:new Date().toISOString()});persist('c2-messages',state.messages);input.value='';renderMessages()});
  $('#clearChatBtn')?.addEventListener('click',()=>{if(confirm('¿Vaciar todos los mensajes locales?')){state.messages=[];persist('c2-messages',[]);renderMessages()}});
  $('#fileInput')?.addEventListener('change',e=>addFiles(e.target.files));const dz=$('#dropZone');if(dz){['dragenter','dragover'].forEach(t=>dz.addEventListener(t,e=>{e.preventDefault();dz.classList.add('drag')}));['dragleave','drop'].forEach(t=>dz.addEventListener(t,e=>{e.preventDefault();dz.classList.remove('drag')}));dz.addEventListener('drop',e=>addFiles(e.dataTransfer.files));}
  $('#settingsForm')?.addEventListener('submit',e=>{e.preventDefault();state.settings={callsign:$('#callsignInput').value.trim()||'Usuario',unit:$('#unitInput').value.trim()||'Puesto de mando'};persist('c2-settings',state.settings);loadSettings();alert('Ajustes guardados')});
  $('#exportBtn')?.addEventListener('click',()=>{const payload={version:1,exportedAt:new Date().toISOString(),settings:state.settings,messages:state.messages,markers:state.markers};const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`seccion-c2-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)});
  $('#importInput')?.addEventListener('change',async e=>{try{const data=JSON.parse(await e.target.files[0].text());if(!data||data.version!==1)throw new Error('Formato no compatible');state.settings=data.settings||state.settings;state.messages=Array.isArray(data.messages)?data.messages:[];state.markers=Array.isArray(data.markers)?data.markers:[];persist('c2-settings',state.settings);persist('c2-messages',state.messages);persist('c2-markers',state.markers);location.reload()}catch(err){alert(`Importación fallida: ${err.message}`)}});
}

initMap();drawMarkers();initUi();initNav();updateNetwork();loadSettings();renderMessages();renderDocuments();
if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(console.error));
