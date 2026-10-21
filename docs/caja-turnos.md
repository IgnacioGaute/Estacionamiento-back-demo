# Turnos por operador y cajas físicas

El turno identifica quién cobra; la caja representa el cajón donde queda el efectivo. Cada usuario tiene como máximo un turno abierto por playa. Los tickets y la planilla diaria siguen compartidos por estacionamiento.

## Configuración en el frontend

En Administración → Configuración → Operación:

1. Activar «Activar turnos de caja» para exigir turno propio al operar.
2. Elegir «Permitir turnos múltiples» según cómo trabajan y guardar configuración.
3. Configurar «Sueldo retirado de caja» si corresponde, con el importe por jornada de operador. Apagado por defecto; el importe se guarda al abrir y los cambios se aplican a las nuevas jornadas.
4. En «Cajas físicas», elegir el fondo objetivo (por defecto $15.000) y nombrar una caja por cada cajón real. Caja principal siempre permanece disponible. Se pueden agregar y desactivar las otras cajas.

| Caso | Turnos múltiples | Cajas |
| --- | --- | --- |
| Una entrada, operadores por relevos | Apagado | Caja principal, un operador a la vez |
| Varias entradas con cajones separados | Activado | Una caja por cajón; cada operador elige la suya |
| Dos personas cobrando del mismo cajón | Activado | Ambos eligen la misma caja |

Una puerta no necesariamente equivale a una caja: dos puertas pueden compartir el mismo cajón. El frontend incluye estos tres ejemplos y los pasos posteriores. Para cambiar de modo o desactivar turnos deben cerrarse todos los turnos abiertos. Para desactivar una caja secundaria, debe estar cerrada sin fondo pendiente; se conserva su historial.

## Fondo y traspaso

El fondo sigue al último cierre de la caja física, independientemente del operador. Si A deja $20.000 y luego B deja $40.000 en la misma caja, cuando vuelve A recibe la referencia de $40.000. Los fondos de otras cajas no se mezclan.

La apertura muestra quién dejó la caja, el efectivo que dejó y los vehículos que quedaron dentro al cerrar. Si la ocupación cambió, también muestra la cantidad actual; no inventa datos de cierres antiguos.

El primero en abrir una caja declara el efectivo que realmente recibió y, en una opción desplegable discreta, el cambio que agrega ahora. El fondo inicial es recibido más cambio agregado. Puede declarar menos o más que el cierre anterior: una diferencia exige motivo y queda registrada sin alterar el arqueo anterior. El cambio agregado queda separado de ventas y discrepancias. Las referencias a la sesión anterior o a la sesión abierta se validan para rechazar formularios desactualizados.

Al unirse a una caja abierta, el nuevo turno tiene fondo inicial cero: el efectivo ya pertenece a la sesión compartida y no se vuelve a sumar.

## Operaciones, retiros y cierres

CashSession conserva el fondo y el arqueo físico. El saldo esperado es su fondo inicial más cash_entries.amount de todos los turnos participantes, incluidos los que ya terminaron, más aportes y retiros de cash_session_movements. Los egresos y devoluciones restan; transferencias, cheques y cortesías no suman billetes.

Cobros, ingresos, gastos y devoluciones pertenecen al turno del operador que realiza la operación. Un ingreso o gasto de «Varios» cargado por alguien sin turno abierto (el administrador desde Caja → Ingresos y gastos) va al turno abierto de la caja, porque el efectivo sale o entra de ese cajón; si hay cajas distintas abiertas se rechaza con un mensaje que pide registrarlo desde el turno de esa caja. Los retiros y aportes de fondo tienen importe, autor y motivo; afectan el efectivo físico pero no BoxList ni las ventas. Sólo administración puede registrarlos en cualquier caja abierta de la playa; los operadores no tienen acceso a esa acción.

Si quedan otros participantes abiertos, el usuario cierra sólo su turno: sin conteo ni saldo congelado de caja; si corresponde puede retirar su sueldo, dejando el movimiento registrado en la sesión. La sesión y sus operaciones continúan. El último operador debe contar el efectivo de todos los turnos de la sesión y escribir «¿Cuánto dejás en caja para el próximo turno?». El fondo objetivo es una sugerencia, no una obligación: puede dejar más, menos o cero, hasta el efectivo disponible después del sueldo. «Cambiar importe» enfoca el campo; «Usar sugerido» repone el fondo objetivo y «Dejar todo» conserva todo el disponible. El retiro de recaudación se calcula automáticamente; el sueldo aparece por separado y los gastos ya registrados no vuelven a restarse. Corregir el conteo conserva el importe elegido y exige revisarlo si ya no alcanza. El servidor vuelve a comprobar participantes y saldo dentro de una transacción; si cambiaron, exige revisar el formulario.

