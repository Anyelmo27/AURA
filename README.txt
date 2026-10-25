AURA (PC) - Puente y scripts
=============================

Archivos:
- pc_bridge.js          : servidor Node.js (puente PC <-> NEXO). Corre en puerto 8766.
- set_volume.ps1        : ajusta volumen maestro de la PC (0-100, mute, subir/bajar).
- set_volume_max.ps1    : pone volumen al 100%.
- set_volume_15.ps1     : pone volumen al 15%.
- start_pc_bridge.bat   : arranca el puente con doble clic.
- firewall_pc_bridge.bat: abre el puerto 8766 (ejecutar como Administrador, una vez).

Requisitos:
- Node.js instalado (https://nodejs.org).
- PowerShell (incluido en Windows).
- OpenCode CLI (opcional, para pc_opencode) instalado y con creditos.

Uso:
1. Ejecuta firewall_pc_bridge.bat como Administrador (solo la primera vez).
2. Ejecuta start_pc_bridge.bat (deja la ventana abierta).
3. Desde el celular con NEXO, prueba "Nexo, prueba la conexion con la PC".

Configuracion (en pc_bridge.js):
- PORT = 8766
- TOKEN = "nexo-pc-2026"  (cambia y pon el mismo en NEXO)
- BASES: carpetas permitidas (descargas, documentos, escritorio, imagenes)

Carpetas base permitidas se pueden ampliar editando BASES.