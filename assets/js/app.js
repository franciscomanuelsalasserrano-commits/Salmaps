const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const APP_VERSION = 'planos-reset-v1';
const STORAGE = {
  settings: 'c2-settings',
  messages: 'c2-messages',
  markers: 'c2-markers',
  docs: 'c2-documents',
  layer: 'c2-map-layer'
};

const state = {
  settings: readJson(STORAGE.settings, { callsign: 'Jefe de sección', unit: 'Puesto de mando' }),
  messages: readJson(STORAGE.messages, []),
  markers: readJson(STORAGE.markers, []),
  documents: readJson(STORAGE.docs, []),
  pendingMarker: null,
  watchId: null,
  userMarker: null,
  accuracyCircle: null,
  lastHeading: 0,
  tracking: false
};

let map;
let mapImages;

const SPAIN_BOUNDS = L.latLngBounds([27.0, -18.8], [44.6, 5.2]);
const INITIAL_VIEW = { center: [40.25, -3.7], zoom: 6 };

const MAP_LAYERS = {
  topo: {
    label: 'IGN topográfico militar',
    service: 'https://www.ign.es/wms-inspire/mapa-raster',
    layers: 'mtn_rasterizado',
    format: 'image/png',
    background: '0xD8DDCF',
    attribution: '© Instituto Geográfico Nacional / CNIG'
  },
  aerial: {
    label: 'Vista aérea PNOA',
    service: 'https://www.ign.es/wms-inspire/pnoa-ma',
    layers: 'OI.OrthoimageCoverage',
    format: 'image/jpeg',
    background: '0xD8DDCF',
    attribution: '© Instituto Geográfico Nacional / PNOA'
  }
};

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[char]));
}
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function debounce(fn, delay = 140) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function init() {
  initNav();
  initNetwork();
  initMap();
  initChat();
  initDocs();
  initSettings();
  registerServiceWorker();
}

function initNav() {
  $$('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.view;
      $$('.nav-btn').forEach((item) => item.classList.toggle('active', item === btn));
      $$('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${name}`));
      if (name === 'map') {
        setTimeout(() => {
          map?.invalidateSize(true);
          mapImages?.refresh('nav');
        }, 160);
      }
    });
  });
}

