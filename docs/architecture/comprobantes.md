# Referencia técnica: comprobantes

### Comprobantes (parking receipts)

`src/tickets/parking-receipts.service.ts` + `PublicParkingReceiptsController`. Per-playa delivery channels live in
`TicketScheduleSettings.receiptDelivery` (`{whatsapp, qr, print, paperWidth: 58|80}`, all off by default).
Issuing freezes a `snapshot` and a random 256-bit token; `ParkingReceipt` is unique per
`playaId + registrationId + kind` (`ENTRY`/`EXIT`), so a retry reuses the same link instead of charging again.
`GET /public/parking-receipts/:token` is the only unauthenticated read route with customer data (the other public
read, `GET /public/planes`, is just the price list): it returns vehicle, playa,
times and amounts — never users or internal movements — with `no-store`/`noindex` headers. Its only consumer is
`../estacionamiento-comprobantes-demo`, a separate Next app on its own domain whose whole job is rendering that
response (`/c/<token>`), so the link a customer receives never exposes the system's domain. It fetches
server-side, so no CORS entry is needed for it. See `docs/comprobantes.md`.

Renter payments reuse this circuit: `kind: 'PAGO'` (`CuentasService.emitirComprobante`, `POST /cuentas/pagos/:id/comprobante`)
with `registrationId` = the `cuenta_movimientos` PAGO row and a `ReciboPagoSnapshot`; `readPublic` adds `anulado` at read
time. QR/print follow `receiptDelivery`, but WhatsApp is offered whenever the renter has a valid cell number
(`telefono` in the response), regardless of the toggle. Renters can also pay by MercadoPago QR (`CobroMercadoPago.tipo = 'INQUILINO'`, `registrationId` = customer id,
amount/cargos in `detalle`); accreditation posts one PAGO with `metodo: 'MERCADOPAGO'` (outside the cash drawer, not
anulable). `MERCADOPAGO` exists in the stored payment enums but never in DTOs, so nobody can declare it by hand.

### Modalidad gratuita

A GRATUITO playa issues no receipts: `issueParkingReceipt` and `CuentasController.emitirComprobante` are in
`FREE_MODE_BLOCKED`, `getSchedule` returns `receiptDelivery` switched off (the stored setting is kept) and
`updateSchedule` rejects changing it. A stay that entered free and leaves after the playa went back to CON_COBRO gets
an EXIT snapshot with `modalidad: 'GRATUITO'` and `total`/`collected` null; comprobantes and the frontend omit the
amounts block for it.
