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
  gpsFloat: null,
  lastGpsLatLng: null,
  accuracyCircle: null,
  heading: 0
};
const persist = (key, value) => localStorage.setItem(key, JSON.stringify(value));

let map;
let activeMapKey = localStorage.getItem('c2-map-layer') || 'topo';
let ignRaster = null;
let detailTimer = null;
let mapRequestSeq = 0;

const GPS_TARGET_ACCURACY_METERS = 12;
const GPS_BURST_TIMEOUT_MS = 9000;
const GPS_MIN_ZOOM = 18;

const MAP_VERSION = 'ign-online-speed-v22-pwa-install';
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

function mercatorBounds(bounds) {
  const sw = map.options.crs.project(bounds.getSouthWest());
  const ne = map.options.crs.project(bounds.getNorthEast());
  return [sw.x, sw.y, ne.x, ne.y].map(n => Number(n).toFixed(2)).join(',');
}

function buildWmsUrl(key, bounds, pixelSize, quality = 'fast') {
  const cfg = IGN_LAYERS[key] || IGN_LAYERS.topo;
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.1.1',
    REQUEST: 'GetMap',
    LAYERS: cfg.layer,
    STYLES: '',
    FORMAT: cfg.format,
    SRS: 'EPSG:3857',
    BBOX: mercatorBounds(bounds),
    WIDTH: String(pixelSize.width),
    HEIGHT: String(pixelSize.height),
    TRANSPARENT: 'FALSE',
    BGCOLOR: cfg.bg,
    EXCEPTIONS: 'application/vnd.ogc.se_inimage',
    // Sin Date.now: permite caché del navegador si vuelves a una vista ya pedida.
    _v: MAP_VERSION,
    _q: quality,
    _z: map.getZoom().toFixed(2)
  });
  return `${cfg.url}?${params.toString()}`;
}

function viewPixelSize() {
  const size = map.getSize();
  const dpr = clamp(window.devicePixelRatio || 1, 1, 2.25);
  return {
    cssWidth: Math.max(1, Math.round(size.x)),
    cssHeight: Math.max(1, Math.round(size.y)),
    width: Math.round(clamp(size.x * dpr, 640, 3000)),
    height: Math.round(clamp(size.y * dpr, 640, 3000))
  };
}

