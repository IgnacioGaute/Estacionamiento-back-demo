# Verificación de transferencias recibidas (investigación y prueba)

Objetivo: cuando una persona transfiere al alias del comercio, que el operador pueda comprobar desde el sistema
si llegó el dinero y asociarlo al cobro correcto.

**Estado: en prueba. No es una función comercial.** Lo que existe hoy en el código es solo la prueba del super
admin (`PruebaTransferenciasService`); no toca cobros, caja ni movimientos. El cobro con QR (`CobrosMercadoPagoService`)
no cambia y no depende de esto.

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

1. La cuenta que se prueba es propia o está autorizada expresamente. Su id de vendedor va en
   `MERCADOPAGO_PRUEBA_CUENTAS` (local y Railway). Con cualquier otra cuenta, la prueba contesta 403
   `PRUEBA_NO_AUTORIZADA` sin descifrar el token.
2. La cuenta está conectada a una empresa por el flujo normal (Configuración → MercadoPago → Conectar).
3. Pantalla: ficha de la empresa (super admin) → Resumen → «Transferencias recibidas en MercadoPago». Muestra solo lo
   que entró; lo que pagó la cuenta solo se cuenta.

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

## 6. Diseño propuesto si la vía técnica funciona

Se implementa solo sobre la evidencia de la prueba. El QR queda como está.

### Contratación, activación y facturación (separadas)

- **Contratación (super admin).** Un adicional por empresa («Verificación de transferencias»), porque la cuenta de
  MercadoPago es una por empresa. El super admin lo habilita o deshabilita y le pone precio. El precio queda pactado
  (congelado) como el de los planes.
- **Activación (cliente).** En Configuración → MercadoPago, un interruptor propio, separado del QR. Solo aparece con
  el adicional habilitado y MercadoPago conectado. Al activarlo se registra quién, cuándo y la versión del texto que
  aceptó (qué se consulta, para qué y que los datos del remitente solo se usan para conciliar). Se puede pausar.
- **Condición en el backend para cada consulta:** adicional habilitado **y** cliente activado **y** conexión OAuth
  válida. Si falta algo, la consulta no se hace.
- **Facturación (para decidir antes de tocar cargos):**
  - Propuesta: el adicional se cobra desde el primer período que empiece después de habilitarlo. No se prorratea ni
    se suma a un período ya empezado o pendiente.
  - Suma al importe mensual de la empresa, así que le aplica el descuento del período (trimestral, anual). El
    descuento de playa adicional no corresponde, porque es por empresa.
  - Con débito automático, el importe nuevo se sincroniza con el mecanismo actual.
  - **Pausa del cliente:** la consulta se apaga, pero el adicional sigue contratado y se sigue cobrando. Si se
    prefiere otra regla, se decide antes de implementar.
  - **Baja (super admin):** la consulta se corta en el acto. Deja de cobrarse desde el primer período que empiece
    después de la baja, y el período ya pagado no se reintegra.

### Confirmar la recepción y asociarla al cobro son dos pasos

Un mismo importe en los últimos minutos no alcanza para dar un cobro por pagado: pueden transferir varias personas
el mismo monto, en distintas playas de la misma cuenta.

1. **Buscar candidatos** a pedido del operador, en el cobro: plata que entró a la cuenta de la empresa (`collector`
   = la cuenta), aprobada, en ARS, por el importe exacto, dentro de una ventana inicial de 5 minutos ampliable a 30
   minutos o 2 horas, y que no esté usada.
2. **Mostrar el resultado con estados explícitos:**
   - No se encontró una transferencia en el período consultado (con opción de reintentar o ampliar).
   - Transferencia recibida, pendiente de asociar (hora, importe y, si MercadoPago lo informa, el nombre del
     remitente).
   - Varias coincidencias: requiere revisión (el operador elige cuál).
   - Cobro confirmado y asociado.
   - No se pudo consultar MercadoPago. Un error, un token vencido o una consulta incompleta **nunca** se muestran
     como «no pagó».
3. **Asociar.** Una transferencia al alias no trae una referencia que la ate al cobro, así que la asociación es
   **manual explícita** del operador, registrada como tal. Una verificación automática se reserva para cuando haya
   un vínculo inequívoco.

### Evidencia mínima y duplicados

- Tabla de conciliación por playa (con `playaId`, RLS, política y triggers como las demás):
  - empresa y cuenta receptora (`mpUserId`);
  - id de la operación de MercadoPago;
  - cobro asociado (estadía o pago de inquilino);
  - importe, moneda, estado y fecha de la operación;
  - modo (manual o automático), quién lo confirmó y cuándo.
- No se guardan datos del remitente.
- **Índice único (cuenta receptora, id de operación).** Una restricción única se verifica contra todas las filas,
  aunque RLS no las muestre, así que cubre todas las playas que comparten la cuenta y dos operadores al mismo tiempo.
  El segundo recibe «esta transferencia ya se usó para otro cobro».
- El movimiento del cobro sigue siendo `TRANSFER` (método manual) con `referencia` = id de la operación, en la misma
  transacción que la fila de conciliación. `MERCADOPAGO` sigue reservado para lo que acredita el QR.
- Consultas repetidas no duplican nada: la confirmación es la única escritura y está protegida por el índice.
- Ni tokens ni respuestas completas de MercadoPago en logs o en el frontend; al operador le llegan solo los
  candidatos con los campos que necesita.

## 7. Cómo sacar la prueba

Cuando termine la prueba, se borran:

- **Back:** `prueba-transferencias.service.ts`, `prueba-transferencias.spec.ts`, `diagnostico.controller.ts`,
  `dto/prueba-transferencias.dto.ts`, su registro en `mercadopago.module.ts` y la entrada en la lista de
  `TenantInterceptor`.
- **Front:** `prueba-transferencias.tsx`, su uso en la ficha de la empresa, y el servicio, la acción y el tipo
  `prueba-transferencias`.
- **Configuración:** `MERCADOPAGO_PRUEBA_CUENTAS`.
