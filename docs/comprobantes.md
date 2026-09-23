# Entrega de comprobantes

En **Administración → Tickets → Comprobantes** se activan por playa WhatsApp manual, QR e impresión. Son independientes y arrancan apagados. Con todos apagados, registrar entradas y salidas no abre el diálogo de entrega.

Se cubren las entradas por patente, por código de barras y por día/semana/mes, y sus salidas. Los errores al obtener un comprobante permiten reintentarlo sin volver a registrar la operación ni cobrar nuevamente.

WhatsApp abre un mensaje con el enlace dirigido al teléfono guardado al registrar la entrada por patente; el operador confirma el envío desde la sesión de la empresa. El número se ingresa con código de país, se recupera al elegir un cliente frecuente y se puede corregir antes de registrar la próxima visita. Si no hay teléfono, se elige el contacto en WhatsApp. No requiere la API de WhatsApp y no selecciona ni autentica automáticamente la cuenta de la empresa.

Los clientes con teléfono aparecen en frecuentes desde su primer ingreso, aunque la estadía siga abierta y no alcancen el mínimo de visitas. El teléfono está disponible solo para usuarios autorizados: no forma parte del comprobante público. La migración `1790000005000-registration-phone` agrega el campo sin modificar registros anteriores.

El QR contiene el mismo enlace público, generado localmente sin servicios externos de QR. Para usarlo desde el celular, el dominio del frontend debe ser accesible desde ese dispositivo (localhost apunta al propio celular).

La página pública ofrece descarga en PDF y PNG, generadas en el navegador con los datos del comprobante. En dispositivos compatibles permite compartir el PNG; también se puede abrir la imagen y mantenerla presionada para guardarla. La carpeta de descarga y la disponibilidad de guardar en Fotos dependen del navegador y del sistema del celular. Los controles de descarga no se imprimen.

La impresión abre una página para papel de 58 u 80 mm y el diálogo de impresión del navegador. La térmica USB debe estar instalada en la computadora del operador. Seleccionar la impresora, el tamaño de papel correspondiente y desactivar encabezados/pies del navegador. No es impresión silenciosa ni acceso USB directo desde el servidor.

Cada estadía tiene enlaces diferentes para entrada y salida. El backend conserva una copia de los datos al emitir por primera vez cada comprobante. Reintentar reutiliza el enlace; el de entrada no cambia al cerrar. El total cobrado de las estadías por hora contempla anticipos y ajustes y excluye cortesías. Los comprobantes no son facturas.

Los enlaces usan secretos aleatorios de 256 bits. Quien tiene un enlace puede leer ese comprobante sin iniciar sesión; la respuesta solo contiene datos del vehículo, playa, horarios e importes, sin usuarios ni movimientos internos. Desactivar un medio impide nuevas emisiones, pero conserva los enlaces ya entregados.

## Actualización

Desplegar backend y frontend juntos. La migración `1790000004000-parking-receipts` agrega la configuración, la tabla de comprobantes con aislamiento por playa y la fecha de salida de los abonos. Se aplica mediante el mecanismo existente de migraciones al arrancar el backend. No usar `DB_BOOTSTRAP` en una base existente.

## Verificación

Backend: `pnpm build` y `node --test test/tenant-isolation.integration.cjs`. El test usa un PostgreSQL temporal; no lee `.env` ni conecta con la base del proyecto. Comprueba permisos de administración/operador, separación entre playas, validación, enlaces públicos, reintentos concurrentes, importes, abonos e inmutabilidad.

Frontend: `pnpm exec tsc --noEmit`. La entrega física debe verificarse con la térmica instalada y la cuenta de WhatsApp de la empresa.
