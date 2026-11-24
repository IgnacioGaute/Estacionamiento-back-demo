# Correcciones de registros e historial de movimientos

Una operación ya registrada (una salida cobrada, un anticipo, un pase por día, semana o mes) se corrige con **Corregir registro**, nunca editando sus datos. El original queda como estaba; la corrección guarda quién la pidió, cuándo, por qué, el antes y el después, su estado y los movimientos de ajuste que generó. Código: `src/operaciones/` (`CorreccionesService`, `HistorialService`, `OperacionesController`), migración `Correcciones1790000058000`.

## Qué se puede corregir

| Tipo | Qué cambia | Plata |
| --- | --- | --- |
| `IDENTIFICACION` | La patente de una estadía ya salida. No para estadías de tarjeta. Si la patente nueva figura adentro, se rechaza (`PATENTE_ADENTRO`): es «vehículo equivocado». Una estadía adentro se corrige desde Cobrar salida → Corregir. | No cambia importe ni tarifa (no se recalcula). Los comprobantes muestran la patente nueva. |
| `MEDIO_PAGO` | El medio de un cobro (anticipo o cobro de la salida): efectivo ↔ transferencia, todo o una parte (pago mixto). | Dos `AJUSTE` vinculados (`movimientos.correccionId`): sale el medio viejo, entra el nuevo. El total cobrado no cambia; el efectivo esperado sí. |
| `RECIBIDO_VUELTO` | Lo que el cliente entregó y el vuelto declarados de un cobro en efectivo (o de un pase). | Ninguna: es lo declarado, no plata del libro. Si el vuelto real fue otro, aparece al contar la caja. |
| `VEHICULO` | La salida y el cobro se registraron sobre la estadía A, pero el que se fue era B (que sigue adentro). | El cobro pasa a B con el mismo medio y turno (A se compensa con `AJUSTE`, B recibe `SALDO` con `correccionId`); A vuelve a figurar adentro; B sale a la hora registrada. La caja no cambia. Desde ahí el cobro se corrige en B: en A figura como movido (`COBRO_MOVIDO`). |
| `OTRO` | Cualquier otro error (importe, tarifa, horario…). | Nada: siempre queda pendiente para administración. |

Importe, tarifa y horarios no se editan libremente. Un pase solo admite `RECIBIDO_VUELTO` u `OTRO`.

## Quién la aplica

El servidor decide, no el botón (`CorreccionesService.permiso`):

- **Operador**: aplica directamente las correcciones de **sus** operaciones del **turno (jornada) que tiene abierto**, si pasan las validaciones del tipo. Sin turnos activos: sus operaciones de hoy. Pases: los que cobró hoy.
- **Administración** (ADMIN, SUPER_ADMIN): aplica sobre cualquier operación de la playa y resuelve las pendientes (`PATCH /operaciones/correcciones/:id`, `APLICAR` o `RECHAZAR` con una resolución obligatoria).
- **Queda PENDIENTE** (sin efecto, ni siquiera sobre el efectivo esperado): operaciones de otro operador, de un turno ya cerrado, sin turno con turnos activos, de otro día, efectivo → transferencia sin transferencia verificada, `OTRO`, y lo que no se puede resolver solo de forma segura (bloqueos).

Bloqueos que dejan la corrección pendiente aun para administración (se resuelven a mano y se marca como rechazada con lo hecho, `CORRECCION_NO_APLICABLE`): cobros confirmados por Mercado Pago (QR o transferencia al alias detectada; una corrección no los reclasifica, cancela, devuelve ni los mueve de estadía), y en «vehículo equivocado» estadías gratuitas, de tarjeta, con ajustes o descuentos, A con otra estadía adentro, B que entró después de la salida, B con un QR o alias esperando, o un cobro que no coincide con lo que correspondía a B a esa hora (tarifa vigente de B, sin recalcular A).

## Transferencias de Mercado Pago

Pasar un efectivo a transferencia necesita evidencia: una acreditación de la cuenta de Mercado Pago de la empresa del mismo importe y dentro de la hora del cobro (`GET /operaciones/correcciones/transferencias`, `VerificacionAliasService.candidatasParaCorreccion`). Como muestra quién pagó, solo la consulta quien puede aplicar esa corrección (su operación del turno abierto, o administración) y por un importe que no supere lo que queda del cobro (`TRANSFERENCIA_LA_BUSCA_ADMINISTRACION`, `IMPORTE_MAYOR`); si va a revisión, la busca administración. No se ofrecen ni se aceptan acreditaciones en revisión para un cobro por alias ni mientras haya un cobro por alias abierto del mismo importe en la cuenta (`TRANSFERENCIA_RESERVADA`): pueden ser de ese cobro. La elegida se marca `USADA` con modo `CORRECCION` dentro de la misma transacción (`usarEnCorreccion`, fila bloqueada, índice único por operación): una acreditación no respalda dos cobros, y no alcanzan importe y hora sin la operación. Sin evidencia, el operador la deja pendiente; administración puede aprobarla y queda como «transferencia aprobada por administración», nunca como verificada.