function createIgnSingleImageRenderer() {
  const cfgAttributions = new Set();
  let activeOverlay = null;
  let activeBounds = null;
  let activeZoom = null;
  let activeKey = activeMapKey;
  let activeQuality = 'none';
  let requestId = 0;
  let detailTimerLocal = null;
  let loadingImage = null;
  let loadingUrl = '';

  function cancelLoadingImage() {
    if (!loadingImage) return;
    try {
      loadingImage.onload = null;
      loadingImage.onerror = null;
      loadingImage.src = '';
    } catch (_) {}
    loadingImage = null;
    loadingUrl = '';
  }

  function removeOverlay(overlay) {
    if (!overlay) return;
    try { map.removeLayer(overlay); } catch (_) {}
  }

  function clear(removeVisible = true) {
    requestId++;
    clearTimeout(detailTimer);
    clearTimeout(detailTimerLocal);
    cancelLoadingImage();
    activeBounds = null;
    activeZoom = null;
    activeQuality = 'none';
    if (removeVisible && activeOverlay) {
      removeOverlay(activeOverlay);
      activeOverlay = null;
    }
  }

  function updateAttribution(key) {
    if (!map?.attributionControl) return;
    cfgAttributions.forEach(attr => map.attributionControl.removeAttribution(attr));
    cfgAttributions.clear();
    const attr = (IGN_LAYERS[key] || IGN_LAYERS.topo).attribution;
    if (attr) {
      cfgAttributions.add(attr);
      map.attributionControl.addAttribution(attr);
    }
  }

  function bufferFor(reason, quality) {
    // V18: carga más rápida. Se reduce la imagen inmediata y el detalle queda en segundo plano.
    // La imagen actual sigue moviéndose debajo, así que no hace falta pedir tanto margen.
    if (quality === 'detail') return reason === 'zoomend' ? 0.30 : 0.26;
    if (reason === 'zoomend') return 0.18;
    if (reason === 'layer-change' || reason === 'force-refresh') return 0.16;
    return 0.14;
  }

  function bufferedPixelBounds(reason = 'view', quality = 'fast') {
    const pb = map.getPixelBounds();
    const size = map.getSize();
    const ratio = bufferFor(reason, quality);
    const padX = Math.round(size.x * ratio);
    const padY = Math.round(size.y * ratio);
    return L.bounds(
      pb.min.subtract([padX, padY]),
      pb.max.add([padX, padY])
    );
  }

  function boundsFromPixelBounds(pb) {
    const nw = map.unproject(pb.min, map.getZoom());
    const se = map.unproject(pb.max, map.getZoom());
    return L.latLngBounds(se, nw);
  }

  function pixelSizeFromBounds(pb, quality = 'fast') {
    const cssWidth = Math.max(1, pb.max.x - pb.min.x);
    const cssHeight = Math.max(1, pb.max.y - pb.min.y);
    const dpr = clamp(window.devicePixelRatio || 1, 1, 1.25);

    // La primera carga es ligera para que aparezca antes.
    // El detalle sube después si el usuario deja el plano quieto.
    const targetScale = quality === 'detail' ? Math.min(dpr, 1.03) : 0.54;
    const maxSide = quality === 'detail' ? 1850 : 1024;
    const scale = Math.max(0.38, Math.min(targetScale, maxSide / cssWidth, maxSide / cssHeight));
    return {
      cssWidth,
      cssHeight,
      width: Math.max(220, Math.round(cssWidth * scale)),
      height: Math.max(220, Math.round(cssHeight * scale))
    };
  }

  function currentViewIsCovered(quality = 'fast') {
    if (!activeOverlay || !activeBounds || activeKey !== activeMapKey) return false;
    if (Math.abs((activeZoom ?? -99) - map.getZoom()) > 0.08) return false;
    if (!activeBounds.contains(map.getBounds())) return false;
    if (quality === 'detail' && activeQuality !== 'detail') return false;
    return true;
  }

  function scheduleDetail(reason = 'detail') {
    clearTimeout(detailTimerLocal);
    detailTimerLocal = setTimeout(() => {
      if (!map || !navigator.onLine) return;
      if (activeKey === activeMapKey && activeQuality !== 'detail') {
        render(false, reason, 'detail');
      }
    }, 780);
  }

  function addLoadedOverlay(url, overlayBounds, quality, cfg, id, key) {
    if (id !== requestId || key !== activeMapKey) return;
    const nextOverlay = L.imageOverlay(url, overlayBounds, {
      pane: 'ignPane',
      opacity: 0,
      className: `ign-wms-overlay ign-wms-${quality}`,
      interactive: false,
      crossOrigin: false,
      alt: cfg.label
    });

    nextOverlay.once('load', () => {
      if (id !== requestId || key !== activeMapKey) {
        removeOverlay(nextOverlay);
        return;
      }
      requestAnimationFrame(() => nextOverlay.setOpacity(1));
    });

    nextOverlay.addTo(map);
    const old = activeOverlay;
    activeOverlay = nextOverlay;
    activeBounds = overlayBounds;
    activeZoom = map.getZoom();
    activeKey = key;
    activeQuality = quality;

    if (old && old !== nextOverlay) {
      old.setOpacity(0);
      setTimeout(() => removeOverlay(old), quality === 'fast' ? 55 : 110);
    }
    setMapStatus(`${cfg.label} listo z${map.getZoom().toFixed(1)}${quality === 'fast' ? ' · rápido' : ''}`);
    if (quality === 'fast') scheduleDetail('post-fast');
  }

  function render(force = false, reason = 'view', quality = 'fast') {
    if (!map || !navigator.onLine) return;
    const size = map.getSize();
    if (size.x < 20 || size.y < 20) return;

    if (!force && currentViewIsCovered(quality)) {
      setMapStatus(`${(IGN_LAYERS[activeMapKey] || IGN_LAYERS.topo).label} listo z${map.getZoom().toFixed(1)}`);
      if (activeQuality !== 'detail') scheduleDetail('auto-detail');
      return;
    }

    const key = activeMapKey;
    const cfg = IGN_LAYERS[key] || IGN_LAYERS.topo;
    const pb = bufferedPixelBounds(reason, quality);
    const overlayBounds = boundsFromPixelBounds(pb);
    const pixelSize = pixelSizeFromBounds(pb, quality);
    const id = ++requestId;
    const url = buildWmsUrl(key, overlayBounds, pixelSize, quality);

    updateAttribution(key);
    setMapStatus(quality === 'detail'
      ? `Afinando ${cfg.label} z${map.getZoom().toFixed(1)}…`
      : `Cargando ${cfg.label} z${map.getZoom().toFixed(1)}…`);
    console.info('[SECCION C2][IGN-WMS-SPEED-V22]', { reason, quality, key, zoom: map.getZoom(), pixelSize });

    // Cancela la imagen anterior si el usuario sigue moviendo/zoomando.
    // Esto evita que descargas viejas bloqueen la nueva capa.
    cancelLoadingImage();

    const img = new Image();
    loadingImage = img;
    loadingUrl = url;
    try {
      img.decoding = 'async';
      img.loading = 'eager';
      img.fetchPriority = quality === 'fast' ? 'high' : 'low';
    } catch (_) {}

    img.onload = () => {
      if (img !== loadingImage || id !== requestId || key !== activeMapKey || loadingUrl !== url) return;
      loadingImage = null;
      loadingUrl = '';
      addLoadedOverlay(url, overlayBounds, quality, cfg, id, key);
    };

    img.onerror = () => {
      if (img !== loadingImage || id !== requestId) return;
      loadingImage = null;
      loadingUrl = '';
      console.warn('[SECCION C2][IGN-WMS-SPEED-V22] Error cargando plano', { quality, url });
      if (activeOverlay) setMapStatus('Se mantiene el plano anterior; reintentando…');
      else setMapStatus('Esperando plano IGN online…');
      if (quality === 'fast') {
        setTimeout(() => {
          if (id === requestId && key === activeMapKey) render(true, 'retry', 'fast');
        }, 420);
      }
    };

    img.src = url;
  }

  function schedule(force = false, delay = 45, reason = 'schedule') {
    clearTimeout(detailTimer);
    clearTimeout(detailTimerLocal);
    detailTimer = setTimeout(() => render(force, reason, 'fast'), delay);
  }

  function setLayer(key) {
    if (!IGN_LAYERS[key]) key = 'topo';
    // No borramos la imagen visible hasta que la nueva capa esté preparada.
    clear(false);
    activeMapKey = key;
    activeKey = key;
    activeQuality = 'none';
    localStorage.setItem('c2-map-layer', key);
    updateAttribution(key);
    setMapStatus(`Cargando ${IGN_LAYERS[key].label} online…`);
    render(true, 'layer-change', 'fast');
  }

  return { render, schedule, setLayer, clear };
}
function refreshOnlineMap(force = false) {
  if (!ignRaster) return;
  const delay = force ? 10 : 35;
  ignRaster.schedule(force, delay, force ? 'force-refresh' : 'view-change');
}

