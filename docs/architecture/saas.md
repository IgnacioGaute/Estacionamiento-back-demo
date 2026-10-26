# Referencia técnica: saas

### Plans and the empresa's account with the platform (`src/saas/`)

What the platform bills the empresa for using the system — not what a playa bills its abonados (that is
`receipts`/`cuentas`). Lifecycle: **alta** (editable `suscripciones.alta`) → optional free-trial days (no plan
needed; `diasPrueba` on empresa creation or `POST …/suscripcion/alta`) → when the trial ends the **first
payment** is issued and due that same day: the rest of that month, prorated per day
(`primerPeriodo`/`importeProporcional`/`proximoPeriodo` in `estado-cuenta.ts`; trial days are not charged) →
from then on each period starts on the 1st → days of delay
count from the due date → more than 5 days late, the daily `@Cron` (`SuscripcionesScheduler`, outside any tenant
scope, advisory-locked, idempotent) suspends it (`FALTA_DE_PAGO`); 60 days suspended → `BAJA`. Every payment
moves the due date a period; the next invoice is issued on its due date. The débito can only be activated after
the first payment (`PRIMER_PAGO_PENDIENTE`). `planes` is the price list (landing sizes: up to 50 / 51–120 / over 120 vehicles at once, each with
or without «alquileres mensuales»); `suscripcion_playas` gives each playa a plan with a frozen **precio pactado**
(list changes never touch it; additional playas default to 30% off) and the empresa pays the sum; `suscripciones`
holds only dates (`alta`, `pruebaHasta`, `pagadoHasta`, `prorrogaHasta`), `bonificada` and `motivoSuspension`;
`facturas_saas` are billed periods (one `PENDIENTE` per empresa, `ANULADA` instead of deleting). The account state
(`SIN_ACTIVAR`, `PRUEBA`, `AL_DIA`, `VENCIDA` + `diasDeAtraso`, …) is never stored: `estado-cuenta.ts` derives it
from the dates and `empresas.estado`, which stays the only access switch. «Días extra» is a single action: it
extends the trial if never paid, otherwise it is a prórroga (moves the suspension, not the due date). Payments,
días extra and alta changes reactivate only `FALTA_DE_PAGO` suspensions; `MANUAL` ones need the super admin. A plan
defines `playas.modulos.inquilinos` (manual toggle then answers `MODULO_DEFINIDO_POR_PLAN`). The `activos` limit
is soft and only the super admin sees usage; `MiPlanController` never returns it. Mutations live in
`SuscripcionesController` (super admin, skipped by `TenantInterceptor`); the empresa only reads through
`MiPlanController` with RLS and `SELECT`-only grants; its payment handlers (MercadoPago link, débito automático,
verify) write through `tenantContext.exit` on the session's empresa only. The platform collects with its own
MercadoPago app (`MercadoPagoPlataforma`, never the empresas' OAuth tokens): Checkout Pro links
(`plan:<empresaId>:<desde>`), an interoperable QR order on the platform's own store/POS (`plan_<empresaId>_<desde>`,
open order in `suscripciones.qrOrdenId`, credited by the order's payment id, never by the payment webhook) and a `preapproval` charging every period: with `MERCADOPAGO_PLATAFORMA_PUBLIC_KEY` the panel embeds
MercadoPago's card form and sends only its one-time token (`authorized` on the spot, no MercadoPago account needed);
without it the customer confirms it in MercadoPago. `CobrosPlataformaService`
credits approved payments from the webhook, the return from MercadoPago and a cron every 2h (plus 05:00, before
suspending), always re-querying the API and once per payment id (lock + unique index). An authorized débito
stretches the grace to 10 days. **Payment periods** (`periodos_pago`: MENSUAL, TRIMESTRAL −10%, ANUAL −15%, as on
the landing) are a catalog like `planes`: the super admin assigns one per empresa and its months and discount are
frozen in `suscripciones.periodoMeses`/`periodoDescuento`; every factura, MercadoPago link and débito then covers a
whole period for `importeDelPeriodo(mensual, meses, descuento)`. `mensual` stays the monthly list sum;
`importePeriodo` is what is actually charged. Changing an empresa's period cancels its débito first (MercadoPago
would keep charging the old amount and frequency). See `docs/planes-y-cuentas.md`.
