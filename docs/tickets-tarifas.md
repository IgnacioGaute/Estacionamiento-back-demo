# Tickets y tarifas

## Operación

La ficha física y la patente identifican una misma entidad: la estadía. El primer escaneo abre la estadía; el segundo abre el panel de cobro. Confirmar efectivo, transferencia o cortesía es lo que cierra y libera la ficha. Escanear requiere autenticación; registrar dinero requiere un usuario.

Los anticipos se cargan como **total acumulado**. Aumentarlo cobra la diferencia. Reducirlo exige medio de devolución y motivo, y agrega un ajuste negativo. Si el anticipo supera la tarifa final, el cierre exige confirmar cómo se devuelve el excedente. Una cortesía registra el importe bonificado sin sumarlo a lo cobrado ni al efectivo del turno.

El cierre bloquea la estadía y guarda salida, movimientos y caja dentro de una transacción. Un cierre repetido no vuelve a cobrar. Si el precio o lo cobrado cambió desde la vista previa, se actualiza el resumen y se debe confirmar nuevamente.

## Tarifas

Cada entrada nueva guarda una copia de las tarifas y los horarios. Editarlos después no cambia esa estadía. La configuración permite elegir horario de entrada o salida para determinar día/noche; se conserva EXIT como valor inicial compatible. La franja diurna incluye la hora inicial y excluye la final; admite horarios que cruzan medianoche.

La tarifa específica de día/noche prevalece sobre la general solamente para el mismo límite de minutos. No se permiten duplicados en el mismo vehículo, horario y duración. Se conserva la tolerancia existente y el mecanismo de escalones, limitando una combinación parcial al precio de la franja que la cubre.

En la franja recurrente, FIXED cobra el precio ingresado por cada unidad adicional. DERIVED calcula ese precio a partir de las franjas anteriores, con el precio ingresado como respaldo. Las filas existentes conservan DERIVED y las nuevas usan FIXED por defecto. El simulador administrativo consulta el cálculo del backend.

## Compatibilidad y despliegue

Cambios aditivos de esquema: `ticket_registrations.pricingSnapshot`, `entryMode`, `appliedPricingDayType`, `legacyCollectedOffset`; `ticket_price_brackets.recurringPriceMode`; `ticket_schedule_settings.pricingDayTypeBasis`. No se eliminan columnas históricas. El proyecto mantiene su configuración actual de TypeORM `synchronize: true`; no se ejecutó la aplicación contra la base del proyecto durante estas pruebas.

Las estadías anteriores sin copia de tarifas siguen usando la configuración actual y el panel lo informa. Un anticipo antiguo guardado solamente como escalar se conserva mediante un saldo inicial; no se inventan movimientos ni fechas históricas. No se recalculan turnos ya cerrados.

Actualizar backend y frontend juntos: el escaneo ahora devuelve `requiresClose` y `registrationId`, y el cierre requiere `expectedPrice` y `expectedCollected`, tomados de `close-summary`. El nuevo campo opcional `refundMetodo` confirma una devolución. Los dispositivos con token pueden abrir/consultar, pero el cobro lo confirma el operador autenticado.

Las respuestas de caja incluyen `ticketMovements` del día argentino. La planilla presenta cada anticipo, saldo y ajuste en su fecha real; las cortesías aparecen con importe cero. Conserva la presentación histórica cuando no hay movimientos ni copia de tarifas. Los datos históricos que nunca registraron cuándo se cobró un anticipo no permiten reconstruir esa fecha automáticamente.

## Verificación

Backend:

```powershell
pnpm build
pnpm exec tsc --noEmit --incremental false
pnpm exec jest --runInBand pricing.spec.ts
node --test test/tickets.integration.cjs
```

La integración crea un PostgreSQL temporal, prueba los servicios reales y lo elimina al terminar. No lee `.env`. Por defecto busca PostgreSQL 18 en Windows; `PG_TEST_BIN` permite indicar otra carpeta de binarios. Cubre doble cierre, caja concurrente, rollback, anticipos y devoluciones, cortesía, patentes duplicadas, tarifas congeladas, valores desactualizados, registros anteriores y anticipos en otra fecha.

Frontend, desde su propia carpeta:

```powershell
pnpm exec tsc --noEmit --incremental false
node --test test/ticket-box-rows.test.cjs
pnpm build
```