Antes de cerrar, el formulario repasa las estadías por hora con más de 4 horas adentro que el responsable registró desde que abrió el turno y siguen abiertas (`GET /turnos/:id/estadias-abiertas`, por el `entryOperatorName` que guarda la entrada; el filtro de 4 horas lo hace la pantalla). Cada una se marca «Sigue en la playa» o se cobra con «Se fue: cobrar»; el turno se cierra cuando están todas revisadas. Quien cierra la caja (el último, con arqueo) pide `?todas=true` y repasa todas las estadías abiertas de la playa, con quién registró cada una: las que registró otro turno y se fueron sin registrar la salida no le aparecían a nadie. Si el conteo da de más, el repaso lo señala (lo más común es un auto que pagó y se fue sin registrar la salida; cobrarlo desde ahí corrige el sobrante). Es una confirmación del frontend: el backend no exige nada nuevo para cerrar, así un frontend anterior sigue funcionando. En la pantalla de operación, un solo aviso (agrupado si cruzan varios) salta cuando autos por hora pasan las 4 horas; si nadie lo contesta, quedan «sin confirmar» en una franja violeta (distinta del naranja de «se pasó del tiempo avisado») y primero en Cobrar salida. «Sigue» se guarda en ese dispositivo por 4 horas y el repaso del cierre lo toma: tampoco es un requisito del backend. Existe porque entradas que nadie cerraba (autos que se fueron sin registrar la salida, o entradas cargadas cuando el auto se estaba yendo) quedaban abiertas para siempre sin que nadie lo notara; en Caja → Estadías abiertas el administrador las ve agrupadas por operador.

Administración puede cerrar cualquier turno de la playa, incluso de un operador dado de baja, dejando motivo al cerrar un turno ajeno. Las mismas reglas determinan si corresponde sólo cierre personal o arqueo final. Una diferencia positiva significa faltante (esperado menos contado) y requiere explicación. El arqueo final se congela tanto en la sesión como en el turno que la cerró.

En Administración → Caja → Turnos, las tarjetas agrupan los participantes por caja, suman el efectivo una sola vez y permiten cierre individual y movimientos de fondo. El historial distingue «Caja compartida» de un cierre antiguo sin conteo y muestra fondo inicial físico y discrepancias de apertura. Mi turno muestra el saldo físico de caja y el resumen de cobros, retiros y vehículos del operador.

## Corte diario y sueldo

En Configuración → Operación → Turnos → Sueldo, administración habilita el retiro y elige por separado qué usuarios lo cobran y su importe por jornada. Un usuario sin importe configurado no retira sueldo ni recibe una alerta por falta de efectivo. Los usuarios nuevos quedan sin retiro. La configuración corresponde a la playa actual y sólo admite usuarios de su empresa habilitados para operar allí.

El importe individual se copia al abrir la jornada: cambiarlo o desactivarlo afecta a jornadas nuevas, no a turnos ya abiertos ni a sus continuaciones de medianoche. `sueldosPorUsuario` guarda los pares `{ usuarioId, importe }`; una lista vacía deja a todos sin retiro. `sueldoAutomatico` conserva el interruptor general. `sueldoPorTurno` queda como dato de compatibilidad, pero ya no determina el retiro. La migración 1790000041000 conserva el importe anterior para los usuarios existentes habilitados en cada playa, sin modificar turnos ni movimientos históricos.

A las 00:00 de Argentina se cierra el tramo del día y se abre una continuación del mismo operador, caja y sesión. El corte no cuenta dinero, no retira sueldo y no vuelve a sumar el fondo. Cada tramo dura como máximo hasta la siguiente medianoche; los relevos manuales pueden durar menos. El cron recupera cortes al reiniciar y las operaciones validan el corte dentro de su transacción.

El sueldo se retira una sola vez al finalizar la jornada del operador, aunque cruce medianoche o cierre antes que otros participantes de la caja. Solo se descuenta si el efectivo permite pagar el importe completo y conservar el fondo objetivo. Si no alcanza, el descuento es cero y queda una alerta visible en el cierre y en el historial. El operador retira físicamente el dinero al confirmar.

