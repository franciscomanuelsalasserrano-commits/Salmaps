import { saveDocument, listDocuments, deleteDocument } from './db.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const state = {
  settings: JSON.parse(localStorage.getItem('c2-settings') || '{"callsign":"Jefe de sección","unit":"Puesto de mando"}'),
  messages: JSON.parse(localStorage.getItem('c2-messages') || '[]'),
  markers: JSON.parse(localStorage.getItem('c2-markers') || '[]'),
  pendingMarker: null,
  watchId: null,
  userMarker: null,
  accuracyCircle: null,
  heading: 0
};
const persist = (key, value) => localStorage.setItem(key, JSON.stringify(value));

let map;
let activeMapKey = localStorage.getItem('c2-map-layer') || 'topo';
let floorOverlay = null;
let detailOverlay = null;
let loadingOverlay = null;
let detailRequestId = 0;
let detailTimer = null;

const MAP_VERSION = 'ign-online-clean-v1';
const SPAIN_BOUNDS = L.latLngBounds([[25.0, -20.5], [45.2, 6.2]]);
const IGN_LAYERS = {
  topo: {
    label: 'IGN topográfico',
    url: 'https://www.ign.es/wms-inspire/mapa-raster',
    layer: 'mtn_rasterizado',
    format: 'image/jpeg',
    bg: '0xD8DDCF',
    attribution: '© Instituto Geográfico Nacional / CNIG'
  },
  pnoa: {
    label: 'IGN vista aérea',
    url: 'https://www.ign.es/wms-inspire/pnoa-ma',
    layer: 'OI.OrthoimageCoverage',
    format: 'image/jpeg',
    bg: '0xD8DDCF',
    attribution: '© Instituto Geográfico Nacional / PNOA'
  }
};

function setMapStatus(text) {
  const el = $('#mapStatus');
  if (el) el.textContent = text;
}

function updateNetwork() {
  const on = navigator.onLine;
  $('#onlineDot').className = `dot ${on ? 'on' : 'off'}`;
  $('#onlineText').textContent = on ? 'Con conexión' : 'Sin conexión';
  if (on && map) refreshOnlineMap(true);
}
window.addEventListener('online', updateNetwork);
window.addEventListener('offline', updateNetwork);

function initNav() {
  $$('.nav-btn').forEach(btn => btn.addEventListener('click', () => {
    const name = btn.dataset.view;
    $$('.nav-btn').forEach(x => x.classList.toggle('active', x === btn));
    $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
    if (name === 'map') setTimeout(() => {
      map?.invalidateSize();
      refreshOnlineMap(true);
    }, 150);
  }));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function boundsTo3857(bounds) {
  const sw = map.options.crs.project(bounds.getSouthWest());
  const ne = map.options.crs.project(bounds.getNorthEast());
  return [sw.x, sw.y, ne.x, ne.y];
}

function wmsUrl(key, bounds, width, height) {
  const cfg = IGN_LAYERS[key] || IGN_LAYERS.topo;
  const bbox = boundsTo3857(bounds).map(n => Number(n).toFixed(2)).join(',');
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.1.1',
    REQUEST: 'GetMap',
    LAYERS: cfg.layer,
    STYLES: '',
    FORMAT: cfg.format,
    SRS: 'EPSG:3857',
    BBOX: bbox,
    WIDTH: String(Math.round(width)),
    HEIGHT: String(Math.round(height)),
    TRANSPARENT: 'FALSE',
    BGCOLOR: cfg.bg,
    EXCEPTIONS: 'application/vnd.ogc.se_inimage',
    _v: `${MAP_VERSION}-${Date.now()}`
  });
  return `${cfg.url}?${params.toString()}`;
}

function imageSizeForBounds(bounds) {
  const nw = map.latLngToLayerPoint(bounds.getNorthWest());
  const se = map.latLngToLayerPoint(bounds.getSouthEast());
  const dpr = clamp(window.devicePixelRatio || 1, 1, 1.65);
  const w = clamp(Math.abs(se.x - nw.x) * dpr, 640, 2200);
  const h = clamp(Math.abs(se.y - nw.y) * dpr, 640, 2200);
  return { width: w, height: h };
}

function preloadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = url;
  });
}

async function loadFloor(key) {
  const cfg = IGN_LAYERS[key] || IGN_LAYERS.topo;
  const url = wmsUrl(key, SPAIN_BOUNDS, 1800, 1400);
  try {
    await preloadImage(url);
    const next = L.imageOverlay(url, SPAIN_BOUNDS, {
      pane: 'ignFloorPane',
      opacity: 1,
      interactive: false,
      attribution: cfg.attribution
    });
    next.addTo(map);
    if (floorOverlay) map.removeLayer(floorOverlay);
    floorOverlay = next;
  } catch (err) {
    console.warn('No se pudo cargar la base IGN:', err);
  }
}

function currentDetailBounds() {
  const zoom = map.getZoom();
  const pad = zoom <= 7 ? 0.95 : zoom <= 11 ? 0.7 : 0.45;
  return map.getBounds().pad(pad);
}

async function loadDetail(force = false) {
  if (!map || !navigator.onLine) return;
  const requestId = ++detailRequestId;
  const key = activeMapKey;
  const bounds = currentDetailBounds();
  const { width, height } = imageSizeForBounds(bounds);
  const url = wmsUrl(key, bounds, width, height);
  if (force) setMapStatus(`Actualizando ${IGN_LAYERS[key].label}…`);

  try {
    await preloadImage(url);
    if (requestId !== detailRequestId || key !== activeMapKey) return;
    const next = L.imageOverlay(url, bounds, {
      pane: 'ignDetailPane',
      opacity: 1,
      interactive: false,
      attribution: IGN_LAYERS[key].attribution
    });
    next.addTo(map);
    if (loadingOverlay) {
      map.removeLayer(loadingOverlay);
      loadingOverlay = null;
    }
    if (detailOverlay) map.removeLayer(detailOverlay);
    detailOverlay = next;
    setMapStatus(`${IGN_LAYERS[key].label} cargado`);
  } catch (err) {
    console.warn('No se pudo cargar el detalle IGN:', err);
    if (!detailOverlay && floorOverlay) setMapStatus('Base cargada; esperando detalle IGN');
    else setMapStatus('Plano anterior mantenido');
  }
}

function refreshOnlineMap(force = false) {
  clearTimeout(detailTimer);
  detailTimer = setTimeout(() => loadDetail(force), force ? 30 : 220);
}

function switchMapLayer(key) {
  if (!IGN_LAYERS[key]) key = 'topo';
  activeMapKey = key;
  localStorage.setItem('c2-map-layer', key);
  const select = $('#mapLayerSelect');
  if (select) select.value = key;
  detailRequestId++;
  if (detailOverlay) {
    map.removeLayer(detailOverlay);
    detailOverlay = null;
  }
  if (loadingOverlay) {
    map.removeLayer(loadingOverlay);
    loadingOverlay = null;
  }
  setMapStatus(`Cargando ${IGN_LAYERS[key].label} online…`);
  loadFloor(key);
  refreshOnlineMap(true);
}

function initMap() {
  map = L.map('map', {
    zoomControl: false,
    preferCanvas: false,
    maxBounds: SPAIN_BOUNDS.pad(0.35),
    maxBoundsViscosity: 0.25,
    worldCopyJump: false,
    inertia: true
  }).setView([40.4168, -3.7038], 6);

  map.createPane('ignFloorPane');
  map.getPane('ignFloorPane').style.zIndex = 180;
  map.createPane('ignDetailPane');
  map.getPane('ignDetailPane').style.zIndex = 190;
  map.createPane('gpsPane');
  map.getPane('gpsPane').style.zIndex = 650;

  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.control.attribution({ prefix: false, position: 'bottomleft' }).addTo(map);

  $('#mapLayerSelect')?.addEventListener('change', e => switchMapLayer(e.target.value));
  $('#reloadMapBtn')?.addEventListener('click', () => {
    loadFloor(activeMapKey);
    refreshOnlineMap(true);
  });

  map.on('moveend zoomend resize', () => refreshOnlineMap(false));
  map.on('zoomstart movestart', () => setMapStatus('Manteniendo plano anterior'));

  switchMapLayer(activeMapKey);
  drawMarkers();
}

