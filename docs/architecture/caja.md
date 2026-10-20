# Referencia técnica: caja

### Two entry flows for parking stays

Both flows produce a `TicketRegistration` row. New rows persist `entryMode` and `vehicleType`; legacy rows fall
back to the `ticket` relation or `codeBarTicket`.

- **Barcode flow.** `ScannerService.start()` checks known physical cards first, including numeric ones; unknown
  11–15 digit codes fall back to receipt lookup. The first scan opens a stay. The second returns
  `requiresClose: true` and `registrationId` without charging. The UI opens the shared close panel. The card is
  unlinked only after a confirmed close.
- **Plate flow.** `POST /tickets/registrations/by-plate` opens the stay. Both origins close through
  `PATCH /tickets/registrations/:id/close` after `GET /tickets/registrations/:id/close-summary`. Closing requires
  a real user, `expectedPrice` and `expectedCollected`; stale amounts return `TICKET_PRICE_CHANGED`. Registration,
  movements and box delta commit in one transaction. Retrying an already completed close does not charge again.
- `TicketScheduleSettings.barcodeTicketsEnabled` is a single-row-per-playa setting surfaced at
  `GET/PATCH /tickets/schedule-settings`; it is a **frontend** toggle for hiding the legacy flow — the backend
  does not gate anything on it.
- `TicketRegistrationForDay` is a separate flow for pre-paid day/week parking (`createRegistrationForDay`), priced
  from `TicketPrice` rows (per vehicle type × `DIA`/`SEMANA`/`SEMANA_Y_DIA`) — unrelated to the bracket ladder.

### Money: the `Movimiento` ledger

`src/movimientos/` is the source of truth for everything charged. It is **append-only** — no edit/delete endpoint
exists, and corrections are new rows of `tipo: 'AJUSTE'` with a `motivo`. New registrations use
`movimientosService.sumByRegistration(id)`, excluding `CORTESIA`. Legacy registrations may add a frozen
`legacyCollectedOffset` for old scalar-only advances. Reducing an advance creates a negative `AJUSTE` with a
reason; excess at checkout requires `refundMetodo`. `MovimientosService.create` is the single entry point (it is
where the mandatory-`motivo` rule for `AJUSTE`/`CORTESIA` lives); `Movimiento.sequence` is an incrementing int
because the reserved `hashAnterior`/`hash` chain needs a definite "previous row".

`src/turnos/` separates operator shifts from physical cash drawers. `shiftsEnabled` is the master switch;
`multipleShiftsEnabled` defaults off (one operator in Caja principal). With multiple shifts on, users choose a
physical caja and can share its CashSession without duplicating the opening fund. Session cash equals its
opening fund plus all participant cash_entries plus signed cash_session_movements. Participants can end their
shift without counting; the last operator counts and closes the caja. Admin can close any shift in the playa
with a reason. The retained fund follows the physical caja, regardless of the next operator. Legacy shifts
without cashSessionId retain their historical calculation and must close before new caja openings.
See `docs/caja-turnos.md` for configuration, migration and API contracts.

`src/box-lists/` tracks daily net physical cash (not transfer/check revenue or shift handovers). All cash
mutations must use its transaction-aware helpers, which append `cash_entries` in the same transaction. Receipt
payments must also save through their query-runner manager to avoid orphan payments or blocking on newly created
boxes. The daily cash register ("caja"): one `BoxList` per calendar date (Argentina timezone) **per playa**,
auto-created on first payment of the day and incremented atomically under transaction locks, including first-row
creation. Both ticket flows reach it through `TicketsService.linkToTodaysBoxList`, which must be called on any new
payment path — a `Movimiento` alone is invisible to the caja and the planilla. Box lookups also return
`ticketMovements` by Argentina calendar date, so advances remain on the day collected even if the registration
later links to another box. The planilla uses these daily entries, with legacy fallback only for records without
movements or pricing snapshots. Box lookups (`findBoxByDate`/`findOne`) eagerly load a deep relation graph
(receipts → customers → parkingOwners/parkingRenters → payment history) — extend carefully, this is already a
heavy query.

### Salida gratuita

A stay that entered in a GRATUITO playa has `modalidad = 'GRATUITO'`, no `pricingSnapshot`, and leaves through
`PATCH /tickets/registrations/:id/salida` (`registrarSalidaGratuita`): no price, `Movimiento`, cortesía, `cash_entries`
or `BoxList`; the card is unlinked; retries return the same row. `priceRegistration` rejects these stays with
`ESTADIA_GRATUITA`, so no charging path can price them. `applyTicketPayment`, `MovimientosService.create`, turno opening
and QR/alias creation call `exigirCobro` after taking 718904. See `docs/modalidad-gratuita.md`.