Ejemplo: fondo $15.000 + cobros $100.000 − gastos $10.000 = $105.000 contados. Sueldo $25.000 + retiro de recaudación $65.000 + fondo al siguiente $15.000 = $105.000. Los gastos aparecen en el total retirado, pero ya salieron del saldo antes del arqueo.

## Resumen en historial y planilla

El operador sólo puede ver sus propios turnos en la planilla diaria y su PDF, tanto abiertos como cerrados e históricos. El backend filtra por el usuario autenticado y omite los movimientos sin turno en ese resumen. Administración conserva todos los turnos de la playa. El historial administrativo y su filtro de operadores siguen siendo exclusivos de administración. Los saldos físicos y el traspaso de caja conservan sus reglas compartidas.

El historial administrativo, el pie de la planilla del operador y su PDF muestran el mismo resumen compacto: efectivo cobrado, Mercado Pago con detalle de alias y QR, transferencias, total retirado con gastos/sueldo/recaudación, vehículos recibidos/salidas/vehículos que quedan y efectivo dejado al siguiente turno. Se omiten los campos repetidos de efectivo neto, ingresos varios y devoluciones, sin cambiar el cálculo del saldo físico. Lo que se devuelve en efectivo de un anticipo (sobró al cerrar o se redujo) se guarda en `cash_entries` con categoría `DEVOLUCION_ANTICIPO` y se descuenta del efectivo cobrado: es el mismo cobro que terminó siendo menor, no un retiro. Las devoluciones registradas antes de este cambio siguen como `COBRO` negativo y figuran en el total retirado. Los importes digitales son antes de comisiones; el cálculo de comisiones sigue en el resumen de la planilla. La planilla lista exclusivamente los turnos de la fecha seleccionada: primero los abiertos y luego los cerrados por fecha de cierre descendente. Los turnos históricos sin fecha operativa se ubican en el día de su apertura; no se repiten en los días siguientes. En la planilla se presentan como acordeón: el primero aparece desplegado, y abrir otro cierra el anterior. El saldo que se deja queda fuera del total retirado; se muestra junto al fondo inicial de la caja.

Las salidas se atribuyen al operador que las registra, también cuando no hay cobro. La cantidad de vehículos dentro es una fotografía de toda la playa al abrir y cerrar; no se suma entre operadores. El arqueo corresponde a toda la caja compartida y solo aparece en su cierre final. El corte automático muestra saldo esperado pendiente de verificar, nunca un arqueo o una entrega física inventada.

Los registros históricos anteriores conservan sus datos y no reciben un detalle de retiros o vehículos que antes no se guardaba. Los pagos externos confirmados tarde conservan el turno que inició el cobro. Las operaciones sin conexión conservan la fecha real y el tramo de su jornada; completan los cortes automáticos, pero no alteran un arqueo final ya contado.

## Contratos

- GET /turnos/caja: turno propio, cajas habilitadas con sesión, último cierre, saldo y participantes; openTurnos sólo para administración.
- GET /turnos/configuracion: cajas, usuarios habilitados para configurar su sueldo y existencia de turnos abiertos; exclusivo de administración.
- POST /turnos/cajas y PATCH /turnos/cajas/:id: crear y editar cajas; administración.
- POST /turnos/sesiones/:id/movimientos: aporte o retiro con saldo esperado y motivo; exclusivo de administración.
- POST /turnos/open: caja, fondo, cambio agregado y referencia a sesión anterior o sesión activa.
- PATCH /turnos/:id/close: cerrarCaja=false para participante; cerrarCaja=true y arqueo para último operador.
- GET /turnos y GET /turnos/operadores: historial y filtros de administración.

## Compatibilidad y despliegue

Las migraciones 1790000027000-turnos-por-usuario y 1790000028000-cajas-compartidas conservan cierres y operaciones previas. La segunda crea las cajas, sesiones, movimientos, aislamiento RLS por playa y la opción múltiple apagada por defecto. No convierte arqueos históricos ni suma fondos personales. Los turnos antiguos abiertos deben cerrarse antes de las primeras aperturas nuevas. Caja principal toma sólo el último cierre antiguo con fondo disponible como referencia; el operador confirma el dinero real con motivo si difiere.

cashVersion=1 conserva el cálculo histórico y los nuevos turnos usan cashVersion=2. Las operaciones offline conservan el turno propio capturado: si hubo corte automático se ubican en el tramo correspondiente; si la jornada terminó se conservan pendientes para revisión, sin reasignar el cobro a otro operador. Se conserva la compatibilidad de operaciones sin turno cuando estaban desactivados. Las operaciones de caja usan el mismo bloqueo transaccional para evitar doble apertura, fondos duplicados o pérdidas de totales.

