# Caja compartida y turnos flexibles

## Funcionamiento

Una caja física compartida con turnos sucesivos. Se permite un turno abierto a la vez. Cada turno tiene nombre y duración prevista de 1 a 168 horas: puede ser diario, de 24 horas o uno de varios relevos del día. No hay cierre automático por horario ni por medianoche. El operador responsable confirma el arqueo.

Un administrador puede cerrar el turno de otro operador cuando éste se retiró sin cerrarlo; sin esa salida la caja queda trabada, porque tampoco se puede abrir el siguiente turno. El cierre forzado exige un motivo y no autocompleta el arqueo: el administrador cuenta los billetes igual, de lo contrario la diferencia desaparecería. El turno registra `cierreForzado`, `motivoCierreForzado` y, en `usuarioCierre`, quién lo confirmó.

El efectivo esperado es `fondoInicial + suma(cash_entries.amount del turno)`. Incluye tickets por hora, abonos, recibos y otros ingresos/egresos en efectivo. Transferencias, cheques, crédito y cortesías no suman billetes. Devoluciones en efectivo restan.

Al cerrar se registran:

- Efectivo esperado y contado; la diferencia conserva la convención `esperado - contado` (positivo = faltante).
- Efectivo retirado = contado - fondo para el siguiente turno.
- Fondo pendiente de relevo, que no puede superar lo contado.
- Observaciones obligatorias si hay diferencia.

El siguiente operador confirma el fondo recibido al abrir. Se conserva la referencia al turno anterior y la recepción sólo se puede efectuar una vez. El fondo recibido forma parte del fondo inicial; nunca genera una venta ni incrementa el total diario. Se puede aportar cambio adicional declarando un fondo inicial mayor.

Ejemplo: se cuentan $90.000, se retiran $70.000 y se dejan $20.000. El primer turno queda con $20.000 pendientes de entrega. Al abrir el segundo, recibe $20.000, el primero queda en cero pendiente y el segundo empieza con esos $20.000.

## Totales e interfaz

`BoxList.totalPrice` representa efectivo neto de operaciones del día, sin transferencias ni cheques. Se conserva separado del saldo disponible del turno y de los retiros/relevos; no se borra la recaudación al cerrar. La tarjeta de la planilla se llama «Efectivo neto del día» y el PDF indica «Efectivo del día».

«Caja y turnos», accesible desde tickets y la planilla, muestra el efectivo esperado del turno activo o el fondo pendiente de relevo, el formulario de cierre y el historial con retirado, entregado y saldo pendiente. El historial del turno anterior pasa a cero pendiente cuando se recibe el relevo, conservando los importes originales del arqueo.

## Consistencia y contratos

Tabla nueva `cash_entries`: importe firmado, caja diaria, turno, descripción y fecha. Se alimenta en la misma transacción que cada cambio de efectivo. Los retiros y el traspaso quedan en el turno y no se registran como ventas.

Campos aditivos de `turnos`: `cashVersion`, `nombre`, `duracionPrevistaHoras`, `turnoAnteriorId`, `fondoRecibido`, `efectivoRetirado`, `efectivoParaSiguiente`, `recibidoPorTurnoId`, `cierreForzado`, `motivoCierreForzado`. Se mantiene el resto del esquema.

- `GET /turnos/caja`: turno activo, relevo pendiente y efectivo disponible.
- `POST /turnos/open`: fondo total, nombre, duración prevista y referencia al relevo pendiente.
- `PATCH /turnos/:id/close`: contado, esperado de la vista previa, fondo para el siguiente y observaciones.
- `GET /turnos`: historial.

Apertura, cierre y cobros comparten el bloqueo transaccional de caja. Se rechaza una apertura duplicada, un cierre por otro operador que no sea administrador, un cierre forzado sin motivo, una recepción repetida y un cierre basado en efectivo esperado desactualizado. El cierre no modifica movimientos anteriores.

## Puesta en uso y compatibilidad

Para iniciar el primer turno se cuenta el efectivo existente y se declara como fondo inicial. Después de abrir el primer turno nuevo, no se puede registrar efectivo entre un cierre y la siguiente apertura; una operación rechazada revierte también sus movimientos. Antes de adoptar el esquema se conserva la operación sin turno para compatibilidad.

Los turnos históricos conservan su cálculo anterior de movimientos de tickets (`cashVersion=1`). No se recalculan cierres ni totales diarios históricos; algunos podían incluir transferencias o cheques por el comportamiento anterior. Deben conciliarse antes de usar esos históricos como arqueo de billetes. Los turnos abiertos del modelo anterior deben cerrarse antes de iniciar la caja compartida.

Las pruebas se ejecutan en PostgreSQL temporal con `pnpm build` y `node --test test/tickets.integration.cjs`; no se aplicó este esquema a la base del proyecto ni se desplegó. Backend y frontend deben actualizarse juntos. Se mantiene `synchronize: true`, preexistente en el proyecto.
