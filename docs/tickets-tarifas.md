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


## Opciones de cobro y uso sin capacitación presencial

En **Administración → Tickets → Cómo cobrar** se muestran dos opciones apagables: **Forma de cobro** y **Cruces de horario**. Sus detalles empiezan plegados y se pueden abrir cuando se necesitan. La configuración inicial conserva los precios por duración existentes.

- **Forma de cobro:** períodos iniciados, períodos completos o proporción por minutos. Se carga la duración del período y su precio de día/noche por vehículo. Activarla reemplaza los precios por duración para nuevos ingresos; apagada conserva esa lista.
- **Cruces de horario:** usar el precio de entrada, el de salida o separar las partes diurna/nocturna. Cada parte cuenta sus propios períodos; en proporcional se cobra el tiempo de cada parte.

La tolerancia general afecta los períodos iniciados y los precios por duración; no reduce el primer período iniciado ni se aplica al proporcional/completos.

**Reglas de permanencia** se retiró temporalmente de la configuración. El backend fuerza `stay.enabled = false` en las configuraciones y simulaciones actuales, aunque exista un valor anterior guardado. Nuevas entradas no usan minutos gratis, mínimos ni topes ocultos. Las estadías ya abiertas conservan su `pricingSnapshot` y se cierran con sus reglas originales. El motor histórico permanece para poder calcular esas estadías sin cambiar sus importes.

**Probá cuánto cobrarías** usa las opciones que se están editando, incluso sin guardar, y explica cada importe. La zona de prueba queda separada visualmente de Guardar; pide hora de entrada en formato de 24 horas y duración. Toma la fecha actual de Buenos Aires, calcula automáticamente salidas después de medianoche o de varios días y no solicita un día porque estas tarifas no cambian por día de la semana. No registra entradas, movimientos ni cobros. Cambiar un dato borra el resultado anterior. Guardar afecta únicamente los próximos ingresos; la copia de reglas de cada estadía conserva todos los precios y opciones.

En **Tipos de vehículo** se agregan nombres como Moto o Utilitario. El código queda fijo; el nombre se puede cambiar y el tipo se puede desactivar. Antes del primer ingreso se deben cargar sus precios. Desactivarlo impide nuevas entradas pero permite cerrar las existentes, tanto por patente como por ticket físico.

Para el operador, **Registrar salida y cobrar** muestra identificación, tiempo, total, adelantos y **Falta cobrar ahora**. Primero elige Efectivo o Transferencia; luego confirma el importe y la salida. **¿Cómo se calculó este importe?** despliega el detalle si lo necesita. Los anticipos con reglas avanzadas no sugieren un precio antiguo de la lista por duración. Consultar precios usa el simulador cuando hay reglas adicionales.

## Migración de vehículos configurables

`FlexibleVehicleTypes1790000000000` se ejecuta antes de `synchronize`. Convierte `vehicleType` de enum a varchar(32) mediante cast conservando sus valores y nulos en las cinco tablas de tickets; crea el catálogo con Auto y Camioneta. Los tipos anteriores no se eliminan. La reversión automática se rechaza porque podría perder categorías personalizadas. Nuevas columnas JSONB: `ticket_schedule_settings.pricingOptions` y `ticket_registrations.pricingBreakdown`.

Pruebas adicionales: `pnpm exec jest --runInBand pricing` cubre el motor anterior y las opciones nuevas. La integración verifica además migración con datos existentes, simulación sin efectos y cierre de patentes/tickets de una categoría desactivada con sus reglas originales. Las pruebas de base usan exclusivamente PostgreSQL temporal.