function initNetwork() {
  const update = () => {
    const online = navigator.onLine;
    $('#onlineDot').className = `dot ${online ? 'on' : 'off'}`;
    $('#onlineText').textContent = online ? 'Con conexión' : 'Sin conexión';
    if (online) mapImages?.refresh('online');
  };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

class SmoothWmsMap {
  constructor(leafletMap) {
    this.map = leafletMap;
    this.key = localStorage.getItem(STORAGE.layer) || 'topo';
    if (!MAP_LAYERS[this.key]) this.key = 'topo';
    this.baseOverlay = null;
    this.detailOverlay = null;
    this.pendingOverlay = null;
    this.seq = 0;
    this.baseSeq = 0;
    this.refreshTimer = null;
    this.attributionControl = null;
  }

  start() {
    const basePane = this.map.createPane('c2base');
    basePane.classList.add('leaflet-c2base-pane');
    const detailPane = this.map.createPane('c2detail');
    detailPane.classList.add('leaflet-c2detail-pane');

    this.map.attributionControl.setPrefix(false);
    this.updateAttribution();
    this.loadBase();
    this.refresh('start');

    const lazyRefresh = debounce(() => this.refresh('move'), 110);
    const zoomRefresh = debounce(() => this.refresh('zoom'), 130);
    this.map.on('moveend resize', lazyRefresh);
    this.map.on('zoomend', zoomRefresh);
    this.map.on('viewreset', () => this.refresh('viewreset'));
  }

  setLayer(key) {
    if (!MAP_LAYERS[key]) return;
    this.key = key;
    localStorage.setItem(STORAGE.layer, key);
    this.seq += 1;
    this.baseSeq += 1;
    this.updateAttribution();
    this.loadBase();
    this.refresh('layer', true);
  }

  updateAttribution() {
    const cfg = MAP_LAYERS[this.key];
    if (!cfg) return;
    this.map.attributionControl.removeAttribution('© Instituto Geográfico Nacional / CNIG');
    this.map.attributionControl.removeAttribution('© Instituto Geográfico Nacional / PNOA');
    this.map.attributionControl.addAttribution(cfg.attribution);
  }

  refresh(reason = 'refresh', immediate = false) {
    clearTimeout(this.refreshTimer);
    const delay = immediate ? 0 : 80;
    this.refreshTimer = setTimeout(() => this.loadDetail(reason), delay);
  }

  loadBase() {
    const cfg = MAP_LAYERS[this.key];
    const mySeq = ++this.baseSeq;
    const url = this.wmsUrl(cfg, SPAIN_BOUNDS, 1400, 1250, `base-${mySeq}`);
    preloadImage(url, 25000).then(() => {
      if (mySeq !== this.baseSeq) return;
      const next = L.imageOverlay(url, SPAIN_BOUNDS, {
        pane: 'c2base',
        opacity: 1,
        interactive: false,
        zIndex: 1,
        alt: cfg.label
      });
      next.addTo(this.map);
      if (this.baseOverlay) this.map.removeLayer(this.baseOverlay);
      this.baseOverlay = next;
    }).catch(() => {
      // No se elimina la base anterior si la nueva petición falla.
    });
  }

  loadDetail(reason = 'refresh') {
    if (!navigator.onLine) return;
    const cfg = MAP_LAYERS[this.key];
    const viewSize = this.map.getSize();
    if (!viewSize || viewSize.x < 10 || viewSize.y < 10) return;

    const bounds = this.detailBounds();
    const dims = this.requestDimensions(bounds, viewSize);
    const mySeq = ++this.seq;
    const url = this.wmsUrl(cfg, bounds, dims.width, dims.height, `${reason}-${mySeq}-z${this.map.getZoom()}`);

    preloadImage(url, 30000).then(() => {
      if (mySeq !== this.seq) return;
      const next = L.imageOverlay(url, bounds, {
        pane: 'c2detail',
        opacity: 1,
        interactive: false,
        zIndex: 10,
        alt: cfg.label
      });
      next.once('load', () => {
        if (mySeq !== this.seq) {
          this.map.removeLayer(next);
          return;
        }
        if (this.detailOverlay) this.map.removeLayer(this.detailOverlay);
        this.detailOverlay = next;
        this.pendingOverlay = null;
      });
      this.pendingOverlay = next;
      next.addTo(this.map);
    }).catch(() => {
      // Si falla, mantenemos el plano anterior y la base completa.
    });
  }

  detailBounds() {
    const b = this.map.getBounds();
    const zoom = this.map.getZoom();
    const pad = zoom <= 6 ? 0.95 : zoom <= 9 ? 0.65 : zoom <= 13 ? 0.42 : 0.25;
    const latPad = (b.getNorth() - b.getSouth()) * pad;
    const lngPad = (b.getEast() - b.getWest()) * pad;
    const padded = L.latLngBounds(
      [b.getSouth() - latPad, b.getWest() - lngPad],
      [b.getNorth() + latPad, b.getEast() + lngPad]
    );
    return this.limitBounds(padded);
  }

  limitBounds(bounds) {
    const west = clamp(bounds.getWest(), SPAIN_BOUNDS.getWest(), SPAIN_BOUNDS.getEast());
    const east = clamp(bounds.getEast(), SPAIN_BOUNDS.getWest(), SPAIN_BOUNDS.getEast());
    const south = clamp(bounds.getSouth(), SPAIN_BOUNDS.getSouth(), SPAIN_BOUNDS.getNorth());
    const north = clamp(bounds.getNorth(), SPAIN_BOUNDS.getSouth(), SPAIN_BOUNDS.getNorth());
    if (east <= west || north <= south) return this.map.getBounds();
    return L.latLngBounds([south, west], [north, east]);
  }

  requestDimensions(bounds, viewSize) {
    const mapBounds = this.map.getBounds();
    const widthFactor = Math.max(1, (bounds.getEast() - bounds.getWest()) / Math.max(0.000001, mapBounds.getEast() - mapBounds.getWest()));
    const heightFactor = Math.max(1, (bounds.getNorth() - bounds.getSouth()) / Math.max(0.000001, mapBounds.getNorth() - mapBounds.getSouth()));
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2.2);
    let width = Math.ceil(viewSize.x * widthFactor * dpr);
    let height = Math.ceil(viewSize.y * heightFactor * dpr);
    const maxSide = this.map.getZoom() >= 14 ? 3200 : 2600;
    const scale = Math.min(1, maxSide / Math.max(width, height));
    width = Math.max(512, Math.round(width * scale));
    height = Math.max(512, Math.round(height * scale));
    return { width, height };
  }

  projectedBbox(bounds) {
    const sw = this.map.options.crs.project(bounds.getSouthWest());
    const ne = this.map.options.crs.project(bounds.getNorthEast());
    return [sw.x, sw.y, ne.x, ne.y].map((n) => Number(n).toFixed(2)).join(',');
  }

  wmsUrl(cfg, bounds, width, height, tag) {
    const params = new URLSearchParams({
      SERVICE: 'WMS',
      VERSION: '1.1.1',
      REQUEST: 'GetMap',
      LAYERS: cfg.layers,
      STYLES: '',
      SRS: 'EPSG:3857',
      BBOX: this.projectedBbox(bounds),
      WIDTH: String(Math.round(width)),
      HEIGHT: String(Math.round(height)),
      FORMAT: cfg.format,
      TRANSPARENT: 'FALSE',
      BGCOLOR: cfg.background,
      EXCEPTIONS: 'INIMAGE',
      _c2: `${APP_VERSION}-${tag}-${Date.now()}`
    });
    return `${cfg.service}?${params.toString()}`;
  }
}