El build del frontend omite tipos/lint por configuración preexistente, por eso se ejecuta TypeScript por separado. No usar el e2e de ejemplo de Nest para estas comprobaciones: importa AppModule y puede conectarse a la base configurada.


## Configuración unificada de tarifas

Administración → **Tarifas** (/admin/tarifas) reemplaza las pestañas de configuración dispersas. Tiene **Por tiempo** y **Día / semana / mes**. El enlace anterior /admin/tickets redirige a su nueva ubicación; sus pestañas de tarjetas, vehículos y comprobantes redirigen a Configuración.

**Por tiempo** muestra siempre precios vigentes. Editar abre un borrador completo: método único (hora/fracción iniciada, proporcional o lista de precios), importes por vehículo, horarios, tolerancia y un único criterio de cruce de día/noche. Períodos completos se conserva como opción avanzada. Los modos guardados se mantienen; abrir y cancelar no convierte tarifas. El cambio a mismo precio todo el día exige confirmar el reemplazo de precios nocturnos en el borrador. SPLIT se conserva aunque coincidan importes porque cuenta cada tramo por separado.

Las franjas personalizadas generan su nombre desde la duración. Las existentes conservan nombre e importe si no se editan. La regla final se presenta como precio total fijo o adicional por período; DERIVED se mantiene para configuraciones anteriores. El motor de cálculo no cambia. La tolerancia afecta precios por duración y períodos iniciados, no proporcional ni completos. Reglas de permanencia continúa retirada: stay.enabled se fuerza a false para nuevas configuraciones/simulaciones; los snapshots históricos no se alteran.

El simulador muestra vigente y borrador para el mismo vehículo, entrada y duración. Incluye precios y horarios todavía sin guardar; no registra estadías ni movimientos. Cambiar campos invalida el resultado anterior. **Aplicar a los próximos ingresos** guarda la configuración entera dentro de una transacción. Una revisión evita pisar cambios de otro administrador y conserva el borrador en caso de conflicto. Las estadías con pricingSnapshot mantienen sus reglas; las antiguas sin copia siguen utilizando tarifas actuales, como antes.

API administrativa: GET /tickets/tariff-plan devuelve revision, schedule y brackets. PATCH recibe expectedRevision, schedule y brackets y devuelve el plan actualizado; un conflicto devuelve TARIFF_PLAN_CHANGED (409). POST /tickets/tariff-plan/simulate recibe vehicleType, entryAt, elapsedMinutes y opcionalmente plan (schedule/brackets); sin plan consulta vigente. No admite cambios a flags de operación ni receiptDelivery. La simulación puede evaluar el vehículo elegido sin exigir precios de otros; el guardado comprueba la cobertura de los vehículos habilitados.

**Día / semana / mes** conserva precios independientes por unidad y alta/edición/eliminación desde sus ventanas. Permanecer 24 horas por tiempo no contrata automáticamente un pase de día.

## Operación simple por defecto

Playas nuevas: Auto disponible, tickets físicos y turnos apagados y ningún precio de ejemplo activo. Primero hay que cargar tarifas; la falta de precios bloquea ingresos y no implica estacionar gratis. Configuración → Operación permite habilitar turnos/tarjetas y administrar vehículos. Configuración → Comprobantes administra WhatsApp, QR e impresión. Caja reúne ingresos/gastos, planilla e historial, accesible aunque los turnos estén apagados.

La migración SimpleOperationDefaults1790000016000 cambia solamente los DEFAULT de las dos columnas; no actualiza las elecciones de playas existentes. La configuración implícita cuando no hay fila también usa false. No se conecta a una base real para realizar pruebas.

## Migración de vehículos configurables

`FlexibleVehicleTypes1790000000000` se ejecuta antes de `synchronize`. Convierte `vehicleType` de enum a varchar(32) mediante cast conservando sus valores y nulos en las cinco tablas de tickets; crea el catálogo con Auto y Camioneta. Los tipos anteriores no se eliminan. La reversión automática se rechaza porque podría perder categorías personalizadas. Nuevas columnas JSONB: `ticket_schedule_settings.pricingOptions` y `ticket_registrations.pricingBreakdown`.

Pruebas adicionales: `pnpm exec jest --runInBand pricing` cubre el motor anterior y las opciones nuevas. La integración verifica además migración con datos existentes, simulación sin efectos y cierre de patentes/tickets de una categoría desactivada con sus reglas originales. Las pruebas de base usan exclusivamente PostgreSQL temporal.
