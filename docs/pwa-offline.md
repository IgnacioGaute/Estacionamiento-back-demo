# Modo operativo sin conexión

La copia operativa incluye entradas por patente, apellido o tarjeta; datos de cliente y casillero; anticipos y duración prevista; pagos en efectivo, transferencia verificada o mixtos; descuentos por importe, tarifa anterior o saldo completo; cortesías; devoluciones; correcciones de patente, vehículo y hora reciente de ingreso; salida anterior y eliminación administrativa de una carga sin cobros. También permite registrar, cobrar y retirar estadías por día/semana/mes. La pantalla local no ofrece caja, turnos, ingresos/gastos ni retiros/aportes; esas operaciones se realizan con conexión. Se mantiene la sincronización de operaciones de caja pendientes generadas con versiones anteriores. Cada confirmación local se guarda cifrada antes de mostrarse como pendiente.

En gratuito no requiere tarifas ni registra importes, medios de pago, movimientos, caja o comprobantes. Cada estadía conserva su modalidad, incluso si ingresó gratis y la playa volvió a cobrar. Las nuevas opciones requieren una copia con `operationVersion: 3`; las copias anteriores conservan sus pendientes y el flujo de entrada/salida hasta renovarse con red. No se modifica el formato cifrado versión 2.

Requieren internet la lectura automática de patentes por cámara, el asistente remoto, generar/verificar un cobro QR o verificar una transferencia bancaria, enviar WhatsApp y generar un enlace público nuevo. Una transferencia manual sólo se registra si el operador ya verificó el pago. Los comprobantes locales, imágenes e impresión/PDF funcionan sin conexión. La pantalla conoce sólo lo descargado y lo operado en ese equipo.

La sincronización reproduce los métodos del dominio normal en la misma transacción que la idempotencia, con el reloj original y las tarifas descargadas. Verifica permisos actuales, propietario de sesión y turno, estado previo de estadía/abono, importes y efectivo esperado. No reemplaza registros por colisión de UUID ni modifica arqueos contados: un cierre con movimientos posteriores, una jornada ya cerrada, cambios de configuración o datos de otro equipo quedan pendientes para revisión. Un cierre que cruza un corte automático posterior también requiere revisión. El panel de pendientes permite guardar un respaldo JSON. Si cambia la modalidad durante el corte, se conservan los pendientes y se exige restaurar la modalidad original para reproducirlos.

## Uso
1. Al abrir la pantalla de operación con sesión e internet, el navegador prepara los datos automáticamente. Mientras se ve la app comprueba cambios cada minuto y agrupa los movimientos seguidos por un segundo. Sin cambios recibe una confirmación pequeña y evita descargar, descifrar y cifrar otra vez la misma copia. Aun sin movimientos renueva la autorización cada hora para conservar al menos 23 horas de vigencia offline. Con pendientes nunca reemplaza la copia. No hay botón de activación. Requiere navegador con Service Worker, IndexedDB, Web Crypto y Web Locks.
2. Varios dispositivos pueden tener sesiones simultáneas. Durante un corte cada uno conoce solo su copia local; no puede ver ingresos nuevos de otro equipo. Coordinar qué vehículo atiende cada operador para evitar cobros físicos duplicados. El servidor detecta conflictos, no puede revertir dinero recibido físicamente.
3. Abrir modo operativo y registrar entradas y salidas directamente. En /tickets, un corte detectado abre automáticamente la pantalla local si hay datos preparados. Las copias antiguas piden su frase una sola vez para migrar el acceso, sin borrar pendientes. Confirmación local solo después de completar la transacción IndexedDB.
4. Las operaciones pendientes se sincronizan en orden al volver la conexión, al desbloquear y periódicamente mientras la pantalla está abierta. También existe Sincronizar ahora. Requiere sesión vigente del mismo usuario/playa.
5. Finalizar contingencia, online y sin pendientes, libera el equipo. Preparar una nueva jornada renueva la autorización de 24 horas.

No borrar almacenamiento, cambiar de usuario/playa ni cambiar de dispositivo con pendientes. No se garantiza sincronización en segundo plano con la app cerrada. Una actualización del service worker espera a que se cierren las ventanas anteriores; si sigue apareciendo la pantalla anterior, cerrar todas las ventanas y reabrir con red.

## Consulta de comprobantes

El historial local permite buscar por patente, filtrar entradas/salidas, estado (pendiente, sincronizado o copia anterior al corte) y rango de fechas inclusivo según Buenos Aires. Los filtros se combinan y pueden limpiarse juntos. Muestra ocho comprobantes por página, del más reciente al más antiguo; filtrar o paginar no modifica los registros guardados y funciona sin conexión.

