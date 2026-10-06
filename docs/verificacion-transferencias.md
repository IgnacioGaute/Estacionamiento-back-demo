# Verificación de transferencias recibidas (investigación y prueba)

Objetivo: cuando una persona transfiere al alias del comercio, que el operador pueda comprobar desde el sistema
si llegó el dinero y asociarlo al cobro correcto.

**Estado: implementada y en prueba; todavía no se vende ni se factura.** Lo que existe hoy en el código es:

- las **condiciones de uso** que la empresa acepta al conectar su cuenta (`src/mercadopago/condiciones.ts`, con
  versión, quién y cuándo en `mercadopago_cuentas`);
- la **verificación por alias** en el cobro de estadías (sección 6), detrás de tres llaves: adicional habilitado por
  el super admin, activada por la empresa y cuenta conectada;
- la **prueba** (`PruebaTransferenciasService`), que usa el administrador de la empresa sobre su propia cuenta desde
  Configuración → MercadoPago. No toca cobros, caja ni movimientos.

El cobro con QR (`CobrosMercadoPagoService`) no cambia y no depende de esto.

## 1. Qué está documentado por MercadoPago

| Afirmación | Fuente |
| --- | --- |
| OAuth con Authorization Code da acceso a recursos de la cuenta de un vendedor que autoriza la aplicación; el refresh token dura 6 meses | [OAuth](https://www.mercadopago.com.ar/developers/es/docs/security/oauth/introduction) |
| El reporte «Todas las transacciones» incluye «el detalle de tus pagos, los ingresos de dinero, los contracargos y las devoluciones»; los movimientos «se impactan automáticamente en el reporte cuando se aprueba la operación»; pendientes y rechazados no aparecen | [Reporte: introducción](https://www.mercadopago.com.ar/developers/es/docs/reports/account-money/introduction) |
| El reporte se genera por API de forma **asíncrona**: `POST /v1/account/settlement_report` (`begin_date`, `end_date`) responde 202; se lista con `GET /v1/account/settlement_report/list` y se descarga con `GET /v1/account/settlement_report/:file_name` (CSV). La configuración (columnas, separador, idioma) va en `/v1/account/settlement_report/config` | [Reporte por API](https://www.mercadopago.com.ar/developers/es/docs/checkout-api-orders/resources/reports/account-money/api) |
| Columnas: `SOURCE_ID` (id de la operación), `TRANSACTION_TYPE` (`SETTLEMENT` = pago aprobado, `REFUND`, `CHARGEBACK`, `DISPUTE`, `WITHDRAWAL`, `WITHDRAWAL_CANCEL`, `PAYOUT`), `TRANSACTION_AMOUNT`, `TRANSACTION_CURRENCY`, `TRANSACTION_DATE`, `PAYMENT_METHOD_TYPE` (incluye `bank_transfer` y `available_money`), `PAY_BANK_TRANSFER_ID`, `POI_BANK_NAME`, `POI_WALLET_NAME` | [Campos del reporte](https://www.mercadopago.com.ar/developers/es/docs/reports/account-money/report-fields) |
| `PAYER_NAME` «estará disponible cuando se reciban pagos con código QR, **transferencias**…»; los datos del pagador «solo se podrán usar para conciliar» y se tratan según la ley de datos personales | [Campos del reporte](https://www.mercadopago.com.ar/developers/es/docs/reports/account-money/report-fields) |
| Los reportes de cuentas de prueba salen **sin datos** (el flujo funciona, el contenido no): el sandbox no sirve para esta prueba | [Reporte: introducción](https://www.mercadopago.com.ar/developers/es/docs/reports/account-money/introduction) |
| `GET /v1/payments/search` busca pagos de los últimos 12 meses, con filtros como `collector.id`, `payer.id`, rango de fechas y orden | [Búsqueda de pagos](https://www.mercadopago.com.br/developers/en/reference/online-payments/checkout-pro-preferences/search-payments/get) |

**Lo que la documentación NO dice** (no se da por cierto):

- Cuánto tarda en generarse un reporte pedido por API, ni límites de rango o de cantidad.
- Si los endpoints de reportes aceptan el token OAuth de un tercero (las páginas hablan del access token del
  vendedor).
- Si una transferencia directa al alias, hecha fuera de nuestra aplicación, aparece en `/v1/payments/search`, con qué
  `operation_type` y con qué demora. Una referencia de la API menciona `money_transfer` como tipo de operación, pero
  no pudimos leer la página oficial completa; no alcanza para identificar una transferencia al alias.
- Que `bank_transfer` identifique una transferencia directa al alias (también lo usan otros cobros).
- Ningún tópico de webhook documentado avisa «dinero recibido» o «transferencia recibida». Los tópicos que
  encontramos son de pagos, órdenes, suscripciones, contracargos y vinculación. Tampoco está documentado que el
  tópico `payment` llegue por pagos que no creó la aplicación.

## 2. Qué observamos (cuenta propia, conectada por el mismo OAuth que usan los clientes)

05/10/2026, con la cuenta 569194738:

- `/v1/payments/search` con el token OAuth **funciona** y devuelve operaciones hechas **fuera de nuestra
  aplicación**, en las dos direcciones: trajo pagos que hizo la cuenta (una suscripción, un pago con tarjeta, un pago
  con QR en un local). Por eso la prueba separa ingresos de egresos por `collector_id` y nunca muestra los egresos.
- `/users/:id/mercadopago_account/balance` → **403** `forbidden`.
- `/mercadopago_account/movements/search` → **403** `Public access not allowed`.

Saldo y movimientos no están disponibles para una aplicación OAuth. Quedan dos vías: la búsqueda de pagos y el
reporte.

## 3. Qué falta probar

| Pregunta | Cómo se responde |
| --- | --- |
| ¿La transferencia desde un banco aparece en la búsqueda de pagos? ¿Con qué `operation_type`, `payment_type_id`, `payment_method_id`, estado y datos del remitente? | Caso 1 |
| ¿Y la transferencia desde otra cuenta de MercadoPago? | Caso 2 |
| ¿Cuánto tarda en aparecer (`date_created`/`date_approved` contra la hora real de envío y la de consulta)? | Casos 1 y 2, consultando a los 0, 1, 2 y 5 minutos |
| Dos transferencias del mismo importe: ¿se distinguen? ¿Con qué datos? | Caso 3 |
| ¿Se distingue una transferencia de un cobro con QR del sistema? | Caso 5 |
| ¿Los endpoints del reporte aceptan el token OAuth? ¿Hay que crear la configuración? ¿Cuánto tarda el reporte? ¿Las transferencias aparecen con `PAYER_NAME`/`PAYER_ID_*`? | Caso 4 |
| ¿Llega algún aviso (webhook) por una transferencia recibida? | Fuera de esta prueba: no hay tópico documentado. Se diseña sin depender de eso |

Una lista vacía no prueba que MercadoPago «no lo permite», y dos casos exitosos no prueban que «funciona para todos».
Lo observado se anota como observado, separado de lo documentado.

**No se prueban contra MercadoPago** (dependen de nuestro código y se cubren con tests de integración cuando se
implemente): que una operación ya usada no se pueda volver a usar, y que dos operadores verificando al mismo tiempo
no la usen dos veces.

## 4. Protocolo de la prueba

Requisitos:

1. La cuenta está conectada a una empresa por el flujo normal (Configuración → MercadoPago → Conectar), con las
   condiciones vigentes aceptadas. Una cuenta conectada antes ve un aviso para aceptarlas; sin eso la prueba
   contesta 403 `CONDICIONES_SIN_ACEPTAR` sin descifrar el token.
2. La usa un **administrador de esa empresa**, en su sesión: la cuenta es siempre la de su empresa. El operador no
   entra, y el super admin tampoco (403 `SOLO_LA_EMPRESA`), aunque elija una playa de la empresa.
3. Pantalla: Configuración → MercadoPago, debajo de la cuenta conectada → «Transferencias recibidas en
   MercadoPago». Muestra solo lo que entró; lo que pagó la cuenta solo se cuenta.

| Caso | Qué hacer | Qué anotar |
| --- | --- | --- |
| 1 | Transferir $10 desde una cuenta bancaria al alias. Consultar pagos (5 min) enseguida y al minuto 1, 2 y 5 | Hora de envío; si aparece y en qué consulta; `operacion`, `tipo`, `medio`, `estado`; nombre y documento del remitente; `origen` |
| 2 | Pedir a otra persona $11 desde su billetera de MercadoPago. Igual que el caso 1 | Ídem |
| 3 | Dos transferencias de $12 desde orígenes distintos con un minuto de diferencia | Si aparecen las dos, con ids distintos, y qué las diferencia |
| 4 | Reporte: «Ver estado» (si no hay configuración, «Crear configuración»), «Pedir reporte» con ventana de 2 h y, cada pocos minutos, «Ver estado» hasta que aparezca; «Leer» | Si los endpoints aceptan el token; minutos entre el pedido y el archivo; si los casos 1–3 están, con `PAYMENT_METHOD_TYPE`, `PAYER_NAME`, `PAYER_ID_*`, `PAY_BANK_TRANSFER_ID` |
| 5 | Un cobro chico con el QR del sistema (control) | Cómo se ve un cobro del sistema (tiene `external_reference`) frente a una transferencia |
| 6 | Repetir el caso 1 consultando recién a los 10 minutos con ventana de 5 y después de 30 | Que la ventana corta no lo encuentra y la larga sí (la ventana no puede descartar pagos demorados) |

Resultados:

| Caso | Fecha y hora | Aparece en pagos | Demora | Tipo / medio | Remitente | Aparece en reporte (demora) | Notas |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 |  |  |  |  |  |  |  |
| 2 |  |  |  |  |  |  |  |
| 3 |  |  |  |  |  |  |  |
| 4 |  |  |  |  |  |  |  |
| 5 |  |  |  |  |  |  |  |
| 6 |  |  |  |  |  |  |  |

## 5. Mostrador o conciliación posterior

- **Si las transferencias aparecen en la búsqueda de pagos en segundos o pocos minutos**, sirve para el mostrador:
  el operador consulta en el momento de cobrar.
- **El reporte es asíncrono y su demora no está documentada.** Salvo que la prueba muestre que se genera en uno o
  dos minutos, sirve para conciliar después (al cerrar el turno o al día siguiente: qué transferencias declaradas
  por el operador no aparecen), no para confirmar en el mostrador. Una conciliación posterior no se presenta como
  confirmación instantánea.
- Si ninguna de las dos vías las muestra de forma confiable, la verificación no se ofrece y el cobro electrónico
  confirmado sigue siendo el QR.

## 6. La verificación por alias (implementada, en prueba)

Construida sobre lo observado: una transferencia al CVU apareció en `/v1/payments/search` 22 segundos después de
hecha. El QR sigue igual y no depende de esto.

### Tres llaves, verificadas en cada consulta y confirmación

1. **Adicional habilitado por el super admin**: `empresa_adicionales` (`VERIFICACION_ALIAS`), con su precio pactado.
   El precio se guarda aparte y **no entra en facturas ni débitos** hasta decidir cómo se cobra.
2. **Activada por la empresa** en Configuración → MercadoPago: interruptor propio (separado del QR) y el alias que
   ven los clientes. MercadoPago no informa el alias por la API, así que lo carga el administrador. Queda quién y
   cuándo. Exige las condiciones de uso vigentes aceptadas (versión `2026-10-06`, que suma esta función y qué se
   guarda).
3. **Conexión OAuth válida** (cuenta `ACTIVA`) y la cuenta receptora igual a la del intento.

### El cobro (`VerificacionAliasService`, `/mercadopago/alias/...`)

- **Intento** (`cobros_transferencia`): empresa, playa, estadía, operador, cuenta receptora, importe (lo que faltaba
  cobrar, congelado) y moneda. Uno abierto por estadía (índice único parcial). No registra cobro ni salida.
- **Búsqueda**: desde un minuto antes de abrir el intento, ampliable una vez a cinco. Mientras está abierto, lo que
  entró desde ese inicio sigue contando. Dura 15 minutos; después vence (antes de vencer se consulta una última vez).
- **Consulta centralizada por cuenta**: las pantallas preguntan cada 4 segundos; a MercadoPago se le pregunta como
  mucho una vez cada 4 segundos por cuenta (en memoria del proceso: con varias instancias, una por instancia). Pagina
  de a 100 hasta 500; una lista incompleta es un error, no «no hay nada».
- **Qué cuenta como transferencia recibida** (`coincidencias.ts`): cobrada por la cuenta, `approved`, en ARS, sin
  `external_reference` (los cobros generados por el sistema la llevan) y transferencia: `PSP_TRANSFER` +
  `bank_transfer` (observado) o `money_transfer` (documentado, **todavía no observado**). Tarjetas, suscripciones,
  pagos con QR, egresos, pendientes y rechazados quedan afuera.
- **Se guarda** en `transferencias_recibidas` solo lo que coincide en importe con algún intento: operación (id
  estable de MercadoPago), cuenta, importe, moneda, estado y fechas (de la operación y de cuándo la detectó el
  sistema). Sin nombre ni documento de quien pagó.

### Regla de confirmación automática

Se asocia sola si hay **exactamente una** transferencia válida sin usar por ese importe y moneda dentro del período,
**y exactamente un** intento elegible para ella en **toda la cuenta** (todas las playas y puertas). Entonces, en una
transacción: la transferencia queda `USADA`, se registra el pago (`TRANSFER`, referencia con el id de operación) y,
si no queda saldo, la salida. La pantalla muestra «Pago recibido · $X · Salida registrada». Se registra como
`AUTOMATICO_COINCIDENCIA_UNICA`: importe y hora son una heurística, no identifican al pagador.

Compiten por una transferencia, además de los intentos abiertos, los cancelados, vencidos o pagados por otro medio
hasta 30 minutos después de cerrarse: así un pago tardío no se le da al cobro siguiente del mismo importe. Un intento
confirmado no compite.

Nunca se confirma solo: un intento en revisión, una transferencia que ya estuvo en revisión, ni un intento
cancelado, vencido o ya pagado por otro medio.

### Varias coincidencias

Con dos o más transferencias candidatas, o dos o más intentos que podrían usar la misma, el intento pasa a
`REVISION` y esas transferencias también (desde ahí, solo a mano). La pantalla muestra las opciones con nombre y
banco si MercadoPago los informa (en el momento, sin guardarlos), importe, hora y los últimos dígitos de la
operación. El operador pregunta quién transfirió, elige y toca «Asignar transferencia y registrar salida» (modo
`MANUAL`). Si otra caja la usó antes: «Esta transferencia ya fue utilizada» y las opciones se actualizan.

### Lo que no se puede repetir

- `transferencias_recibidas (mpUserId, operacionId)` único, y `cobros_transferencia (mpUserId, operacionId)` único:
  una operación confirma un solo cobro, en todas las playas.
- La confirmación bloquea la fila del intento y la de la transferencia (`FOR UPDATE`): dos cajas a la vez se ordenan
  y la segunda la encuentra usada (probado con dos asignaciones simultáneas).
- Reintentos y consultas repetidas no duplican: la confirmación es la única escritura y exige el intento abierto.
- Anular la salida después no libera la transferencia: queda usada, con su rastro.

### Permisos y aislamiento

- RLS: intentos y transferencias se **leen** en toda la empresa (para decidir si una coincidencia es única entre
  playas) y el intento solo lo **crea y cambia** su playa; la transferencia es de la cuenta (empresa). El servicio
  además devuelve 404 si una playa pide el intento de otra. Probado en `tenant-isolation.integration.cjs`.
- El mostrador (`USER`) usa `VerificacionAliasController` (en `OPERATOR_ENDPOINTS` y `SUSPENDED_ENDPOINTS`, porque
  cobrar la salida de un auto que quedó adentro sigue permitido). Activarla y el alias son del administrador.
- El super admin habilita el adicional y su precio; no tiene ninguna ruta para ver movimientos de la cuenta.

### Pruebas

`coincidencias.spec.ts` (reglas, sin base) y `test/verificacion-alias.integration.cjs` (PostgreSQL real, MercadoPago
simulado): una transferencia y un cobro → una sola confirmación con cobro y salida; dos transferencias → revisión y
la otra nunca se asocia sola; una transferencia y dos autos en distintas playas → revisión y dos cajas simultáneas,
solo una la usa; tarjeta, suscripción, egreso y QR del sistema excluidos; error de MercadoPago → sigue esperando;
cancelación y pago tardío → revisión; pagada por otro medio; tarifa que subió → pago con saldo pendiente, sin
salida; reabrir recupera el mismo intento; sin adicional no se ofrece ni confirma; otra playa no toca el intento.

## 7. Limitaciones conocidas

- **Heurística.** Una coincidencia única puede ser una transferencia ajena del mismo importe hecha justo en esos
  minutos. Queda registrada como automática por coincidencia, no como identificación.
- **Sin nombre del remitente (por ahora).** En la prueba real MercadoPago no lo mandó en los campos de pago; la
  revisión puede quedar con opciones que solo se distinguen por la hora. En ese caso el operador necesita el
  comprobante del cliente.
- **`money_transfer` sin observar.** Falta probar una transferencia desde otra cuenta de MercadoPago al alias.
- **Pago tardío sin ninguna pantalla esperando.** Si nadie espera una transferencia de ese importe, el sistema no la
  ve: queda en la cuenta de MercadoPago, no en el sistema. Las que sí detecta y no se usan quedan `DISPONIBLE` o en
  `REVISION`, sin pantalla de conciliación todavía.
- **Tarifa que sube durante la espera.** El importe queda congelado; si la estadía ya cuesta más, se registra el pago
  y queda el saldo para cobrar.
- **Una instancia.** La consulta compartida por cuenta vive en memoria del proceso.
- **Facturación del adicional sin definir.** Propuesta pendiente de decisión: cobrarlo desde el primer período que
  empiece después de habilitarlo, con el descuento del período, sin prorrateo; deshabilitarlo lo corta en el acto
  y deja de cobrarse desde el período siguiente.

## 8. Cómo sacar la prueba

Cuando termine la prueba, se borran:

- **Back:** `prueba-transferencias.service.ts`, `prueba-transferencias.controller.ts`, `prueba-transferencias.spec.ts`,
  `dto/prueba-transferencias.dto.ts` y su registro en `mercadopago.module.ts`.
- **Front:** `admin/configuracion/mercadopago/prueba-transferencias.tsx`, su uso en `conexion-mercadopago.tsx`, y el
  servicio, la acción y el tipo `prueba-transferencias`.

Las condiciones de uso se quedan: son el consentimiento sobre el que se apoya la función real. Si la función no se
hace, se publica una versión que ya no mencione la consulta de pagos recibidos.