function gpsDivIcon(heading = 0) {
  return L.divIcon({
    className: 'gps-triangle-icon',
    html: `<div class="gps-triangle" style="--heading:${heading}deg"><span></span></div>`,
    iconSize: [38, 38],
    iconAnchor: [19, 19]
  });
}

function iconFor(type) {
  const cls = type === 'warning' ? 'warning-marker' : type;
  return L.divIcon({
    className: '',
    html: `<div class="tactical-marker ${cls}"></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11]
  });
}

function drawMarkers() {
  state.markers.forEach(m => L.marker([m.lat, m.lng], { icon: iconFor(m.type) })
    .addTo(map)
    .bindPopup(`<strong>${escapeHtml(m.name)}</strong><br>${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}`));
}

function updatePosition(pos, center = true) {
  const { latitude: lat, longitude: lng, accuracy, heading } = pos.coords;
  if (Number.isFinite(heading)) state.heading = heading;
  $('#coords').textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  $('#accuracy').textContent = `Precisión: ±${Math.round(accuracy)} m`;

  const ll = [lat, lng];
  if (state.userMarker) {
    state.userMarker.setLatLng(ll);
    state.userMarker.setIcon(gpsDivIcon(state.heading));
  } else {
    state.userMarker = L.marker(ll, {
      icon: gpsDivIcon(state.heading),
      pane: 'gpsPane',
      zIndexOffset: 10000,
      interactive: false
    }).addTo(map).bindPopup('Mi posición');
  }

  if (state.accuracyCircle) {
    state.accuracyCircle.setLatLng(ll).setRadius(accuracy);
  } else {
    state.accuracyCircle = L.circle(ll, {
      pane: 'gpsPane',
      radius: accuracy,
      color: '#1e88ff',
      weight: 1,
      fillColor: '#1e88ff',
      fillOpacity: 0.07,
      interactive: false
    }).addTo(map);
  }

  if (center) {
    map.setView(ll, Math.max(map.getZoom(), 16), { animate: true });
    setTimeout(() => refreshOnlineMap(true), 450);
  }
}

function geoError(e) {
  alert(`No se pudo obtener la posición: ${e.message}. Comprueba permisos y que la web esté en HTTPS.`);
}

$('#locateBtn').addEventListener('click', () => navigator.geolocation
  ? navigator.geolocation.getCurrentPosition(p => updatePosition(p, true), geoError, { enableHighAccuracy: true, timeout: 15000, maximumAge: 3000 })
  : alert('Geolocalización no disponible'));

$('#trackBtn').addEventListener('click', () => {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
    $('#trackBtn').textContent = 'Iniciar seguimiento';
    return;
  }
  if (!navigator.geolocation) return alert('Geolocalización no disponible');
  state.watchId = navigator.geolocation.watchPosition(p => updatePosition(p, false), geoError, { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 });
  $('#trackBtn').textContent = 'Detener seguimiento';
});

$('#addMarkerBtn').addEventListener('click', () => $('#markerDialog').showModal());
$('#markerForm').addEventListener('submit', e => {
  if (e.submitter?.value === 'cancel') return;
  state.pendingMarker = { name: $('#markerName').value.trim(), type: $('#markerType').value };
  alert('Pulsa una ubicación del mapa para colocar el punto.');
});

function handleMapClick(e) {
  if (!state.pendingMarker) return;
  const m = {
    id: crypto.randomUUID(),
    ...state.pendingMarker,
    lat: e.latlng.lat,
    lng: e.latlng.lng,
    createdAt: new Date().toISOString()
  };
  state.markers.push(m);
  persist('c2-markers', state.markers);
  L.marker(e.latlng, { icon: iconFor(m.type) })
    .addTo(map)
    .bindPopup(`<strong>${escapeHtml(m.name)}</strong>`)
    .openPopup();
  state.pendingMarker = null;
  $('#markerForm').reset();
}

function escapeHtml(v) {
  return String(v).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function renderMessages() {
  const box = $('#messageList');
  box.innerHTML = state.messages.length ? '' : '<div class="empty">Todavía no hay mensajes.</div>';
  state.messages.forEach(m => {
    const el = document.createElement('article');
    el.className = 'message mine';
    el.innerHTML = `<header><strong>${escapeHtml(m.author)}</strong><time>${new Date(m.createdAt).toLocaleString()}</time></header><p>${escapeHtml(m.text)}</p>`;
    box.append(el);
  });
  box.scrollTop = box.scrollHeight;
}

$('#chatForm').addEventListener('submit', e => {
  e.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  state.messages.push({ id: crypto.randomUUID(), author: state.settings.callsign || 'Usuario', text, createdAt: new Date().toISOString() });
  persist('c2-messages', state.messages);
  input.value = '';
  renderMessages();
});
$('#clearChatBtn').addEventListener('click', () => {
  if (confirm('¿Vaciar todos los mensajes locales?')) {
    state.messages = [];
    persist('c2-messages', []);
    renderMessages();
  }
});

function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

async function renderDocuments() {
  const docs = await listDocuments();
  const box = $('#documentList');
  box.innerHTML = docs.length ? '' : '<div class="empty">No hay documentos almacenados.</div>';
  docs.forEach(d => {
    const el = document.createElement('article');
    el.className = 'document';
    el.innerHTML = `<div class="doc-icon">${escapeHtml(d.name.split('.').pop().slice(0, 4).toUpperCase())}</div><div><strong>${escapeHtml(d.name)}</strong><small>${humanSize(d.size)} · ${new Date(d.createdAt).toLocaleString()}</small></div><div class="doc-actions"><button data-download>Descargar</button><button data-delete>Eliminar</button></div>`;
    el.querySelector('[data-download]').onclick = () => {
      const url = URL.createObjectURL(d.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = d.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    el.querySelector('[data-delete]').onclick = async () => {
      if (confirm(`¿Eliminar ${d.name}?`)) {
        await deleteDocument(d.id);
        renderDocuments();
      }
    };
    box.append(el);
  });
}

async function addFiles(files) {
  for (const f of files) {
    try { await saveDocument(f); }
    catch (err) { alert(`No se pudo guardar ${f.name}: ${err.message}`); }
  }
  renderDocuments();
}
$('#fileInput').addEventListener('change', e => addFiles(e.target.files));
const dz = $('#dropZone');
['dragenter', 'dragover'].forEach(t => dz.addEventListener(t, e => { e.preventDefault(); dz.classList.add('drag'); }));
['dragleave', 'drop'].forEach(t => dz.addEventListener(t, e => { e.preventDefault(); dz.classList.remove('drag'); }));
dz.addEventListener('drop', e => addFiles(e.dataTransfer.files));

function loadSettings() {
  $('#callsignInput').value = state.settings.callsign || '';
  $('#unitInput').value = state.settings.unit || '';
  $('#unitLabel').textContent = state.settings.unit || 'Puesto de mando';
}
$('#settingsForm').addEventListener('submit', e => {
  e.preventDefault();
  state.settings = { callsign: $('#callsignInput').value.trim() || 'Usuario', unit: $('#unitInput').value.trim() || 'Puesto de mando' };
  persist('c2-settings', state.settings);
  loadSettings();
  alert('Ajustes guardados');
});
$('#exportBtn').addEventListener('click', () => {
  const payload = { version: 1, exportedAt: new Date().toISOString(), settings: state.settings, messages: state.messages, markers: state.markers };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `seccion-c2-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('#importInput').addEventListener('change', async e => {
  try {
    const data = JSON.parse(await e.target.files[0].text());
    if (!data || data.version !== 1) throw new Error('Formato no compatible');
    state.settings = data.settings || state.settings;
    state.messages = Array.isArray(data.messages) ? data.messages : [];
    state.markers = Array.isArray(data.markers) ? data.markers : [];
    persist('c2-settings', state.settings);
    persist('c2-messages', state.messages);
    persist('c2-markers', state.markers);
    location.reload();
  } catch (err) {
    alert(`Importación fallida: ${err.message}`);
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(console.error));
}

initMap();
map.on('click', handleMapClick);
initNav();
updateNetwork();
loadSettings();
renderMessages();
renderDocuments();
