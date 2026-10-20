# Modalidad de operación: Con cobro / Gratuito

Cada playa opera **Con cobro** (el funcionamiento de siempre) o **Gratuito**: registro y control de
vehículos sin tarifas ni operaciones de dinero. La define solo el super admin, por playa, y no
depende del plan ni de la suscripción: una playa gratuita para sus visitantes igual paga el sistema.
Las playas existentes quedan Con cobro.

## Dónde se configura

Plataforma → Empresas → ficha de la empresa → pestaña Playas → columna **Modalidad**. El botón abre
un diálogo que explica qué se deja de usar y qué se mantiene, consulta los pendientes y, si no hay
bloqueos, confirma el cambio. Queda en la Actividad como `PLAYA_MODALIDAD` y las pantallas abiertas
de la playa recargan solas (evento de socket `playa-modalidad`).

- `GET /tenancy/playas/:id/modalidad` → `{ modalidad, destino, bloqueos[], avisos[] }`.
- `PATCH /tenancy/playas/:id/modalidad` `{ modalidad: 'CON_COBRO' | 'GRATUITO' }` → `{ modalidad, avisos }`
  o `409 { code: 'MODALIDAD_CON_PENDIENTES', message, bloqueos }`.

Ambas rutas están en `TenancyController` (`SuperAdminGuard`, sin token estático). `PATCH /tenancy/playas/:id`
no acepta `modalidad`, y el rol operativo `parking_scoped` solo lee `playas`: ninguna conexión de
empresa puede cambiarla.

## Qué hace cada modalidad

En una playa gratuita se mantienen: ingreso por patente y por tarjeta física, tipos de vehículo,
validación de patentes repetidas, vehículos adentro, búsquedas, historial, fecha y hora de entrada y
salida, permanencia, operador responsable, correcciones de patente/tipo/entrada y eliminación por
error. Se desactivan tarifas y simuladores, cobros, anticipos, medios de pago, descuentos, cortesías,
devoluciones, «Se fue antes», caja, planilla de caja, turnos y cajas, ingresos y gastos, comisiones,
Día/Sem/Mes, Inquilinos y clientes mensuales, cobros QR y por alias, la configuración de MercadoPago,
los comprobantes de entrada y salida (y su configuración) y el modo sin conexión. La facturación SaaS
(Mi plan) no cambia.

La salida gratuita (`PATCH /tickets/registrations/:id/salida`, `registrarSalida`) muestra el vehículo y su
permanencia y registra la salida sin importes, medio de pago ni caja. No calcula tarifa ni crea
movimientos, cortesías, `cash_entries` ni `box_lists`; libera la tarjeta física; no exige turno (si el
operador tiene uno abierto, la salida se le atribuye). Reintentar devuelve la misma salida sin repetir
nada. `GET …/close-summary` devuelve `{ registration, modalidad: 'GRATUITO', elapsedMinutes }` para estas
estadías y el resumen de cobro con `modalidad: 'CON_COBRO'` para las demás.

## Cómo se aplica (`src/tenancy/modalidad.ts`)

- `playas.modalidad` y `ticket_registrations.modalidad` (migración `1790000042000`, default `CON_COBRO`,
  CHECK). Cada estadía guarda la modalidad con la que ingresó y sale con esa: un cambio de
  configuración no reinterpreta lo que ya está adentro. Las filas anteriores quedan Con cobro, con
  sus snapshots y movimientos intactos.
- `GET /tenant/context` incluye la modalidad de cada playa; `TenantScope.modalidad` la lleva a cada pedido.
- `FREE_MODE_BLOCKED` (`endpoint-policy.ts`, por clase y handler): el `TenantInterceptor` responde
  `403 MODALIDAD_GRATUITA` a esas escrituras y simuladores en una playa gratuita, para cualquier rol.
  Las lecturas siguen abiertas: el administrador conserva el historial financiero previo.
- Dentro de la transacción: `exigirCobro` (bloqueo de caja 718904 exclusivo + lectura de la playa) en
  `BoxListsService.applyTicketPayment`, `updateBox`, `removeOtherPayment`, `MovimientosService.create`,
  apertura de turnos, cajas y movimientos de fondo, y en la creación de cobros QR y por alias.
  `modalidadParaIngreso` (718903 compartido) decide con qué nace un ingreso: gratuito no captura
  tarifas, así que entra sin tarifas configuradas.
