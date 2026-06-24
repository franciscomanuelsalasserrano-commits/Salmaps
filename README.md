# SECCIÓN C2 - Optimización rapidez WMS V18

Parche parcial para acelerar la carga de planos IGN/PNOA sin volver a tiles.

Cambios:
- Primera carga WMS más ligera y rápida.
- Capa de detalle en segundo plano cuando el mapa queda quieto.
- Cancelación de cargas antiguas si sigues moviendo o haciendo zoom.
- Preconexión a `www.ign.es` desde `index.html`.
- Menor tamaño máximo de petición rápida al IGN para reducir espera.
- Mantiene plano anterior visible mientras entra el nuevo.

Sustituir: `index.html`, `sw.js`, `assets/js/app.js`, `assets/css/styles.css`.