function preloadImage(src, timeout = 25000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    let finished = false;
    const done = (ok) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ok ? resolve(img) : reject(new Error('No se pudo cargar el plano'));
    };
    const timer = setTimeout(() => done(false), timeout);
    img.onload = () => done(img.naturalWidth > 16 && img.naturalHeight > 16);
    img.onerror = () => done(false);
    img.decoding = 'async';
    img.loading = 'eager';
    img.referrerPolicy = 'no-referrer-when-downgrade';
    img.src = src;
  });
}

function initMap() {
  map = L.map('map', {
    zoomControl: true,
    preferCanvas: false,
    fadeAnimation: false,
    zoomAnimation: true,
    markerZoomAnimation: true,
    inertia: true,
    minZoom: 5,
    maxZoom: 19,
    maxBounds: SPAIN_BOUNDS.pad(0.32),
    maxBoundsViscosity: 0.2
  }).setView(INITIAL_VIEW.center, INITIAL_VIEW.zoom);

  map.createPane('c2marker').classList.add('leaflet-c2marker-pane');

  mapImages = new SmoothWmsMap(map);
  mapImages.start();

  const select = $('#mapLayerSelect');
  select.value = mapImages.key;
  select.addEventListener('change', () => mapImages.setLayer(select.value));
  $('#reloadMapBtn')?.addEventListener('click', () => {
    map.invalidateSize(true);
    mapImages.loadBase();
    mapImages.refresh('manual', true);
  });

  $('#locateBtn')?.addEventListener('click', locateOnce);
  $('#trackBtn')?.addEventListener('click', toggleTracking);
  $('#addMarkerBtn')?.addEventListener('click', openMarkerDialog);
  $('#markerForm')?.addEventListener('submit', handleMarkerDialog);
  map.on('click', handleMapClickForMarker);

  renderMarkers();
}

function makeUserIcon() {
  return L.divIcon({
    className: 'user-position-icon',
    iconSize: [56, 56],
    iconAnchor: [28, 28],
    html: `<div class="user-position-wrap" style="--heading:${state.lastHeading}deg"><div class="user-position-bearing"></div><div class="user-position-center"></div></div>`
  });
}

function updateUserIconHeading() {
  if (!state.userMarker) return;
  const el = state.userMarker.getElement()?.querySelector('.user-position-wrap');
  if (el) el.style.setProperty('--heading', `${state.lastHeading}deg`);
}

function locateOnce() {
  if (!('geolocation' in navigator)) {
    $('#gpsStatus').textContent = 'GPS no disponible en este navegador';
    return;
  }
  $('#gpsStatus').textContent = 'Buscando GPS…';
  navigator.geolocation.getCurrentPosition(onLocation, onLocationError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 18000
  });
}

