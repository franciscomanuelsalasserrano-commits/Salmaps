# Parche planos completos v2

Sustituye estos archivos en tu proyecto:

- index.html
- sw.js
- assets/js/app.js
- assets/css/styles.css

Cambios:
- Se elimina la imagen continua WMS que generaba franjas negras al alejar el zoom.
- Se usa cartografía ráster IGN en TMS/teselas oficiales para que al abrir España y al acercar/alejar cargue el plano completo visible.
- Se mantiene solo IGN topográfico y PNOA.
- Se elimina el segundo triángulo azul: queda solo el marcador GPS real de Leaflet.
- Se elimina el aviso de carga.