function switchMapLayer(key) {
  if (!IGN_LAYERS[key]) key = 'topo';
  const select = $('#mapLayerSelect');
  if (select) select.value = key;
  activeMapKey = key;
  localStorage.setItem('c2-map-layer', key);
  if (ignRaster) ignRaster.setLayer(key);
}

function initMap() {
  map = L.map('map', {
    zoomControl: false,
    preferCanvas: false,
    maxBounds: SPAIN_BOUNDS.pad(0.35),
    maxBoundsViscosity: 0.25,
    worldCopyJump: false,
    inertia: true,
    zoomAnimation: true,
    fadeAnimation: true,
    markerZoomAnimation: true,
    zoomSnap: 0.25,
    zoomDelta: 0.5
  }).setView([40.4168, -3.7038], 6);

  // Pane propio para el plano IGN online. Va por debajo de puntos/GPS,
  // pero se mueve y escala con Leaflet para que el movimiento sea más fluido.
  map.createPane('ignPane');
  map.getPane('ignPane').style.zIndex = 220;
  map.getPane('ignPane').style.pointerEvents = 'none';

  map.createPane('accuracyPane');
  map.getPane('accuracyPane').style.zIndex = 640;
  map.getPane('accuracyPane').style.pointerEvents = 'none';

  map.createPane('gpsPane');
  map.getPane('gpsPane').style.zIndex = 2000;
  map.getPane('gpsPane').style.pointerEvents = 'none';

  // Asegurar que marcadores/puntos quedan por encima del plano WMS.
  map.getPane('markerPane').style.zIndex = 620;
  map.getPane('overlayPane').style.zIndex = 560;
  map.getPane('popupPane').style.zIndex = 700;

  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.control.attribution({ prefix: false, position: 'bottomleft' }).addTo(map);

  ignRaster = createIgnSingleImageRenderer();

  $('#mapLayerSelect')?.addEventListener('change', e => switchMapLayer(e.target.value));
  $('#reloadMapBtn')?.addEventListener('click', () => refreshOnlineMap(true));

  // Durante el movimiento no pedimos imágenes nuevas continuamente: el plano actual se desplaza.
  // Cuando el movimiento/zoom termina, se carga una imagen nueva si hace falta.
  map.on('zoomstart movestart', () => setMapStatus('Plano en memoria'));
  map.on('moveend', () => ignRaster?.schedule(false, 25, 'moveend'));
  map.on('zoomend', () => ignRaster?.schedule(true, 15, 'zoomend'));
  map.on('resize viewreset', () => ignRaster?.schedule(true, 25, 'resize'));

  // El triángulo de GPS no depende de las capas del plano: es HTML flotante encima del mapa.
  // Se recalcula en cualquier movimiento/zoom para que no desaparezca ni se quede desplazado.
  map.on('move zoom zoomstart zoomend movestart moveend resize viewreset', updateGpsFloat);

  switchMapLayer(activeMapKey);
  drawMarkers();
}


