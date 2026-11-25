# Panel de la administración

`GET /operaciones/panel?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&comparar=anterior|anio|no` (solo administración: no está en `OPERATOR_ENDPOINTS` ni en `SUSPENDED_ENDPOINTS`). Sin fechas, va de comienzo de mes a hoy; sin `comparar`, compara con el período anterior. El rango admite hasta un año (366 días). Solo lee.

## Qué devuelve

- `rango` y `comparacion`: el período pedido y el comparado. «anterior» son los mismos días justo antes (24 días → los 24 anteriores); «anio», las mismas fechas un año antes; «no», sin comparación (`comparacion`, `cobrado.anterior` y `estadias.anterior` en `null`).
- `cobrado`: `total`, `porMedio` (`CASH`, `TRANSFER`, `MERCADOPAGO`), `porDia` (todos los días del rango, con cero si no hubo cobros) y, si el rango es de un solo día, `porHora` (24 valores). `anterior` trae lo mismo del período comparado. Sale de la misma unión que el historial de movimientos (`ramasHistorial` en `historial.service.ts`): estadías por hora y por día, semana o mes, con los medios vigentes (las correcciones aplicadas). Por eso lo cobrado del panel coincide con el resumen de Movimientos para las mismas fechas. No incluye pagos de inquilinos ni Varios.
- `estadias`: entradas (estadías por hora y altas de pases), salidas (y retiros de pases), `ticketPromedio` (lo cobrado al salir sobre las salidas cobradas) y `duracionPromedio` en minutos (de las salidas por hora), en total, por día y del período comparado.
- `hoy`: los autos adentro al final de cada hora de hoy (la hora en curso, ahora), con el mismo criterio que la caja (`occupancyAt`): estadías sin salir y pases sin retirar. No usa la capacidad de la playa, que puede no estar cargada.
- `calendario`: lo cobrado cada día de las últimas 20 semanas, de lunes a hoy.
- `avisos`: correcciones esperando revisión y los cierres de caja de los últimos 7 días donde faltó efectivo (sin los cierres automáticos de las 00:00). Los inquilinos con deuda vencida los trae el front de `GET /cuentas/deudores`.

Cada consulta se hace por separado (no en paralelo): cada una toma su conexión con el alcance de la playa (`tenant-context.ts`).

## Pantalla

Administración → Panel. Arriba, los filtros en una fila: atajos de período (Hoy, Ayer, 7 días, 30 días, Este mes, Mes anterior, Este año) o «Elegir fechas» (un rango en el calendario, hasta hoy y de hasta un año), «Comparar con» (período anterior, mismo período del año anterior o no comparar, cada opción con sus fechas) y «Ver por» (hora para un día; día hasta tres meses; semana desde dos semanas; mes desde dos meses). Todo viaja en la dirección (`desde`, `hasta`, `comparar`, `ver`). Debajo, «cosas para mirar» con enlaces a Caja, Entradas y salidas y Avisos → Inquilinos.

Los gráficos: lo cobrado (las dos líneas entran con un cometa en un canvas, portado del efecto comet de Particle Line de bklit, y al terminar quedan en SVG; la gris es el período comparado; al pasar el mouse, una columna, el tramo cercano resaltado, la tarjeta con lo cobrado y lo de antes, y la fecha en una pastilla), los autos adentro hoy (reloj de 24 horas), tres indicadores con minigráfico (autos que entraron, ticket promedio y estadía promedio, con su variación), el calendario de 20 semanas (de lunes a domingo, con el fin de semana atenuado, la ola de entrada por columnas del heatmap de bklit; tocar un día lo elige como período) y cómo pagaron (anillo con tramas). En una playa gratuita el panel sigue mostrando solo la actividad por hora, sin importes.

## Verificación

Backend: `pnpm build` y `node --test test/correcciones.integration.cjs` (el caso «panel: …» compara lo cobrado con el historial, el período comparado, los autos adentro con `occupancyAt` y el calendario). Front: `pnpm exec jest admin/dashboard/panel`.