La migración 1790000036000-turnos-diarios agrega los cortes, sueldo, fondo objetivo, atribución de salidas y el registro digital de turnos con aislamiento por playa, sin recalcular cierres anteriores.

La migración 1790000037000-completar-turnos-diarios completa las instalaciones que ya habían registrado una versión inicial del esquema diario sin salidasRegistradas o sin las referencias. Es repetible y conserva los turnos existentes.

Backend y frontend deben actualizarse juntos. Las migraciones están registradas para el arranque normal del backend. Las pruebas usan PostgreSQL temporal; no modifican la base del proyecto.


## Descuentos y responsables en la planilla

Tanto administración como el operador pueden aplicar descuentos con su propia sesión. En registrar salida, **Descuento** permite ingresar un importe o descontar todo el saldo pendiente, con motivo obligatorio. Si la estadía ya pasó del primer escalón, también ofrece **Tarifa anterior** (elegida al abrir): el resumen de cierre trae `tarifaAnterior` (el último minuto en que la estadía costaba menos, calculado con el mismo cálculo del cobro) y el descuento exacto para cobrar ese precio, con un motivo sugerido. Es para el cliente que pagó tarde (cerró la espera del alias o del QR) y pasó de escalón mientras tanto. Se aplica primero el descuento; después se confirma el cobro del resto (efectivo, transferencia, alias o QR) o la salida sin cobro. Los anticipos ya pagados se conservan: descontar todo el saldo no devuelve lo pagado.

Cada descuento se guarda como `DESCUENTO`, separado del dinero. Reduce el precio de la estadía, pero no cuenta como efectivo cobrado, gasto, devolución, comisión o retiro. No puede superar el saldo ni repetirse con el mismo presupuesto; un QR o alias pendiente debe cancelarse antes. La salida de una estadía con descuentos requiere conexión para verificar su saldo actualizado.

La planilla en pantalla muestra únicamente el total de **Descuentos del día**. El detalle del descuento, su motivo y **Registró [operador]** se muestran solo en el PDF, en texto pequeño. Cada salida en el PDF tiene su propio autor, incluso sin cobro. Se guardan también responsables de gastos, ingresos varios y pagos nuevos de recibos o abonos; los cobros de inquilinos usan el autor de su movimiento. Los registros anteriores sin un responsable conservado no reciben un nombre inventado.


## Notas publicadas automáticamente en Avisos

Las notas se guardan en Avisos dentro de la misma transacción que su operación:

- Apertura de caja con motivo; cierre de turno con nota o motivo de diferencia; cierre de otro operador con motivo del administrador.
- Motivos de retiros y aportes manuales de efectivo.
- Entrada con patente ya activa, descuentos y correcciones de cobros de vehículos.
- Comentarios de propietarios, inquilinos y clientes particulares, tanto al crear como al editar.
- Notas de cobros a inquilinos, saldos iniciales y motivos de recargos, bonificaciones, devoluciones y anulaciones.

Alias y QR publican la nota cuando se acredita el pago. Un pago pendiente o cancelado no publica un aviso. Un cobro mixto o un saldo inicial con varios meses publica una sola nota. Reintentar una operación no repite el aviso; deshacer una transacción o un savepoint también descarta su notificación.

El cierre permite una nota opcional aunque el efectivo coincida y aunque la caja siga compartida. Si hay una diferencia, la misma nota es obligatoria. Avisos muestra autor, fecha, origen y contexto. Los avisos automáticos se leen como los manuales; su texto se conserva junto a la operación y no se edita ni borra por separado. Editar el comentario de un cliente actualiza su aviso y reinicia la lectura solamente cuando cambia el texto o su contexto.

Las migraciones 1790000039000 y 1790000040000 agregan las referencias y recuperan las notas existentes sin alterar importes ni cierres. Conservan el autor y la fecha conocidos; si una nota histórica no guardaba autor, se muestra «Autor no registrado». Los sueldos automáticos y los textos técnicos de migraciones no generan avisos. Las descripciones de ingresos/gastos varios y las notas internas de suscripciones de la plataforma siguen en sus registros respectivos.


Avisos ordena primero los pendientes de lectura del usuario y luego los demás; en ambos grupos el más reciente va primero, con orden estable entre páginas. La prioridad se aplica antes de paginar, por lo que una nota histórica pendiente no queda escondida al final. Al llegar un aviso, la cartelera vuelve a la primera página; al marcarlo leído, se actualiza su posición.