## Garantías

- **Una transacción** con el bloqueo de caja de siempre (`pg_advisory_xact_lock(718904)`): corrección, ajustes, `cash_entries` y planilla juntos. Antes de elegir el tramo corre el corte de las 00:00 si estaba pendiente (`rolloverShifts`).
- **Idempotencia**: `solicitudId` lo genera la pantalla por resumen; un reintento devuelve la misma corrección sin aplicarla de nuevo.
- **Concurrencia**: el formulario firma la operación (`version`: salida, patente, último movimiento y cantidad de correcciones). Si cambió, `409 OPERACION_CAMBIO` y la pantalla la vuelve a cargar.
- **Append-only**: los cobros originales no se tocan; se agregan movimientos `AJUSTE` (y `SALDO` en vehículo equivocado) con `correccionId` y la nota en Avisos (`correccion:<id>`).
- **Sin conexión no se corrige**: el servidor tiene que validar permisos, evidencia y versión.

## Caja, cierre y planillas

- Con la caja de la operación **abierta**, el efecto en el efectivo va al turno abierto de esa caja (el tramo vigente de la jornada o, en una caja compartida, otro turno abierto): `cash_entries` con `categoria = 'CORRECCION'` y movimientos con ese turno. El efectivo esperado, el arqueo del cierre, el resumen del turno (`efectivoCobrado` incluye `CORRECCION`; las transferencias salen de los movimientos del turno) y el detalle de cobros en efectivo (concepto `CORRECCION`) lo reflejan.
- Con la caja **ya cerrada** (`posteriorAlCierre`): el arqueo original no cambia (contado, esperado y diferencia). Si se cerró sola a las 00:00 sin contar, quien la abre cuenta lo que hay y la diferencia de su apertura la explica la corrección (el resumen lo dice). El ajuste entra a la planilla del día en que se aplica, sin turno, y el resumen del turno cerrado informa `correcciones.posterioresAlCierre` (cantidad, efectivo, digital).
- La planilla diaria muestra los movimientos de una corrección como «Corrección - patente», con su medio.

## Historial de movimientos

`GET /operaciones` lista eventos persistidos con filtros y paginación en la consulta: fecha o rango (hasta 92 días, por defecto hoy), turno (la jornada entera, incluidos sus tramos de las 00:00), operador, patente/ticket/apellido, medio vigente, tipo (`ENTRADA`, `SALIDA`, `ANTICIPO`, `COBRO_PARCIAL`, `DEVOLUCION`, `PASE`, `CORRECCION`) y estado de corrección (`CORREGIDA`, `PENDIENTE`, `RECHAZADA`, `SIN`). La salida lleva lo cobrado al salir (un solo renglón, no dos ingresos) con los medios vigentes y lo recibido/vuelto vigentes. Cada renglón trae además `duracion` (minutos de la estadía, en salidas), `patente` y `vehiculo`. La respuesta suma `resumen`: `total`, `porTipo` (con todos los filtros menos el de tipo, para las cantidades de los filtros), `cobrado` (`total` y `porMedio`, sumando los medios vigentes de la lista) y `pendientes` (correcciones esperando revisión, sin los filtros de tipo, medio y corrección). Un operador ve solo sus operaciones en la lista. El detalle de una estadía o pase se abre dentro de la playa (como el tablero y Comprobantes, que ya muestran todas las estadías); el detalle (`GET /operaciones/estadias/:id`, `/pases/:id`) trae los cobros como se registraron, ajustes, correcciones con antes/después, permiso y `version`.

En la pantalla: «Ver movimientos», debajo de Últimos movimientos (computadora), o el acceso Movimientos (celular) abre la vista, que arranca en hoy y en «Mi turno» si hay uno abierto. Comprobantes sigue con su acceso propio.

## Pruebas

`test/correcciones.integration.cjs`: permisos (propio/ajeno/turno cerrado/administración), efectivo ↔ transferencia con y sin evidencia, acreditación ya usada, pago mixto, recibido/vuelto, vehículo equivocado, caja cerrada, doble envío, versión vieja, historial con filtros y paginación. Front: `corregir-registro.test.tsx`, `movimientos-historial.test.tsx`, `ultimo-cobro.test.tsx`, `ticket-box-rows.test.ts`.
