# SECCIÓN C2 - parche mapas V6

Este ZIP contiene solo los archivos a sustituir para corregir la carga del mapa y hacer visible la posición GPS.

Cambios:
- Capa por defecto cambiada a **Plano rápido** con servidor CDN más estable.
- Capa **OpenStreetMap**, **IGN España**, **Vista aérea PNOA** y **Satélite Esri** disponibles en el selector.
- Se elimina el sistema híbrido anterior que podía dejar huecos y cuadrados sin cargar.
- El mapa ya no usa scroll interno y se fuerza el reajuste de tamaño tras abrir, mover o hacer zoom.
- Nuevo marcador GPS doble: marcador Leaflet + marcador HTML fijo sobre el mapa. Así se ve aunque falle la capa de Leaflet.
- Service Worker v6: borra cachés antiguas y no intercepta teselas externas.

Tras subir los archivos a GitHub Pages, borra los datos del sitio o recarga completamente para eliminar el Service Worker anterior.