function toggleTracking() {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
    state.tracking = false;
    $('#trackBtn').textContent = 'Iniciar seguimiento';
    $('#gpsStatus').textContent = 'Seguimiento detenido';
    return;
  }
  if (!('geolocation' in navigator)) {
    $('#gpsStatus').textContent = 'GPS no disponible';
    return;
  }
  state.tracking = true;
  $('#trackBtn').textContent = 'Detener seguimiento';
  $('#gpsStatus').textContent = 'Seguimiento activo…';
  state.watchId = navigator.geolocation.watchPosition(onLocation, onLocationError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 20000
  });
}

function onLocation(position) {
  const { latitude, longitude, accuracy, heading } = position.coords;
  const latlng = L.latLng(latitude, longitude);
  if (Number.isFinite(heading)) state.lastHeading = Math.round(heading);

  $('#coords').textContent = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
  $('#accuracy').textContent = `Precisión: ±${Math.round(accuracy || 0)} m`;
  $('#gpsStatus').textContent = state.tracking ? 'GPS activo · seguimiento' : 'GPS activo';

  if (!state.userMarker) {
    state.userMarker = L.marker(latlng, { icon: makeUserIcon(), pane: 'c2marker', keyboard: false, zIndexOffset: 10000 }).addTo(map);
  } else {
    state.userMarker.setLatLng(latlng);
    updateUserIconHeading();
  }
  if (!state.accuracyCircle) {
    state.accuracyCircle = L.circle(latlng, {
      radius: accuracy || 0,
      interactive: false,
      pane: 'overlayPane',
      color: '#1e88ff',
      weight: 1,
      fillColor: '#1e88ff',
      fillOpacity: 0.08,
      opacity: 0.35
    }).addTo(map);
  } else {
    state.accuracyCircle.setLatLng(latlng);
    state.accuracyCircle.setRadius(accuracy || 0);
  }

  const targetZoom = Math.max(map.getZoom(), 16);
  map.setView(latlng, targetZoom, { animate: true });
  mapImages?.refresh('gps', true);
}

function onLocationError(error) {
  const messages = {
    1: 'Permiso GPS denegado',
    2: 'No se pudo obtener ubicación',
    3: 'GPS sin respuesta'
  };
  $('#gpsStatus').textContent = messages[error.code] || 'Error GPS';
}

function openMarkerDialog() {
  $('#markerDialog')?.showModal();
}

function handleMarkerDialog(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const name = $('#markerName').value.trim();
  const type = $('#markerType').value;
  if (!name) return;
  state.pendingMarker = { name, type };
  $('#markerHint').textContent = 'Pulsa sobre el mapa para situarlo.';
  $('#markerDialog')?.close();
  form.reset();
}

function handleMapClickForMarker(event) {
  if (!state.pendingMarker) return;
  const marker = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    name: state.pendingMarker.name,
    type: state.pendingMarker.type,
    lat: event.latlng.lat,
    lng: event.latlng.lng,
    createdAt: new Date().toISOString()
  };
  state.markers.push(marker);
  writeJson(STORAGE.markers, state.markers);
  state.pendingMarker = null;
  renderMarkers();
}

function iconForMarker(type) {
  const cls = type === 'warning' ? 'warning-marker' : type;
  return L.divIcon({ className: '', iconSize: [24, 24], iconAnchor: [12, 12], html: `<div class="tactical-marker ${cls}"></div>` });
}

const renderedMarkerLayer = L.layerGroup();
function renderMarkers() {
  if (!map) return;
  renderedMarkerLayer.clearLayers();
  state.markers.forEach((item) => {
    const marker = L.marker([item.lat, item.lng], { icon: iconForMarker(item.type) }).bindPopup(`<strong>${escapeHtml(item.name)}</strong><br>${escapeHtml(item.type)}`);
    marker.addTo(renderedMarkerLayer);
  });
  if (!map.hasLayer(renderedMarkerLayer)) renderedMarkerLayer.addTo(map);
}

function initChat() {
  renderMessages();
  $('#chatForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#chatInput');
    const text = input.value.trim();
    if (!text) return;
    state.messages.push({ id: Date.now(), author: state.settings.callsign, text, time: new Date().toISOString() });
    writeJson(STORAGE.messages, state.messages);
    input.value = '';
    renderMessages();
  });
  $('#clearChatBtn')?.addEventListener('click', () => {
    if (!confirm('¿Vaciar el chat de este dispositivo?')) return;
    state.messages = [];
    writeJson(STORAGE.messages, state.messages);
    renderMessages();
  });
}

