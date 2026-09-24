# Entrega de comprobantes

En **Administración → Tickets → Comprobantes** se activan por playa WhatsApp manual, QR e impresión. Son independientes y arrancan apagados. Con todos apagados, registrar entradas y salidas no abre el diálogo de entrega.

Se cubren las entradas por patente, por código de barras y por día/semana/mes, y sus salidas. Los errores al obtener un comprobante permiten reintentarlo sin volver a registrar la operación ni cobrar nuevamente.

WhatsApp abre un mensaje con el enlace dirigido al teléfono guardado al registrar la entrada por patente; el operador confirma el envío desde la sesión de la empresa. El número se ingresa con código de país, se recupera al elegir un cliente frecuente y se puede corregir antes de registrar la próxima visita. Si no hay teléfono, se elige el contacto en WhatsApp. No requiere la API de WhatsApp y no selecciona ni autentica automáticamente la cuenta de la empresa.

Los clientes con teléfono aparecen en frecuentes desde su primer ingreso, aunque la estadía siga abierta y no alcancen el mínimo de visitas. El teléfono está disponible solo para usuarios autorizados: no forma parte del comprobante público. La migración `1790000005000-registration-phone` agrega el campo sin modificar registros anteriores.

El QR contiene el mismo enlace público, generado localmente sin servicios externos de QR. Para usarlo desde el celular, el dominio de comprobantes debe ser accesible desde ese dispositivo (localhost apunta al propio celular).

## Dónde vive la página pública

El comprobante lo sirve una aplicación aparte —`estacionamiento-comprobantes-demo`, un servicio propio con su propio dominio— y no el sistema de gestión. El enlace que recibe el cliente es `<dominio de comprobantes>/c/<token>`, así que un QR o un mensaje de WhatsApp reenviado no revela dónde está la aplicación interna. Esa app no tiene sesión ni pantallas del sistema: pide `GET /public/parking-receipts/:token` desde su servidor y dibuja la respuesta; cualquier otra ruta responde 404. Como consulta desde el servidor, no necesita entrar en `ALLOWED_ORIGINS`, y el navegador del cliente tampoco ve la dirección de la API.

El frontend del sistema arma ese enlace con `NEXT_PUBLIC_RECEIPTS_URL`. Sin esa variable el diálogo de entrega avisa que falta configurarla en lugar de ofrecer enlaces rotos. Al cambiar el dominio de comprobantes, los enlaces ya entregados dejan de abrir: los tokens siguen siendo válidos, pero apuntan al dominio anterior.

La página pública ofrece descarga en PDF y PNG, generadas en el navegador con los datos del comprobante. En dispositivos compatibles permite compartir el PNG; también se puede abrir la imagen y mantenerla presionada para guardarla. La carpeta de descarga y la disponibilidad de guardar en Fotos dependen del navegador y del sistema del celular. Los controles de descarga no se imprimen.

La impresión abre una página para papel de 58 u 80 mm y el diálogo de impresión del navegador. La térmica USB debe estar instalada en la computadora del operador. Seleccionar la impresora, el tamaño de papel correspondiente y desactivar encabezados/pies del navegador. No es impresión silenciosa ni acceso USB directo desde el servidor.

Cada estadía tiene enlaces diferentes para entrada y salida. El backend conserva una copia de los datos al emitir por primera vez cada comprobante. Reintentar reutiliza el enlace; el de entrada no cambia al cerrar. El total cobrado de las estadías por hora contempla anticipos y ajustes y excluye cortesías. Los comprobantes no son facturas.

Los enlaces usan secretos aleatorios de 256 bits. Quien tiene un enlace puede leer ese comprobante sin iniciar sesión; la respuesta solo contiene datos del vehículo, playa, horarios e importes, sin usuarios ni movimientos internos. Desactivar un medio impide nuevas emisiones, pero conserva los enlaces ya entregados.

## Conocimiento del asistente y térmicas USB

El asistente explica configuración, entrega, recuperación de entradas activas y salidas, enlaces públicos, descargas y teléfonos de frecuentes. Su consulta de configuración incluye los medios habilitados y el ancho de papel de la playa autenticada; no modifica ajustes ni genera enlaces desde el chat.

La compatibilidad depende del modelo exacto, interfaz USB de datos y driver del sistema operativo. Antes de comprar, verificar que imprima desde el navegador. Referencias de fabricante para los ejemplos del manual (no equivalen a pruebas físicas con esta aplicación):

- Epson TM-T20III: [guía técnica, papel de 80/58 mm](https://files.support.epson.com/pdf/pos/bulk/tm-t20iii_trg_en_reva.pdf) y [driver oficial para Windows](https://download-center.epson.com/softwares/?device_id=TM-T20III&language=en&os=WIN1164&region=PT).
- Star TSP143IV-UE / TSP100IV: [soporte e instalación USB en Windows](https://starmicronics.com/support/fr/products/tsp100iv-support-page/).

No basta con que diga USB o ESC/POS. No se garantiza impresión silenciosa, corte, apertura de cajón ni impresión USB desde un celular.

## Despliegue

Son tres servicios: backend, frontend del sistema y app de comprobantes. La migración `1790000004000-parking-receipts` agrega la configuración, la tabla de comprobantes con aislamiento por playa y la fecha de salida de los abonos. Se aplica mediante el mecanismo existente de migraciones al arrancar el backend. No usar `DB_BOOTSTRAP` en una base existente.

En Railway, la app de comprobantes es un servicio más: no hace falta un template, cualquier servicio nuevo genera su dominio en Settings → Networking → Generate Domain. Necesita una sola variable, `API_URL`, con la URL pública del backend; nada con prefijo `NEXT_PUBLIC_`, porque eso terminaría en el navegador del cliente. Recién después se configura `NEXT_PUBLIC_RECEIPTS_URL` en el frontend del sistema con ese dominio.

## Verificación

Backend: `pnpm build` y `node --test test/tenant-isolation.integration.cjs`. El test usa un PostgreSQL temporal; no lee `.env` ni conecta con la base del proyecto. Comprueba permisos de administración/operador, separación entre playas, validación, enlaces públicos, reintentos concurrentes, importes, abonos e inmutabilidad.

Exportación PNG/PDF del comprobante: `node --test test/parking-receipt-export.test.cjs`, que lee el código de la app de comprobantes (necesita sus `node_modules` instalados).

Frontend del sistema y app de comprobantes: `pnpm exec tsc --noEmit` y `pnpm build`. La entrega física debe verificarse con la térmica instalada y la cuenta de WhatsApp de la empresa.