## Persistencia y sincronización
- Los pendientes no vencen ni se eliminan al vencer la autorización de nuevas operaciones. El secreto local deriva AES-GCM con PBKDF2; no se envía al servidor. Se conserva envuelto con una CryptoKey no exportable en IndexedDB para acceso automático. Esto NO protege contra alguien con acceso al mismo perfil del navegador: usar bloqueo del dispositivo. No se guardan tokens de sesión. No hay bloqueo automático al cambiar de pestaña.
- Una revisión atómica en IndexedDB rechaza escrituras desde pestañas que leyeron una versión vieja.
- La preparación reutiliza en memoria la lectura descifrada solo dentro de la misma cuenta/playa y mientras coincida la revisión de IndexedDB; una escritura desde otra pestaña la invalida. El servidor compara el contenido vigente bajo los mismos bloqueos y permisos antes de responder `unchanged`, sin modificar sesiones anteriores. Al ocultar la app se pausan los controles y se aborta la descarga; al volver se comprueba el estado.
- El servidor conserva snapshot de preparación, propietario, dispositivo y fechas autorizadas. No confía en tarifas enviadas por el navegador.
- Cada operación tiene UUID y huella de contenido. Operación, movimiento, caja e idempotencia se guardan en la misma transacción.
- Repetir un UUID con los mismos datos devuelve el resultado; cambiar su contenido produce conflicto.
- Entrada duplicada, salida ya cerrada o anticipo cambiado no se sobrescriben. Se conserva el pendiente con el error y se detiene la cola. La resolución administrativa de esos casos es manual; hay exportación de respaldo sin cifrar. No descartar ni volver a cobrar un pendiente para resolverlo.
- Caja diaria usa la fecha original de la salida. El movimiento conserva referencia con hora offline y fecha de recepción en el servidor. No altera arqueos de turnos cerrados.
- El admin remoto recibe los registros sincronizados. No puede conocer operaciones que todavía estén en un dispositivo sin red.
- El motor de precios del navegador es generado desde el mismo código de pricing del backend, no una fórmula alternativa. Regenerar después de cambios de tarifas con `node scripts/build-offline-pricing.cjs`.
- El desbloqueo local no verifica revocaciones remotas; la sincronización sí exige autorización vigente. Los usuarios con control del dispositivo pueden manipular el reloj local, pero el servidor valida rango temporal, precios, anticipos y propiedad.
- Comprobantes locales de entrada y salida: disponibles solo si la entrega estaba habilitada en la configuración descargada. Admiten PNG, QR con datos locales y, con impresión habilitada, impresión/PDF del navegador. Se identifican como pendientes hasta sincronizar. No se generan enlaces públicos nuevos antes de sincronizar. WhatsApp requiere red.

## Despliegue
Aplicar las migraciones `1790000010000-offline-sessions` y `1790000013000-offline-multiple-devices` al iniciar el backend. Cada renovación conserva la sesión previa para no invalidar operaciones de una pestaña en carrera; no borrar sesiones sin auditar pendientes. Mantener frontend y backend en la misma versión de pricing. El archivo público `sw.js` no debe cachearse por CDN. Solo se almacenan archivos del shell público en Cache Storage: nunca API, HTML autenticado, RSC o mutaciones.

HTTPS es necesario salvo localhost para desarrollo. HTTP por IP local no sirve para probar desde celulares. Referencia: [Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API).

## Pruebas
- `pnpm build`
- `node --test test/tenant-isolation.integration.cjs`: DB temporal, RLS, múltiples dispositivos, conflictos, propietario, huella, reintentos concurrentes, saldo y fecha original.
- `node --test test/pwa-offline.test.cjs`: Chromium con red deshabilitada, recarga con pendiente, entrada, salida, copia cifrada, respuesta de sync perdida, reintento, conflicto de revisión entre pestañas, anchos móviles y equivalencia del motor browser/backend.
- `node --test test/offline-actions.integration.cjs`: PostgreSQL efímero, cola completa de apertura/cobro/cierre, descuentos, anticipos, devolución, pago mixto, abonos y permisos.
- `node --test test/pwa-operations.test.cjs`: reproducción local completa, datos inválidos sin mutación, persistencia, formularios y diálogos a 320/390/1280 px.
- Frontend: `pnpm exec tsc --noEmit`.

Validar además el dominio HTTPS real y cada equipo antes de usar la contingencia en producción. Si se pierde el almacenamiento local con una sesión activa, no liberar automáticamente ni reemplazarla: requiere revisar si existen cobros sin sincronizar.
