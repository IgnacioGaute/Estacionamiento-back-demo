# Modo operativo sin conexión

Reemplaza la interfaz de Consulta sin conexión. Esta entrega admite entradas por patente y salidas/cobros de estadías por hora, en una playa con turnos desactivados. Día/Sem/Mes, cortesías, devoluciones y registros históricos sin snapshot no están habilitados offline.

## Uso
1. Con conexión y la sesión de la playa activa: Modo sin conexión → Activar este equipo. Guardar la frase local de acceso.
2. Una sola combinación dispositivo/usuario queda reservada por playa. Otro equipo no puede preparar una contingencia simultánea.
3. Abrir modo operativo, ingresar la frase, registrar entradas y salidas. Confirmación local solo después de completar la transacción IndexedDB.
4. Las operaciones pendientes se sincronizan en orden al volver la conexión, al desbloquear y periódicamente mientras la pantalla está abierta. También existe Sincronizar ahora. Requiere sesión vigente del mismo usuario/playa.
5. Finalizar contingencia, online y sin pendientes, libera el equipo. Preparar una nueva jornada renueva la autorización de 24 horas.

No borrar almacenamiento, olvidar la frase, cambiar de usuario/playa ni cambiar de dispositivo con pendientes. No se garantiza sincronización en segundo plano con la app cerrada. Una actualización del service worker espera a que se cierren las ventanas anteriores; si sigue apareciendo Consulta sin conexión, cerrar todas las ventanas y reabrir con red.

## Persistencia y sincronización
- Los pendientes no vencen ni se eliminan al vencer la autorización de nuevas operaciones. La frase deriva AES-GCM con PBKDF2; no se envía al servidor. No se guardan tokens de sesión.
- Una revisión atómica en IndexedDB rechaza escrituras desde pestañas que leyeron una versión vieja.
- El servidor conserva snapshot de preparación, propietario, dispositivo y fechas autorizadas. No confía en tarifas enviadas por el navegador.
- Cada operación tiene UUID y huella de contenido. Operación, movimiento, caja e idempotencia se guardan en la misma transacción.
- Repetir un UUID con los mismos datos devuelve el resultado; cambiar su contenido produce conflicto.
- Entrada duplicada, salida ya cerrada o anticipo cambiado no se sobrescriben. Se conserva el pendiente con el error y se detiene la cola. La resolución administrativa de esos casos es manual; hay exportación de respaldo sin cifrar. No descartar ni volver a cobrar un pendiente para resolverlo.
- Caja diaria usa la fecha original de la salida. El movimiento conserva referencia con hora offline y fecha de recepción en el servidor. No altera arqueos de turnos cerrados.
- El admin remoto recibe los registros sincronizados. No puede conocer operaciones que todavía estén en un dispositivo sin red.
- El motor de precios del navegador es generado desde el mismo código de pricing del backend, no una fórmula alternativa. Regenerar después de cambios de tarifas con `node scripts/build-offline-pricing.cjs`.
- El desbloqueo local no verifica revocaciones remotas; la sincronización sí exige autorización vigente. Los usuarios con control del dispositivo pueden manipular el reloj local, pero el servidor valida rango temporal, precios, anticipos y propiedad.
- No se generan enlaces públicos antes de sincronizar. La impresión local y la integración de abonos/turnos quedan fuera de esta entrega.

## Despliegue
Aplicar la migración `1790000010000-offline-sessions` al iniciar el backend. Mantener frontend y backend en la misma versión de pricing. El archivo público `sw.js` no debe cachearse por CDN. Solo se almacenan archivos del shell público en Cache Storage: nunca API, HTML autenticado, RSC o mutaciones.

HTTPS es necesario salvo localhost para desarrollo. HTTP por IP local no sirve para probar desde celulares. Referencia: [Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API).

## Pruebas
- `pnpm build`
- `node --test test/tenant-isolation.integration.cjs`: DB temporal, RLS, dispositivo único, propietario, huella, reintentos concurrentes, saldo y fecha original.
- `node --test test/pwa-offline.test.cjs`: Chromium con red deshabilitada, recarga con pendiente, entrada, salida, copia cifrada, respuesta de sync perdida, reintento, conflicto de revisión entre pestañas, anchos móviles y equivalencia del motor browser/backend.
- Frontend: `pnpm exec tsc --noEmit`.

Validar además el dominio HTTPS real y cada equipo antes de usar la contingencia en producción. Si se pierde el almacenamiento local con una sesión activa, no liberar automáticamente ni reemplazarla: requiere revisar si existen cobros sin sincronizar.
