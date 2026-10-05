# Turnos por operador y cajas físicas

El turno identifica quién cobra; la caja representa el cajón donde queda el efectivo. Cada usuario tiene como máximo un turno abierto por playa. Los tickets y la planilla diaria siguen compartidos por estacionamiento.

## Configuración en el frontend

En Administración → Configuración → Operación:

1. Activar «Activar turnos de caja» para exigir turno propio al operar.
2. Elegir «Permitir turnos múltiples» según cómo trabajan y guardar configuración.
3. En «Cajas físicas», nombrar una caja por cada cajón real. Caja principal siempre permanece disponible. Se pueden agregar y desactivar las otras cajas.

| Caso | Turnos múltiples | Cajas |
| --- | --- | --- |
| Una entrada, operadores por relevos | Apagado | Caja principal, un operador a la vez |
| Varias entradas con cajones separados | Activado | Una caja por cajón; cada operador elige la suya |
| Dos personas cobrando del mismo cajón | Activado | Ambos eligen la misma caja |

Una puerta no necesariamente equivale a una caja: dos puertas pueden compartir el mismo cajón. El frontend incluye estos tres ejemplos y los pasos posteriores. Para cambiar de modo o desactivar turnos deben cerrarse todos los turnos abiertos. Para desactivar una caja secundaria, debe estar cerrada sin fondo pendiente; se conserva su historial.

## Fondo y traspaso

El fondo sigue al último cierre de la caja física, independientemente del operador. Si A deja $20.000 y luego B deja $40.000 en la misma caja, cuando vuelve A recibe la referencia de $40.000. Los fondos de otras cajas no se mezclan.

El primero en abrir una caja declara el efectivo que realmente recibió y el cambio que agrega ahora. El fondo inicial es recibido más cambio agregado. Puede declarar menos o más que el cierre anterior: una diferencia exige motivo y queda registrada sin alterar el arqueo anterior. El cambio agregado queda separado de ventas y discrepancias. Las referencias a la sesión anterior o a la sesión abierta se validan para rechazar formularios desactualizados.

Al unirse a una caja abierta, el nuevo turno tiene fondo inicial cero: el efectivo ya pertenece a la sesión compartida y no se vuelve a sumar.

## Operaciones, retiros y cierres

CashSession conserva el fondo y el arqueo físico. El saldo esperado es su fondo inicial más cash_entries.amount de todos los turnos participantes, incluidos los que ya terminaron, más aportes y retiros de cash_session_movements. Los egresos y devoluciones restan; transferencias, cheques y cortesías no suman billetes.

Cobros, ingresos, gastos y devoluciones pertenecen al turno del operador que realiza la operación. Los retiros y aportes de fondo tienen importe, autor y motivo; afectan el efectivo físico pero no BoxList ni las ventas. Un operador sólo puede registrarlos en la caja de su turno abierto; administración puede hacerlo en cualquier caja abierta de la playa.

Si quedan otros participantes abiertos, el usuario cierra sólo su turno: sin conteo, retiro ni saldo congelado de caja. La sesión y sus operaciones continúan. El último operador debe contar el efectivo de todos los turnos de la sesión, indicar cuánto retira y cuánto deja. El servidor vuelve a comprobar participantes y saldo dentro de una transacción; si cambiaron, exige revisar el formulario.

Administración puede cerrar cualquier turno de la playa, incluso de un operador dado de baja, dejando motivo al cerrar un turno ajeno. Las mismas reglas determinan si corresponde sólo cierre personal o arqueo final. Una diferencia positiva significa faltante (esperado menos contado) y requiere explicación. El arqueo final se congela tanto en la sesión como en el turno que la cerró.

En Administración → Caja → Turnos, las tarjetas agrupan los participantes por caja, suman el efectivo una sola vez y permiten cierre individual y movimientos de fondo. El historial distingue «Caja compartida» de un cierre antiguo sin conteo y muestra fondo inicial físico y discrepancias de apertura. Mi turno separa saldo físico de caja del efectivo neto de operaciones propias.

## Contratos

- GET /turnos/caja: turno propio, cajas habilitadas con sesión, último cierre, saldo y participantes; openTurnos sólo para administración.
- GET /turnos/configuracion: cajas y existencia de turnos abiertos; exclusivo de administración.
- POST /turnos/cajas y PATCH /turnos/cajas/:id: crear y editar cajas; administración.
- POST /turnos/sesiones/:id/movimientos: aporte o retiro con saldo esperado y motivo.
- POST /turnos/open: caja, fondo, cambio agregado y referencia a sesión anterior o sesión activa.
- PATCH /turnos/:id/close: cerrarCaja=false para participante; cerrarCaja=true y arqueo para último operador.
- GET /turnos y GET /turnos/operadores: historial y filtros de administración.

## Compatibilidad y despliegue

Las migraciones 1790000027000-turnos-por-usuario y 1790000028000-cajas-compartidas conservan cierres y operaciones previas. La segunda crea las cajas, sesiones, movimientos, aislamiento RLS por playa y la opción múltiple apagada por defecto. No convierte arqueos históricos ni suma fondos personales. Los turnos antiguos abiertos deben cerrarse antes de las primeras aperturas nuevas. Caja principal toma sólo el último cierre antiguo con fondo disponible como referencia; el operador confirma el dinero real con motivo si difiere.

cashVersion=1 conserva el cálculo histórico y los nuevos turnos usan cashVersion=2. Las operaciones offline conservan el turno propio capturado: si ya cerró, no se reasignan a otro. Se conserva la compatibilidad de operaciones sin turno cuando estaban desactivados. Las operaciones de caja usan el mismo bloqueo transaccional para evitar doble apertura, fondos duplicados o pérdidas de totales.

Backend y frontend deben actualizarse juntos. Las migraciones están registradas para el arranque normal del backend. Las pruebas usan PostgreSQL temporal; no modifican la base del proyecto.
