# PWA y contingencia: estado de implementación

## Disponible

- Manifiesto instalable en móvil/escritorio; acceso de instalación en el menú de usuario.
- Service worker de alcance `/` que guarda únicamente una lista fija de archivos públicos de consulta offline. Nunca guarda HTML autenticado, RSC, API, tokens o mutaciones. No reintenta POST/PATCH/DELETE.
- Fallback de navegación ante falla de red o respuesta 5xx, con enlace para recuperar la aplicación. Errores 401/403/redirecciones no se sustituyen por contenido privado guardado.
- Consulta sin conexión desde la pantalla de operación: solicita una instantánea nueva al backend con la sesión y la playa autorizadas. No reemplaza la copia si falla alguna consulta.
- Una copia por navegador, cifrada con AES-GCM y clave derivada de una frase local de mínimo 12 caracteres (PBKDF2/SHA-256). La frase no se guarda ni se envía al servidor. Incluye identificación del vehículo, ingreso, tipo y tabla de tarifas de referencia; no incluye teléfonos, contraseñas, tokens ni caja.
- Vencimiento de 24 horas, bloqueo al ocultar la página o tras cinco minutos y eliminación explícita. Es consulta: las tarifas no son un cálculo de saldo y la copia puede quedar desactualizada inmediatamente.

La copia es optativa y permanece cifrada aunque se cierre sesión. Quien conozca la frase puede abrirla localmente; una revocación remota no puede verificarse sin red. No usar en dispositivos compartidos no confiables. El reloj local y el almacenamiento del navegador no son una barrera contra un atacante con control del dispositivo. Borrar datos del navegador elimina la copia.

## Pendiente: no habilitar cobros offline todavía

1. Registro servidor del único dispositivo de contingencia por playa, con asignación/revocación exclusiva del admin y tratamiento explícito de autorizaciones desconectadas.
2. Base local de operaciones persistentes con IDs de idempotencia, referencias entre ingresos/salidas y estado pendiente, enviado o conflicto. Nunca afirmar que el servidor confirmó antes de recibir su respuesta.
3. Cálculo local equivalente al motor real usando snapshots de tarifas por estadía, anticipos y reglas. Pruebas de equivalencia con horarios, tolerancia, días, fracciones y cortesía.
4. Endpoint de sincronización transaccional y aislado por playa: validar cada operación, autor, reloj y versión; no duplicar cobros al repetir un lote o perder una respuesta. Resolver entrada duplicada y doble cierre sin sobrescribir silenciosamente.
5. Mostrar conflictos al admin y distinguir operaciones pendientes de dinero confirmado. El admin remoto no puede saber qué operaciones existen aún en un equipo desconectado.
6. Comprobantes locales provisionales e impresión; enlaces públicos disponibles luego de la sincronización. Cobertura de turnos, tickets físicos y Día/Sem/Mes antes de anunciar soporte completo.

## Despliegue y prueba

Requiere HTTPS, salvo localhost para desarrollo; HTTP por IP de red local no sirve para comprobar una instalación real en un celular. Ver [contextos seguros para service workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API).

Desplegar los archivos públicos y `/sw.js` junto al frontend. Incrementar la versión de caché al cambiar el shell. El worker nuevo espera hasta que se cierren sus clientes; no se fuerza una actualización mientras se opera. Si se agregan operaciones pendientes, nunca eliminar su almacenamiento al cambiar la versión del shell.

`node --test test/pwa-offline.test.cjs`: navegador Chromium real y servidor temporal, sin `.env` ni base de negocio. Comprueba recarga con red deshabilitada, ausencia de caché privada, cifrado, contraseña incorrecta, consulta, bloqueo, vencimiento, borrado y anchos móviles.

Validar además instalación real en Android/iOS y escritorio con el dominio HTTPS del despliegue. Esta etapa no reserva un dispositivo de contingencia ni permite registrar cobros sin conexión.
