# Referencia técnica: cuentas

### Cuenta corriente de inquilinos (`src/cuentas/`)

Only for `RENTER` customers, and only where the super admin turned on `playas.modulos.inquilinos`
(`MODULO_INQUILINOS_APAGADO` otherwise). Vocabulary (reviewed with an accountant, keep it consistent in UI and
messages): *abono mensual* = agreed price; *cargo* = what a period adds to the account; *pago* = money received,
documented by a *recibo de pago* ("X", no válido como factura); *saldo pendiente* / *saldo a favor*.
`cuenta_movimientos` is an append-only ledger (the scoped role has SELECT/INSERT only): positive `importe` =
debe, negative = haber, saldo = SUM. For renters a `receipts` row is a **cargo** (`price` = still owed), typed by
`tipoCargo` (`ABONO`/`RECARGO`/`SALDO_INICIAL`) with `periodo` and `vencimiento`; one cargo per renter and
period is enforced by the partial unique index `receipts_cargo_periodo_unico`. `conciliar` keeps cargos equal
to the ledger; legacy renters are back-filled lazily by `asegurarCuenta`, which must run before any ledger
write. A renter's cocheras (`vehicle_renters`) are just number + monthly price with `owner` null
(`CocherasSinDuenio1790000019000`); older rows may still carry a `RenterParkingType` name, and real `ParkingOwner`
links belong to PRIVATE customers (Particulares). The abono is the sum of the prices. Query a renter's cargos with `cargosDe()` (relation filters otherwise drop soft-deleted customers):
a *baja* frees the cocheras and stops monthly abonos but keeps the account payable. Monthly abonos go through
`previsualizarAbonos`/`cargarAbonos` (advisory lock per playa+month, savepoint per renter); price or cocheras
changes never rewrite registered cargos. `registrarPago` is idempotent on `solicitudId` (unique with `metodo`).
Money actually returned is a `DEVOLUCION` (only from saldo a favor), not an anulación. Legacy receipt
update/cancel/delete for renters return `USAR_CUENTA_CORRIENTE`. Anulación is deliberately hard
(`anulacion.ts`, shared by the endpoint and the `anulable` flags sent to the UI): cargos/adjustments only in
the month they were loaded, payments and devoluciones only while their turno is open (same day without
turnos), never migrated history; it needs a 10+ character reason and the exact amount typed back. Anulled pairs
are hidden in the account view and the printed statement; `GET /cuentas/anulaciones` is the admin's control
list. `BoxListsService.findBoxByDate` adds `cobrosInquilinos` (the day's PAGO/DEVOLUCION rows from the ledger, one per
medio, plus anulaciones of other days; `null` when the module is off) for the planilla's «Inquilinos» section and
per-method totals. The operator (USER) gets the list without playa totals (`resumen` returns `kpis: null`) and, per renter,
only `GET /cuentas/:id/mostrador` (pending cargos + non-anulled payments with what each covered, so the operator can re-issue its recibo; no ledger); `estado` is admin-only and the
frontend redirects `/renters/[id]` to the list. Amounts are whole pesos: DTOs reject decimals and the UI never reinterprets a "1.000,50".
