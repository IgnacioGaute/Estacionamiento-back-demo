# Planes y cuentas de las empresas con la plataforma

Lo que la plataforma le cobra a cada empresa por usar el sistema (`src/saas/`). No es lo que una
playa le cobra a sus clientes: eso es `receipts`, `cuentas` y `movimientos`.

## El ciclo

```
Alta ──(días de prueba, opcionales)──▶ Fin de la prueba ──▶ Factura del primer mes (vence ese día)
     ──▶ días de atraso ──(más de 5)──▶ Suspendida ──(60 días)──▶ Baja
Cada pago corre el vencimiento: la factura del mes siguiente se emite el día en que vence.
```

- **Alta**: desde qué día es cliente (`suscripciones.alta`, editable). Mientras no pagó nunca, la
  prueba se cuenta desde el alta: cambiar el alta corre la prueba conservando sus días. Con pagos,
  el alta es solo un dato.
- **Prueba**: opcional y sin necesidad de plan. Se da al crear la empresa (casilla «Darle prueba
  gratis», `diasPrueba` en `POST /tenancy/empresas`) o con «Dar de alta» en la solapa Plan
  (`POST /tenancy/empresas/:id/suscripcion/alta` con `{ alta, diasPrueba }`). El alta cuenta como
  primer día: 7 días desde el 1 terminan el 7 y el primer mes se factura el 8. Con 0 días, la
  primera factura vence el mismo día del alta. Sin alta, la cuenta queda `SIN_ACTIVAR` y no vence.
- **Factura**: se emite el día en que empieza el período (al terminar la prueba o lo pagado) y
  vence ese mismo día. Mientras no se pague sigue al plan; su fecha no se corre aunque la cuenta
  se suspenda (dice desde cuándo debe).
- **Atraso y suspensión**: desde el vencimiento se cuentan los días de atraso. Con 5 sigue
  operando; con el sexto la tarea diaria la suspende (`FALTA_DE_PAGO`).
- **Días extra** (`POST …/dias-extra` con `{ hasta, motivo }`): una sola acción. Si nunca pagó,
  alarga la prueba (y corre la primera factura); si ya paga, es una prórroga: corre la suspensión
  sin mover el vencimiento, y el atraso se sigue contando.
- **Pago**: si venía usando el sistema (al día, prueba o atrasada sin cortar) el período sigue
  desde su vencimiento, aunque pague tarde; si estaba cortada por falta de pago, arranca el día
  del pago. A fin de mes el aniversario se mantiene a fin de mes. Un pago, días extra o un cambio
  de alta reactivan solos una suspensión por `FALTA_DE_PAGO`; una `MANUAL` la levanta únicamente el
  super admin. Anular: solo el último pago; devuelve `pagadoHastaAnterior` exacto.

## Modelo

- `planes`: la lista de precios, igual que la landing: Playa chica (hasta 50 vehículos a la vez),
  mediana (51 a 120) y grande (más de 120), cada una «solo tickets / rotación» o «+ alquileres
  mensuales» (`incluyeCocheras`). Precios en pesos enteros; `activo` retira un plan sin tocar a
  quien lo tiene. Se agrupan por tamaño por el `codigo` (`MEDIANA` / `MEDIANA_COCHERAS`).
- `suscripcion_playas`: el plan de cada playa con su **precio pactado**. Cambiar la lista no lo
  toca. La primera playa con plan paga la lista; cada playa adicional, 30% menos (lo promete la
  landing). La empresa paga la suma.
- `suscripciones`: una fila por empresa con fechas y nada más: `alta`, `pruebaHasta`,
  `pagadoHasta`, `prorrogaHasta` (días extra), `bonificada`, `motivoSuspension`, `suspendidaEl`,
  `notas` (internas).
- `facturas_saas`: un período cobrado. `PENDIENTE` → `PAGADA`; un pago cargado por error o una
  factura recalculada se `ANULADA`, nunca se borra. Una sola pendiente por empresa. No es fiscal.

## Estado de la cuenta

No se guarda: `estado-cuenta.ts` lo deduce de las fechas y lo usan igual el panel, la tarea diaria
y los pagos. `SIN_ACTIVAR`, `PRUEBA`, `AL_DIA`, `VENCIDA` (con `diasDeAtraso`; 0 = vence hoy),
`BONIFICADA`, y `SUSPENDIDA` / `BAJA` (las dice `empresas.estado`, que sigue siendo el único
interruptor de acceso). `proximoVencimiento` es el día de la próxima factura.

