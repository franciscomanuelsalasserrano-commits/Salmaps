# Parche SECCIÓN C2 — planos IGN más rápidos

Este parche mantiene el sistema WMS online del IGN que ya funcionaba, pero lo optimiza para que cargue antes al mover o hacer zoom.

Cambios:
- Primera carga rápida con imagen WMS ligera.
- Segunda carga de detalle automática cuando el mapa queda quieto.
- Menos tamaño de petición al IGN para reducir espera.
- Sin tiles/cuadrados, sin OSM y sin Esri.
- Mantiene solo IGN topográfico y PNOA aérea.
- Se mantiene el plano anterior mientras entra el nuevo.
- Service Worker v17 para limpiar cachés anteriores.

Sustituir: `index.html`, `sw.js`, `assets/js/app.js`, `assets/css/styles.css`.
