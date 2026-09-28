# Entrega de comprobantes

En **Administración → Configuración → Comprobantes** se activan por playa WhatsApp manual, QR e impresión (QR e impresión valen también para los recibos de pago de inquilinos; su WhatsApp depende del celular, más abajo). Son independientes y arrancan apagados. Con todos apagados, registrar entradas y salidas no abre el diálogo de entrega.

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

## Recibos de pago de inquilinos

Los pagos a la cuenta corriente de un inquilino usan el mismo circuito. QR y térmica siguen la configuración de la playa. WhatsApp, en cambio, se ofrece siempre que el inquilino tenga un celular válido cargado, aunque el WhatsApp de los tickets esté apagado: el inquilino es un contacto conocido, no un cliente de paso. Sin celular la opción no aparece y un aviso arriba explica por qué. Sin ningún medio (QR y térmica apagados y sin celular) no se emite enlace y queda la impresión en hoja de siempre, que no pasa por el sitio de comprobantes. Se ofrece al terminar el cobro y después desde la pestaña Pagos de la cuenta (`POST /cuentas/pagos/:id/comprobante`, habilitado también para operadores).

El comprobante es `kind: 'PAGO'` y su `registrationId` es el asiento del pago en `cuenta_movimientos` (un pago con dos medios tiene un solo recibo). La copia congelada tiene número, fecha, nombre del inquilino, total, medios, a qué cargos se aplicó y cómo quedó cada uno, lo que quedó a favor y el saldo de la cuenta en ese momento; no tiene usuarios ni ids. Si el pago se anula después, el enlace sigue abriendo pero muestra «Anulado · sin validez» (el backend lo calcula al leer, no está en la copia) y ya no se puede emitir uno nuevo. Lleva la «X» de documento no válido como factura.

El sitio de comprobantes distingue el tipo por `kind` y exporta el recibo de pago a PNG/PDF con el mismo mecanismo (`recibo-pago-<número>-<fecha>`).

## Cobro con QR de MercadoPago a inquilinos

Además de efectivo y transferencia, el cobro a un inquilino ofrece un QR de MercadoPago (`tipo: 'INQUILINO'` en `POST /mercadopago/cobros`, con el importe elegido, los cargos marcados y la nota). A diferencia de las estadías, el importe lo decide el mostrador porque puede pagar una parte o de más. El pago se asienta solo cuando la consulta a MercadoPago confirma que entró: un único PAGO con medio `MERCADOPAGO`, que no toca la caja física ni el turno. Si mientras tanto alguno de los cargos marcados se saldó por otra vía, el importe se aplica a lo que siga pendiente. Un pago acreditado por MercadoPago no se anula (la plata entró): si hay que devolverla, se registra una devolución. Con el QR esperando, el diálogo no se cierra: hay que cancelarlo o esperar la acreditación, para que no quede un pago que nadie consulta.

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

Exportación PNG/PDF del comprobante y del recibo de pago: `node --test test/parking-receipt-export.test.cjs`, que lee el código de la app de comprobantes (necesita sus `node_modules` instalados). Recibos de pago y QR de inquilinos: `node --test test/cuentas.integration.cjs` (MercadoPago simulado).

Frontend del sistema y app de comprobantes: `pnpm exec tsc --noEmit` y `pnpm build`. La entrega física debe verificarse con la térmica instalada y la cuenta de WhatsApp de la empresa.