- Por estadía: `priceRegistration` y `plannedPriceForRegistration` rechazan las gratuitas con
  `ESTADIA_GRATUITA` (cubre cierre con cobro, descuentos, pago parcial, anticipos, QR, alias y «Se fue
  antes»); la salida gratuita rechaza las con cobro con `ESTADIA_CON_COBRO`.
- `updateSchedule` en una playa gratuita solo acepta `barcodeTicketsEnabled`; `getSchedule` devuelve la
  entrega de comprobantes apagada (lo guardado se conserva para cuando vuelva a cobrar).

## Transiciones

`TenancyService.cambiarModalidad` toma exclusivos 718903 y 718904 (el mismo orden que configuración y
contingencia) y bloquea la fila de la playa. Los ingresos y toda operación de dinero leen la modalidad
con esos mismos bloqueos: terminan antes del cambio (y el cambio los ve) o empiezan después (y ven la
modalidad nueva). Así no se cuela un turno, un cobro o un ingreso con cobro después de verificar.

**Pasar a Gratuito se bloquea** mientras haya algo que después no podría cerrarse ni acreditarse:
turnos abiertos, cajas físicas abiertas, estadías por hora con cobro adentro, Día/Sem/Mes sin retirar,
cobros QR `PENDIENTE` o transferencias al alias `ESPERANDO`/`REVISION`. Cada bloqueo trae cantidad y la
acción que lo resuelve; el sistema no cierra turnos, no borra historia ni crea ajustes.

**Avisos que no bloquean**: saldos de inquilinos y recibos de clientes pendientes (quedan registrados,
consultables, y se pueden cobrar volviendo a Con cobro) y equipos con contingencia preparada.

**Volver a Con cobro** no tiene bloqueos. Avisa las estadías gratuitas que siguen adentro (salen sin
cargo, con Registrar salida) y los tipos de vehículo sin tarifas (sus ingresos se rechazan hasta
cargarlas). Turnos, sueldos y tarifas guardados vuelven tal como estaban.

## Offline, comprobantes y asistente

- `POST /tickets/offline/prepare` en una playa gratuita responde `409 OFFLINE_NO_DISPONIBLE_GRATUITO` y el
  frontend no la prepara. El snapshot lleva `modalidad`. Si la playa pasó a gratuita durante una
  contingencia, sincronizar responde `409 MODALIDAD_CAMBIADA` y la operación queda pendiente para
  revisión (mismo criterio que un cambio de turnos). Una estadía gratuita no se cobra offline.
  Límite conocido: el servidor no sabe qué tiene un equipo sin sincronizar, y las contingencias se
  renuevan solas mientras la pantalla está abierta, así que no bloquean el cambio (sería imposible
  cambiar). El diálogo avisa cuántos equipos tienen una preparada; si alguno registró un cobro sin
  conexión y sincroniza después, la playa tiene que volver un momento a Con cobro para registrarlo.
- Una playa gratuita no emite comprobantes: `issueParkingReceipt` y el recibo de pagos de inquilinos
  (`emitirComprobante`) están en `FREE_MODE_BLOCKED`, y el frontend no ofrece la entrega. Si una estadía
  entró gratis y sale cuando la playa ya volvió a cobrar, su constancia lleva `modalidad: 'GRATUITO'` y
  `total`/`collected` en `null`; comprobantes y el frontend no dibujan el bloque de importes ni la
  leyenda fiscal.
- El asistente recibe la modalidad; en una playa gratuita no ofrece caja, importes ni cierres de turno.

## Planilla de vehículos

`GET /tickets/registrations/planilla?desde&hasta&estado=TODAS|ENTRADAS|SALIDAS|PRESENTES&operador&tipo&q&page&limit`
(operador y administrador, `/vehiculos` en el frontend): entradas, salidas y vehículos adentro con
permanencia (hasta ahora para los que siguen adentro) y operador de cada movimiento, sin importes,
con exportación a Excel. Sirve en ambas modalidades.

## Pruebas

- `src/tenancy/modalidad.spec.ts`, `src/tickets/salida-gratuita.spec.ts`, `endpoint-policy.spec.ts`.
- `test/modalidad.integration.cjs` (PostgreSQL temporal, RLS, guard e interceptor): ingresos gratuitos
  por patente y tarjeta sin tarifas, salida sin caja ni movimientos, reintentos y salidas simultáneas,
  liberación de tarjeta, permisos del cambio, aislamiento entre empresas y playas, endpoints
  financieros bloqueados, transiciones con pendientes, historia intacta, estadía gratuita después de
  volver a cobrar, carrera ingreso/cambio, contingencia y planilla.