## Tarea diaria

`SuscripcionesScheduler` (05:00 Argentina; también «Revisar vencimientos» en `/admin/planes`).
Sin `tenantContext`, con lock asesor e idempotente: primero asienta lo pagado por MercadoPago,
después emite o corrige la factura pendiente de cada cuenta, suspende lo que pasó la gracia y da
de baja lo que lleva 60 días suspendido por falta de pago.

## Empresa suspendida

No es un bloqueo total. JwtStrategy y el login aceptan `SUSPENDIDA` (no `BAJA`) y `TenantGuard`
deja pasar solo `SUSPENDED_ENDPOINTS` (`src/tenancy/endpoint-policy.ts`): contexto, Mi plan,
buscar y cobrar salidas, comprobantes, QR de MercadoPago, turnos y ver la caja. El escáner sigue
para el segundo escaneo; el primero (entrada) lo rechaza `TicketsService.createRegistration`. Todo
lo demás responde `403 { code: 'EMPRESA_SUSPENDIDA' }`. El modo sin conexión queda afuera a
propósito: su sincronización podría colar entradas.

## Límite de activos

Blando: nunca frena una entrada. Solo el super admin ve en la ficha los vehículos adentro, el pico
diario de los últimos 30 días y los días que pasó el límite. La empresa no ve su uso.

## Alquileres mensuales

El plan define `playas.modulos.inquilinos`: con alquileres la prende, sin ellos la apaga (los
datos quedan). Con plan asignado, el interruptor manual responde `MODULO_DEFINIDO_POR_PLAN`.

## Pantallas

- Super admin: `/admin/planes` (ingreso mensual, por cobrar, cobrado por mes, cuentas por estado,
  cuentas ordenadas por urgencia, lista de precios editable, pagos), columna «Plan» y filtro
  «Cobro» en `/admin/empresas`, solapa «Plan» en la ficha (estado, ciclo con hoy marcado, tarjetas
  de plan por playa, uso, ajustes, facturas con días de atraso, historial).
- Administrador: `/admin/plan` («Mi plan»), con las tarjetas de la landing y su plan resaltado.
  Datos de transferencia y WhatsApp desde `PLATAFORMA_DATOS_PAGO` y `PLATAFORMA_WHATSAPP`.
- Administrador: `/admin/plan/pagar`, a donde lleva el aviso: importe, qué cubre, vencimiento o
  atraso y las formas de pago: MercadoPago y débito automático (con MercadoPago configurado no se
  ofrece transferencia; sin él, transferencia con `PLATAFORMA_DATOS_PAGO`). Con el débito
  activo, la franja no recuerda vencimientos: solo avisa si MercadoPago no pudo cobrar.
- Todos: una franja fina bajo la barra superior, en todas las pantallas, cuando la prueba o el mes
  vencen en 3 días o menos (se puede cerrar por la sesión), cuando terminó la prueba, cuando el
  pago tiene atraso y cuando está suspendida (no se pueden cerrar). Al administrador la franja
  entera lo lleva a pagar; el operador solo ve el aviso. Sale de `cuenta` en `GET /tenant/context`,
  que incluye `aPagar` (la factura pendiente o lo que paga por mes).

## Aislamiento

Las tablas de cuenta tienen RLS forzada por `empresaId`; `parking_scoped` solo tiene `SELECT` (y
`planes`, catálogo sin RLS, también solo lectura). Ninguna ruta de la empresa puede cambiar su plan
ni su vencimiento. Las mutaciones corren con el rol dueño desde `SuscripcionesController` (super
admin, sin token estático, fuera del `TenantInterceptor`) o la tarea diaria.

## Cobro con MercadoPago de la plataforma

Una aplicación de MercadoPago propia de la plataforma (`MERCADOPAGO_PLATAFORMA_ACCESS_TOKEN`), separada
de las cuentas OAuth con que cada empresa cobra sus QR: `src/saas/mercadopago-plataforma.ts` no usa
esas credenciales ni al revés. Sin el token, Mi plan ofrece solo transferencia (`mercadoPago: false`).

- **Pago con MercadoPago.** `POST /mi-plan/pagar` arma una preferencia de Checkout Pro por lo que
  debe (la factura pendiente) o, si está al día, por el mes que viene. `external_reference` =
  `plan:<empresaId>:<desde>`; el link vence a los 3 días.
