# Parche planos IGN online limpio

Este parche elimina la lógica anterior de planos y deja únicamente dos capas online oficiales del IGN:

- IGN topográfico, desde el WMS `mapa-raster`, capa `mtn_rasterizado`.
- IGN vista aérea, desde el WMS `pnoa-ma`, capa `OI.OrthoimageCoverage`.

La carga se hace como imagen WMS completa de la vista, no mediante teselas visibles. Al mover o hacer zoom, la aplicación mantiene la imagen anterior y pide una imagen nueva al IGN para la nueva escala.

Archivos incluidos para sustituir:

- `index.html`
- `sw.js`
- `assets/js/app.js`
- `assets/css/styles.css`

Después de subirlos a GitHub Pages, borra datos del sitio o prueba en incógnito para evitar que el navegador use un Service Worker anterior.