function ensureGpsFloat() {
  if (state.gpsFloat) return state.gpsFloat;
  const mapEl = document.getElementById('map');
  if (!mapEl) return null;

  const el = document.createElement('div');
  el.id = 'gpsFloatMarker';
  el.className = 'gps-float-marker';
  el.setAttribute('aria-label', 'Mi posición');
  el.innerHTML = '<div class="gps-float-triangle"><span></span></div>';
  mapEl.appendChild(el);
  state.gpsFloat = el;
  return el;
}

function updateGpsFloat() {
  if (!map || !state.lastGpsLatLng) return;
  const el = ensureGpsFloat();
  if (!el) return;
  const p = map.latLngToContainerPoint(state.lastGpsLatLng);
  const heading = Number.isFinite(state.heading) ? state.heading : 0;
  el.style.left = `${Math.round(p.x)}px`;
  el.style.top = `${Math.round(p.y)}px`;
  el.style.setProperty('--heading', `${heading}deg`);
  el.classList.add('visible');
}

function showGpsFloat(latlng) {
  state.lastGpsLatLng = L.latLng(latlng);
  ensureGpsFloat();
  updateGpsFloat();
  requestAnimationFrame(updateGpsFloat);
  setTimeout(updateGpsFloat, 80);
  setTimeout(updateGpsFloat, 260);
}

function hideGpsFloat() {
  if (state.gpsFloat) state.gpsFloat.classList.remove('visible');
}

