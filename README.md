# Parche SECCIÓN C2 - IGN online senior WMS v15

Este parche rehace únicamente el sistema de planos IGN para que el zoom vuelva a pedir una imagen WMS nueva de la vista actual.

Incluye:
- IGN topográfico online.
- IGN vista aérea PNOA online.
- Sin OSM, sin Esri, sin WMTS/TMS/tiles visibles.
- Renderizado con una sola imagen WMS completa de la vista.
- Al ampliar, alejar o mover, mantiene el plano anterior y solicita al IGN una imagen nueva con el BBOX y resolución actuales.
- Corrección CSS para evitar capas grises o capas antiguas tapando la nueva.