function renderMessages() {
  const list = $('#messageList');
  if (!list) return;
  if (!state.messages.length) {
    list.innerHTML = '<div class="empty">Sin mensajes</div>';
    return;
  }
  list.innerHTML = state.messages.map((msg) => `
    <article class="message mine">
      <header><strong>${escapeHtml(msg.author || state.settings.callsign)}</strong><time>${new Date(msg.time).toLocaleString()}</time></header>
      <p>${escapeHtml(msg.text)}</p>
    </article>`).join('');
  list.scrollTop = list.scrollHeight;
}

function initDocs() {
  renderDocuments();
  $('#fileInput')?.addEventListener('change', async (event) => {
    await addDocuments(Array.from(event.target.files || []));
    event.target.value = '';
  });
  const drop = $('#dropZone');
  if (drop) {
    ['dragenter', 'dragover'].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.remove('drag'); }));
    drop.addEventListener('drop', async (event) => addDocuments(Array.from(event.dataTransfer.files || [])));
  }
}

async function addDocuments(files) {
  for (const file of files) {
    const dataUrl = await fileToDataUrl(file);
    state.documents.push({ id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${file.name}`, name: file.name, type: file.type, size: file.size, dataUrl, addedAt: new Date().toISOString() });
  }
  writeJson(STORAGE.docs, state.documents);
  renderDocuments();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function renderDocuments() {
  const list = $('#documentList');
  if (!list) return;
  if (!state.documents.length) {
    list.innerHTML = '<div class="empty">Sin documentos guardados</div>';
    return;
  }
  list.innerHTML = state.documents.map((doc) => `
    <article class="document">
      <div class="doc-icon">DOC</div>
      <div><strong>${escapeHtml(doc.name)}</strong><small>${formatBytes(doc.size)} · ${new Date(doc.addedAt).toLocaleString()}</small></div>
      <div class="doc-actions"><a class="action" href="${doc.dataUrl}" download="${escapeHtml(doc.name)}">Abrir</a><button data-doc-delete="${doc.id}">Borrar</button></div>
    </article>`).join('');
  $$('[data-doc-delete]').forEach((button) => button.addEventListener('click', () => {
    state.documents = state.documents.filter((doc) => doc.id !== button.dataset.docDelete);
    writeJson(STORAGE.docs, state.documents);
    renderDocuments();
  }));
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function initSettings() {
  $('#callsignInput').value = state.settings.callsign || '';
  $('#unitInput').value = state.settings.unit || '';
  $('#unitLabel').textContent = state.settings.unit || 'Puesto de mando';
  $('#settingsForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    state.settings.callsign = $('#callsignInput').value.trim() || 'Jefe de sección';
    state.settings.unit = $('#unitInput').value.trim() || 'Puesto de mando';
    writeJson(STORAGE.settings, state.settings);
    $('#unitLabel').textContent = state.settings.unit;
  });
  $('#exportBtn')?.addEventListener('click', exportData);
  $('#importInput')?.addEventListener('change', importData);
}

function exportData() {
  const data = { version: APP_VERSION, exportedAt: new Date().toISOString(), settings: state.settings, messages: state.messages, markers: state.markers };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `seccion-c2-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importData(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (data.settings) state.settings = data.settings;
      if (Array.isArray(data.messages)) state.messages = data.messages;
      if (Array.isArray(data.markers)) state.markers = data.markers;
      writeJson(STORAGE.settings, state.settings);
      writeJson(STORAGE.messages, state.messages);
      writeJson(STORAGE.markers, state.markers);
      renderMessages();
      renderMarkers();
      $('#callsignInput').value = state.settings.callsign || '';
      $('#unitInput').value = state.settings.unit || '';
      $('#unitLabel').textContent = state.settings.unit || 'Puesto de mando';
      alert('Datos importados');
    } catch {
      alert('No se pudo importar el archivo');
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js?v=planos-reset-v1').catch(() => {});
  }
}

window.addEventListener('deviceorientationabsolute', (event) => {
  if (Number.isFinite(event.alpha)) {
    state.lastHeading = Math.round(360 - event.alpha);
    updateUserIconHeading();
  }
});
window.addEventListener('deviceorientation', (event) => {
  if (Number.isFinite(event.webkitCompassHeading)) {
    state.lastHeading = Math.round(event.webkitCompassHeading);
    updateUserIconHeading();
  }
});

init();