function gpsDivIcon(heading = 0) {
  const safeHeading = Number.isFinite(heading) ? heading : 0;
  return L.divIcon({
    className: 'gps-triangle-icon gps-triangle-top',
    html: `<div class="gps-triangle" style="--heading:${safeHeading}deg"><span></span></div>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22]
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
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  if (Number.isFinite(heading)) state.heading = heading;

  const acc = Number.isFinite(accuracy) ? Math.round(accuracy) : 0;
  $('#coords').textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  $('#accuracy').textContent = acc ? `Precisión: ±${acc} m` : 'Precisión: —';

  const ll = L.latLng(lat, lng);

  // Marcador principal: HTML flotante. Este es el que debe verse siempre encima de todas las capas.
  showGpsFloat(ll);

  // Marcador Leaflet de respaldo por si el navegador no pinta correctamente el HTML flotante.
  if (state.userMarker) {
    state.userMarker.setLatLng(ll);
    state.userMarker.setIcon(gpsDivIcon(state.heading));
    state.userMarker.setZIndexOffset(1000000);
  } else {
    state.userMarker = L.marker(ll, {
      icon: gpsDivIcon(state.heading),
      pane: 'gpsPane',
      zIndexOffset: 1000000,
      interactive: false,
      keyboard: false
    }).addTo(map).bindPopup('Mi posición');
  }

  if (state.accuracyCircle) {
    state.accuracyCircle.setLatLng(ll).setRadius(acc || 1);
  } else {
    state.accuracyCircle = L.circle(ll, {
      pane: 'accuracyPane',
      radius: acc || 1,
      color: '#1e88ff',
      weight: 1,
      fillColor: '#1e88ff',
      fillOpacity: 0.06,
      interactive: false
    }).addTo(map);
  }

  if (state.accuracyCircle?.bringToBack) state.accuracyCircle.bringToBack();
  if (state.userMarker?.bringToFront) state.userMarker.bringToFront();
  updateGpsFloat();

  if (center) {
    map.setView(ll, Math.max(map.getZoom(), GPS_MIN_ZOOM), { animate: true });
    setTimeout(() => {
      updateGpsFloat();
      refreshOnlineMap(true);
    }, 250);
  }
}

function geoError(e) {
  alert(`No se pudo obtener la posición: ${e.message}. Comprueba permisos y que la web esté en HTTPS.`);
}

function isBetterGpsFix(candidate, currentBest) {
  if (!candidate) return false;
  if (!currentBest) return true;
  const ca = candidate.coords?.accuracy ?? Infinity;
  const ba = currentBest.coords?.accuracy ?? Infinity;
  return ca < ba;
}

function locateWithBestAccuracy() {
  if (!navigator.geolocation) return alert('Geolocalización no disponible');

  const btn = $('#locateBtn');
  const originalText = btn?.textContent || '◎ Mi posición';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Buscando GPS…';
  }
  $('#accuracy').textContent = 'Buscando posición precisa…';

  let bestPosition = null;
  let finished = false;
  let watchId = null;

  const finish = (reason = 'done') => {
    if (finished) return;
    finished = true;
    if (watchId !== null) {
      try { navigator.geolocation.clearWatch(watchId); } catch (_) {}
    }
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
    if (bestPosition) {
      updatePosition(bestPosition, true);
      const acc = Math.round(bestPosition.coords.accuracy || 0);
      $('#accuracy').textContent = `Precisión: ±${acc} m${reason === 'target' ? ' · GPS fijado' : ''}`;
    } else {
      $('#accuracy').textContent = 'Sin posición GPS';
    }
  };

  const onPosition = pos => {
    if (finished) return;
    if (isBetterGpsFix(pos, bestPosition)) {
      bestPosition = pos;
      updatePosition(pos, false);
      const acc = Math.round(pos.coords.accuracy || 0);
      $('#accuracy').textContent = `Afinando GPS… ±${acc} m`;
      if (acc > 0 && acc <= GPS_TARGET_ACCURACY_METERS) finish('target');
    }
  };

  const onError = err => {
    if (bestPosition) finish('fallback');
    else {
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalText;
      }
      geoError(err);
    }
  };

  navigator.geolocation.getCurrentPosition(onPosition, onError, {
    enableHighAccuracy: true,
    timeout: GPS_BURST_TIMEOUT_MS,
    maximumAge: 0
  });

  watchId = navigator.geolocation.watchPosition(onPosition, onError, {
    enableHighAccuracy: true,
    timeout: GPS_BURST_TIMEOUT_MS,
    maximumAge: 0
  });

  setTimeout(() => finish('timeout'), GPS_BURST_TIMEOUT_MS);
}

$('#locateBtn').addEventListener('click', locateWithBestAccuracy);

// Orientación opcional del teléfono: si el navegador la permite, gira el triángulo azul.
function handleDeviceHeading(e) {
  const heading = Number.isFinite(e.webkitCompassHeading) ? e.webkitCompassHeading : (Number.isFinite(e.alpha) ? 360 - e.alpha : null);
  if (heading === null) return;
  state.heading = heading;
  if (state.userMarker) state.userMarker.setIcon(gpsDivIcon(state.heading));
  updateGpsFloat();
}
try {
  if (window.DeviceOrientationEvent?.requestPermission) {
    $('#locateBtn')?.addEventListener('click', () => {
      window.DeviceOrientationEvent.requestPermission().then(res => {
        if (res === 'granted') window.addEventListener('deviceorientation', handleDeviceHeading, true);
      }).catch(() => {});
    }, { once: true });
  } else {
    window.addEventListener('deviceorientation', handleDeviceHeading, true);
  }
} catch (_) {}

$('#trackBtn').addEventListener('click', () => {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
    $('#trackBtn').textContent = 'Iniciar seguimiento';
    return;
  }
  if (!navigator.geolocation) return alert('Geolocalización no disponible');
  state.watchId = navigator.geolocation.watchPosition(p => updatePosition(p, false), geoError, { enableHighAccuracy: true, maximumAge: 0, timeout: 12000 });
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


// V21/V22: orientación horizontal en móvil, PWA instalable y reajuste real del plano.
function isStandalonePwa() {
  return window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator.standalone === true;
}

function isMobileDevice() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.matchMedia?.('(pointer: coarse)')?.matches;
}

function refreshLayoutAfterOrientation(reason = 'layout') {
  document.body.classList.toggle('is-landscape', window.innerWidth > window.innerHeight);
  document.body.classList.toggle('is-portrait', window.innerWidth <= window.innerHeight);
  if (!map) return;
  const steps = [0, 90, 220, 520];
  steps.forEach(delay => setTimeout(() => {
    try {
      map.invalidateSize({ animate: false, pan: false });
      updateGpsFloat();
      if ($('#view-map')?.classList.contains('active')) refreshOnlineMap(delay === 520);
    } catch (err) {
      console.warn('[SECCION C2][LANDSCAPE] Reajuste fallido', reason, err);
    }
  }, delay));
}

async function tryLockLandscape(reason = 'auto') {
  if (!isMobileDevice()) return false;
  if (!screen.orientation?.lock) return false;
  try {
    // En Chrome/Android normalmente solo se permite sin error cuando la app está instalada como PWA
    // o está en pantalla completa. Si el navegador no lo permite, el CSS igualmente adapta el mapa.
    if (isStandalonePwa() || document.fullscreenElement) {
      await screen.orientation.lock('landscape-primary');
      document.body.classList.add('orientation-locked');
      refreshLayoutAfterOrientation(`lock-${reason}`);
      return true;
    }
  } catch (err) {
    console.info('[SECCION C2][LANDSCAPE] Bloqueo horizontal no permitido por el navegador', reason, err?.message || err);
  }
  return false;
}

function initLandscapeMode() {
  document.body.classList.add('landscape-ready');
  refreshLayoutAfterOrientation('init');
  tryLockLandscape('init');

  const requestOnGesture = () => {
    tryLockLandscape('gesture');
    refreshLayoutAfterOrientation('gesture');
  };
  ['click', 'touchend', 'keydown'].forEach(type => {
    window.addEventListener(type, requestOnGesture, { passive: true, once: true });
  });

  window.addEventListener('orientationchange', () => refreshLayoutAfterOrientation('orientationchange'));
  window.addEventListener('resize', () => refreshLayoutAfterOrientation('resize'));
  window.visualViewport?.addEventListener('resize', () => refreshLayoutAfterOrientation('visualViewport'));
  document.addEventListener('fullscreenchange', () => tryLockLandscape('fullscreen'));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshLayoutAfterOrientation('visible');
  });
}


let deferredInstallPrompt = null;

function setInstallButtonVisible(visible) {
  const btn = $('#installAppBtn');
  if (!btn) return;
  const installed = isStandalonePwa();
  document.body.classList.toggle('is-pwa-installed', installed);
  btn.classList.toggle('hidden', installed || !visible);
}

function showManualInstallInstructions() {
  const dialog = $('#installDialog');
  if (dialog?.showModal) {
    dialog.showModal();
    return;
  }
  alert('Para instalar la app: en Android/Chrome abre el menú ⋮ y pulsa "Instalar app" o "Añadir a pantalla de inicio". En iPhone/Safari pulsa compartir y "Añadir a pantalla de inicio".');
}

function initPwaInstallPrompt() {
  const btn = $('#installAppBtn');
  if (!btn) return;

  setInstallButtonVisible(!isStandalonePwa());

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    setInstallButtonVisible(true);
  });

  btn.addEventListener('click', async () => {
    if (isStandalonePwa()) {
      setInstallButtonVisible(false);
      return;
    }

    if (!deferredInstallPrompt) {
      showManualInstallInstructions();
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Instalando…';
    try {
      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      if (choice?.outcome === 'accepted') {
        btn.textContent = 'Instalada';
        setInstallButtonVisible(false);
      } else {
        btn.textContent = 'Instalar app';
        setInstallButtonVisible(true);
      }
    } catch (err) {
      console.warn('[SECCION C2][PWA] No se pudo mostrar el instalador', err);
      btn.textContent = 'Instalar app';
      showManualInstallInstructions();
    } finally {
      btn.disabled = false;
    }
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    setInstallButtonVisible(false);
    document.body.classList.add('is-pwa-installed');
    tryLockLandscape('appinstalled');
    refreshLayoutAfterOrientation('appinstalled');
  });

  try {
    window.matchMedia('(display-mode: standalone)')?.addEventListener('change', () => {
      setInstallButtonVisible(!isStandalonePwa());
      refreshLayoutAfterOrientation('display-mode-change');
    });
  } catch (_) {}
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js?v=pwa-install-v22').catch(console.error));
}

initPwaInstallPrompt();
initLandscapeMode();
initMap();
map.on('click', handleMapClick);
initNav();
updateNetwork();
loadSettings();
renderMessages();
renderDocuments();