- **Débito automático.** `POST /mi-plan/debito { email, tarjeta? }` crea una suscripción de
  MercadoPago (`preapproval` sin plan asociado). Con `MERCADOPAGO_PLATAFORMA_PUBLIC_KEY`, el panel
  muestra el formulario de tarjeta de MercadoPago (Card Payment Brick, sus campos en sus marcos) y
  manda solo el token de un solo uso: la suscripción se crea `authorized` con `card_token_id` y
  queda activa en el acto, sin cuenta de MercadoPago (MercadoPago valida la tarjeta con un cobro
  mínimo que devuelve). Sin la clave pública queda `pending` y el cliente la confirma en
  MercadoPago con su cuenta. Acá nunca pasan datos de tarjeta. El primer cobro es el próximo
  vencimiento a las 9 de Argentina y después uno por mes. Solo se activa sin deuda (`PAGO_PENDIENTE` si no): lo
  vencido se paga aparte. Uno pendiente o pausado se cancela al pedir otro. `DELETE /mi-plan/debito`
  lo cancela. Si cambia el plan, `sincronizarImporte` actualiza el monto en MercadoPago.
- **Gracia.** Con el débito confirmado (`debitoEstado = 'authorized'`) son 10 días en vez de 5
  (`DIAS_DE_GRACIA_DEBITO`): MercadoPago reintenta la tarjeta varios días.
- **Cómo se asienta.** Por tres caminos que pueden llegar juntos: el aviso de MercadoPago
  (`POST /mercadopago/plataforma/aviso`), la verificación cuando el cliente vuelve de pagar
  (`POST /mi-plan/verificar`, la pantalla vuelve con `?mp=pago|debito`) y la revisión cada dos
  horas (y a las 05:00, antes de suspender). Ninguno le cree al aviso: se consulta a la API con el
  token propio. `acreditarPagoMercadoPago` asienta lo que MercadoPago dice que entró, como un pago
  de un mes con `medio = MERCADOPAGO` y `referencia` = id del pago, una sola vez por id (lock de la
  cuenta + índice único `facturas_saas_pago_mercadopago`, que incluye las anuladas).
- **El aviso.** Es la única ruta de escritura sin sesión: `TenantGuard` la deja pasar y el
  `TenantInterceptor` no le busca empresa. Con `MERCADOPAGO_PLATAFORMA_WEBHOOK_SECRET` valida la
  firma `x-signature` (HMAC-SHA256 de `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`) y responde
  401 si no coincide. Siempre responde 200 si el error es nuestro: la revisión periódica reintenta.
- **Suspendida.** `pagarConMercadoPago`, `verificarPagos` y `desactivarDebito` están en
  `SUSPENDED_ENDPOINTS`; activar el débito no (con deuda no se puede).
- Las escrituras que pide la empresa corren con `tenantContext.exit` (rol dueño) y siempre sobre la
  empresa de la sesión.

Variables: `MERCADOPAGO_PLATAFORMA_ACCESS_TOKEN` (obligatoria para ofrecer MercadoPago),
`MERCADOPAGO_PLATAFORMA_PUBLIC_KEY` (la «Public Key» de la misma aplicación; habilita cargar la
tarjeta en el panel, viaja al navegador en `GET /mi-plan` porque es pública por diseño),
`MERCADOPAGO_PLATAFORMA_WEBHOOK_SECRET` (la «clave secreta» de Webhooks de la aplicación),
`MERCADOPAGO_PLATAFORMA_WEBHOOK_URL` (opcional, https: se manda como `notification_url` en cada
link) y `PLATAFORMA_URL_FRONT` (a dónde vuelve el cliente; si falta, el origen de
`MERCADOPAGO_REDIRECT_URI` o el primero de `ALLOWED_ORIGINS`). En la aplicación de MercadoPago, el
webhook va a `https://<backend>/mercadopago/plataforma/aviso` con los eventos «Pagos» y «Planes y
suscripciones».

Pruebas: `node --test test/suscripciones.integration.cjs` (incluye MercadoPago en memoria: pago
con link, débito, avisos repetidos, firma y pedidos a la API con `fetch` simulado), el caso de
empresa suspendida y el aviso sin sesión en `test/tenant-isolation.integration.cjs` y el alta
opcional en `test/tenancy.integration.cjs`.
