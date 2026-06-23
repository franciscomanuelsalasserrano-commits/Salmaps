# SECCIÓN C2 - parche de planos continuos

Este parche modifica solo la parte de mapas/planos de la PWA.

## Cambio principal

La capa por defecto deja de usar teselas visibles una a una y pasa a usar una imagen completa WMS de la vista actual. Al ampliar o mover el mapa, la app mantiene la imagen anterior y reemplaza la vista completa cuando el nuevo plano está cargado.

Capas incluidas:

- Plano continuo IGN
- Vista aérea continua PNOA
- Plano rápido OSM, como respaldo por teselas
- Satélite Esri, como respaldo por teselas

También se mantiene el botón de GPS y el marcador de posición con icono triangular.

## Archivos a sustituir

Copia estos archivos encima del proyecto anterior:

- `index.html`
- `sw.js`
- `assets/css/styles.css`
- `assets/js/app.js`
- `README.md`

## Importante

Después de subir los archivos a GitHub Pages, abre Chrome en el móvil y borra los datos del sitio de `commits.github.io`, o abre una pestaña de incógnito para probar. Si queda activo el Service Worker viejo, puede seguir cargando la versión anterior aunque hayas subido archivos nuevos.
