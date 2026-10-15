# Referencia técnica: tarifas

### Pricing brackets

Hourly pricing lives in `src/tickets/pricing/pricing.ts`. `TicketPriceBracket` is scoped by vehicle and optional
`DAY`/`NIGHT`. A specific bracket overrides a general one only at the same duration; duplicates in the same scope
are rejected. Cascading cannot exceed the covering bracket. `uptoMinutes: null` is the open-ended bracket; with
`recurringUnitMinutes`, `recurringPriceMode: FIXED` uses its entered price per unit while `DERIVED` preserves the
legacy proportional calculation. Existing database rows default to DERIVED; new API rows default to FIXED.
`GET /tickets/priceBrackets/preview` uses this same calculator.

Each new stay freezes brackets and schedule in `pricingSnapshot`. `pricingDayTypeBasis` chooses ENTRY or EXIT
(existing configuration defaults to EXIT). Later changes only affect new stays, unless the admin ticks «Aplicar también a
los N vehículos que están adentro» when applying (`aplicarAActivos`): `TicketsService.repriceActiveStays` then rewrites
the snapshot of every active stay in the same transaction (whole stay from entry, `capturedAt` kept; a stay the new
plan does not cover keeps its own). Old active rows without snapshots
use current settings and are explicitly marked in close summaries. Missing applicable tariffs block entry. The
established grace rule is retained: tolerance before moving up a bracket, except the final finite fallback.
Shared/exclusive PostgreSQL transaction locks keep snapshot capture and tariff updates consistent. Entity enums
live in `ticket.constants.ts` to avoid TypeORM initialization cycles.

Vehicle types are configurable rows (`VehicleTypeEntity`, table `ticket_vehicle_types`, unique per
`playaId` + `code`), not a closed AUTO/CAMIONETA union; a new playa is seeded with Auto and Camioneta. Disabling a
type blocks new entries, never existing exits.

### Tarifas configurables y claridad de uso

- Forma de cobro y Cruces de horario son optativas y viven en `pricingOptions`; Reglas de permanencia está
  temporalmente retirada: el backend fuerza `stay.enabled = false` para nuevas entradas, configuraciones y
  simulaciones, conservando los snapshots históricos; las estadías conservan una copia al ingresar. Motor
  compartido `stay-pricing.ts`, simulador y cierre usan el mismo cálculo.
- Los tipos de vehículo son códigos configurables (varchar), no una unión cerrada AUTO/CAMIONETA. Desactivar
  bloquea nuevos ingresos, no salidas existentes.
- La UI debe explicar decisiones con ejemplos, ocultar campos de opciones apagadas y separar configurar precios de
  cobrar. El simulador acepta opciones sin guardar sin producir movimientos. El operador elige medio de pago y
  confirma importe antes de cerrar.
- Detalles y semántica: `docs/tickets-tarifas.md`. No presentar la antigua escalera como importe final cuando hay
  opciones avanzadas activas.
