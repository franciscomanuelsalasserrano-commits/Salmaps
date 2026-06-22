# SECCIÓN C2

Prototipo web/PWA, pensado para GitHub Pages, de una aplicación de mando y control de nivel sección centrada en:

- mapa desplegable con OpenStreetMap, capa IGN España y vista aérea PNOA;
- posición GPS y seguimiento local;
- puntos tácticos sobre el mapa;
- chat almacenado localmente;
- carga, descarga y archivo local de documentos;
- exportación/importación de mensajes, puntos y ajustes;
- instalación como PWA en móvil y funcionamiento básico sin conexión.

## Publicar en GitHub Pages

1. Crea un repositorio nuevo en GitHub.
2. Sube **todo el contenido de esta carpeta a la raíz** del repositorio.
3. En GitHub abre `Settings > Pages`.
4. En `Build and deployment`, selecciona `Deploy from a branch`.
5. Selecciona la rama `main` y la carpeta `/ (root)`.
6. Guarda y abre la URL publicada por GitHub.

La geolocalización y el service worker requieren HTTPS. GitHub Pages sirve el sitio mediante HTTPS.

## Uso

- **Mapa:** permite centrar la posición, activar seguimiento, colocar puntos y cambiar la capa base desde el selector «Capa». La opción elegida se guarda en el navegador.
- **Chat:** conserva los mensajes únicamente en el navegador actual.
- **Documentos:** guarda archivos con IndexedDB en el navegador actual.
- **Ajustes:** cambia indicativo/unidad y exporta o importa datos JSON.

## Limitaciones importantes

Este proyecto es un **prototipo frontend sin backend**:

- no sincroniza datos entre usuarios o dispositivos;
- no incluye autenticación;
- no incorpora cifrado de extremo a extremo;
- los archivos y mensajes permanecen en el navegador local;
- las teselas del mapa base requieren conexión, salvo las que el navegador haya almacenado previamente; las capas IGN/PNOA dependen de los servicios públicos del IGN y están orientadas a España;
- no está auditado ni homologado para uso militar, emergencias o información sensible.

No debe emplearse con información clasificada, datos operativos reales o información cuya filtración pueda causar daños.

## Evolución recomendada

Para convertirlo en una plataforma multiusuario real se necesita un backend privado con autenticación, control de roles, registro de auditoría, almacenamiento cifrado, canal en tiempo real y una revisión de seguridad independiente. Una arquitectura posible sería:

- frontend PWA;
- API privada;
- WebSocket para chat/presencia;
- almacenamiento de objetos para documentos;
- base de datos con control de acceso por unidad;
- cifrado en tránsito y en reposo;
- despliegue fuera de GitHub Pages para entornos operativos.

## Desarrollo local

No abras `index.html` directamente desde el sistema de archivos. Sirve la carpeta con un servidor local, por ejemplo:

```bash
python3 -m http.server 8080
```

Después abre `http://localhost:8080`.
