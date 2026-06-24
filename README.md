# Parche SECCIÓN C2 - planos IGN fluidos v16

Este parche mantiene el sistema de planos online del IGN, pero cambia la forma de pintarlos para que el movimiento y el zoom vayan más fluidos.

Incluye:
- IGN topográfico online.
- IGN vista aérea PNOA online.
- Sin OSM y sin Esri.
- Sin tiles/cuadrados visibles.
- El plano WMS se carga como imagen georreferenciada, no como imagen fija de pantalla.
- Al mover el mapa, la imagen actual se desplaza con el mapa y solo se solicita otra cuando hace falta.
- Al hacer zoom, mantiene la imagen anterior escalada mientras carga la nueva imagen de detalle.
- Se precarga una zona extra alrededor de la pantalla para reducir tirones al mover.
- CSS actualizado para evitar fondos grises o capas antiguas tapando el plano.
