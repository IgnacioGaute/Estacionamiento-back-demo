# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager is **pnpm** (`packageManager: pnpm@9.15.4`).

```bash
pnpm install              # install dependencies
pnpm dev                  # start with watch mode (nest start --watch)
pnpm start:debug          # watch mode + node inspector
pnpm build                # compile (nest build)
pnpm start:prod           # run compiled output (node dist/main)
pnpm lint                 # eslint --fix over {src,apps,libs,test}/**/*.ts
pnpm lint:ci              # eslint without --fix, zero warnings (what CI runs)
pnpm typecheck            # tsc -p tsconfig.json --noEmit (src + specs + test/; the build config skips specs)
pnpm format               # prettier --write src/test (formatting is NOT part of lint or CI)
pnpm test                 # jest unit tests (rootDir: src, matches *.spec.ts)
pnpm test:ci              # jest --ci --coverage
pnpm test:integration     # node --test over the self-contained test/*.cjs (needs dist/)
```

ESLint is flat config (`eslint.config.mjs`, same rules as the old `plugin:@typescript-eslint/recommended`);
unused parameters/variables are allowed only with a `_` prefix.

Jest specs sit next to the code as `*.spec.ts` and test logic without a database: pure functions
(`pricing.spec.ts`, `estado-cuenta.spec.ts`, `license-plate.util.spec.ts`) or services with mocked repositories and
`dataSource.transaction` (`turnos.service.spec.ts`, `offline-shift.spec.ts`). ts-jest runs with `isolatedModules`
(transpile only, ~5 s for the suite) — type errors are caught by `pnpm typecheck`, not by Jest. Run one file with
`pnpm test pricing.spec.ts`, a single case with `pnpm test -- -t "<name>"` (pnpm 9 swallows a bare `-t`).

The real coverage lives in `test/*.cjs`, run with `node --test` **after `pnpm build`** (they load from `dist/`):

```bash
node --test test/tickets.integration.cjs          # pricing, cierre, caja, turnos
node --test test/tenancy.integration.cjs          # empresa/playa scoping
node --test test/tenant-isolation.integration.cjs # RLS, permisos, comprobantes públicos, empresa suspendida
node --test test/suscripciones.integration.cjs    # planes, vencimientos, suspensión, pagos de la plataforma
node --test test/cuentas.integration.cjs test/tariff-plan.integration.cjs
node --test test/assistant.test.cjs test/gemini-request.test.cjs test/image-signature.test.cjs
```

The `*.integration.cjs` create and remove an isolated temporary PostgreSQL cluster and never read `.env`.
Set `PG_TEST_BIN` if PostgreSQL binaries are not in `C:/Program Files/PostgreSQL/18/bin`. A new self-contained
test file must also be added to `test:integration` in `package.json`, or CI never runs it.
The other `test/*.cjs` (puppeteer and UI tests) read **sibling repos** and fail without them, so CI does not run
them: `receipt-mobile-layout`, `receipt-history-panel`, `assistant-message-render`, `tariff-editor-rules`,
`pwa-offline` and `admin-*.ui` need `../estacionamiento-front-demo`, and `parking-receipt-export` needs
`../estacionamiento-comprobantes-demo` (both with `node_modules` installed).

**CI/CD.** `.github/workflows/ci.yml` runs on every push to `main` and every PR: one job does typecheck, lint,
Jest and build; another builds and runs `test:integration` against the runner's preinstalled PostgreSQL. Railway
deploys `main` itself; with «Wait for CI» enabled on the service it only deploys a green commit.

Requires a Postgres database. `docker-compose.yaml` provides one (postgres:16.2, published on host port **5430**,
db/user/password `estacionamiento_demo`/`admin`/`admin`). Env vars read at boot: `PORT` (default 3030),
`ALLOWED_ORIGINS` (comma-separated), `POSTGRES_{HOST,PORT,NAME,USER,PASSWORD}`, `DB_BOOTSTRAP`, `NEXTAUTH_SECRET`,
`API_SECRET_TOKEN`, `CLOUDINARY_{NAME,API_KEY,API_SECRET}`,
`GEMINI_{API_KEY,MODEL,FALLBACK_MODELS}`,
`MERCADOPAGO_TOKEN_KEY` (32 bytes en hex, `openssl rand -hex 32`; cifra los tokens de MercadoPago de cada empresa y
los de Plate Recognizer de cada playa),
`PLATAFORMA_DATOS_PAGO` / `PLATAFORMA_WHATSAPP` (opcionales: datos de transferencia y WhatsApp que ve una empresa
en «Mi plan» para pagarle a la plataforma),
`MERCADOPAGO_PLATAFORMA_{ACCESS_TOKEN,PUBLIC_KEY,WEBHOOK_SECRET,WEBHOOK_URL}` y `PLATAFORMA_URL_FRONT` (la cuenta de
MercadoPago donde la plataforma cobra el plan; otra aplicación que la de los QR de las empresas),
`MERCADOPAGO_PRUEBA_CUENTAS` (ids de vendedor de MercadoPago separados por coma: las únicas cuentas sobre las que
corre la prueba de transferencias del super admin; vacío = ninguna).

`scripts/start-compiled.cjs` registers `tsconfig-paths` before `dist/main` — sources import each other as
`src/...`, so plain `node dist/main` only works where those paths resolve.
`node --env-file=.env scripts/assign-legacy-tenant.cjs <empresaId> <playaId>` back-fills pre-tenancy rows (backup
first, one transaction, only unassigned rows, safe to rerun).

Domain docs: `docs/tickets-tarifas.md` (tarifas y cierres), `docs/caja-turnos.md` (caja/turnos),
`docs/administracion-plataforma.md` (empresas, playas, RLS), `docs/comprobantes.md` (entrega de comprobantes),
`docs/security-review.md` (controles vigentes), `docs/planes-y-cuentas.md` (planes, vencimientos y suspensión de
empresas), `docs/verificacion-transferencias.md` (prueba de transferencias recibidas: qué está confirmado y qué
falta), `src/assistant/README.md` (asistente).

## Architecture

NestJS 10 REST API (+ Socket.IO gateways) for a multi-tenant parking-lot ("estacionamiento") management system,
backed by TypeORM/Postgres. Each domain lives in `src/<domain>/` with the standard Nest module layout:
`*.module.ts`, `*.controller.ts`, `*.service.ts`, `dto/`, `entities/`.

Modules (wired in `src/app.module.ts`): `receipts`, `scanner`, `tickets`, `box-lists`, `customers`, `users`,
`auth`, `notes`, `parking`, `turnos`, `movimientos`, `plate-recognition`, `tenancy`, `saas`, `assistant`.

### Multi-tenancy: empresa → playa (read this before touching anything else)

`Empresa` is the paying customer and the isolation boundary; `Playa` is the operational scope — every ticket,
caja, turno, movimiento, cliente, cochera and aviso hangs off a `playaId`. Users belong to an empresa
(`empresaId`) and `usuario_playas` says which playas they may operate. `SUPER_ADMIN` is the platform owner and
the only role with `empresaId` null; `ADMIN` administers one empresa; `USER` is the counter operator.

Enforcement is layered, and **all three layers must keep agreeing**:

1. **Request scope.** `TenantInterceptor` (global `APP_INTERCEPTOR`) resolves `{empresaId, playaId, userId, role,
   platform}` from the authenticated user plus the `X-Playa-Id` header (auto-selected when the user has exactly
   one playa) and runs the handler inside `tenantContext.run` (`src/tenancy/tenant-context.ts`, an
   `AsyncLocalStorage`). It skips `AuthController`, `TenancyController`, `TenantContextController`,
   `PublicParkingReceiptsController` and NextAuth's account lookups.
2. **Connection scope.** `installTenantConnections` patches `DataSource.createQueryRunner`: every runner sets
   `parking.empresa` / `parking.playa` / `parking.platform` via `set_config` and does `SET ROLE parking_scoped` on
   its own pooled connection before its first query, and resets both on release (rolling back a live transaction
   first). No SQL rewriting and no global "current tenant". A `beforeInsert` subscriber stamps `playaId`
   (`empresaId` for `users`) on new entities.
3. **Database.** `TenantIsolation1790000001000` creates the `parking_scoped` role (`NOLOGIN NOSUPERUSER
   NOBYPASSRLS`), adds `playaId` to every table in its exported `PLAYA_TABLES`, and enables `FORCE ROW LEVEL
   SECURITY` with per-role policies. Two triggers back it: `parking_stamp_scope` (fills the scope on insert) and
   `parking_check_references` (validates FKs against *visible* rows, because PostgreSQL FK checks bypass RLS).

Consequences for new code:

- Background jobs, cron tasks and anything running outside an HTTP request must wrap work in `tenantContext.run`
  with an explicit destination, or it runs unscoped.
- A new table holding tenant data needs a `playaId` column plus its index, policy and triggers created in a
  migration — `synchronize` does not do RLS.
- Sockets: all three gateways go through `TenantSocketAccess` (`src/tenancy/tenant-socket.ts`), which verifies the
  handshake JWT, joins `playa:<id>`, and **revalidates account, `authVersion`, expiry and playa access before
  every emit**, disconnecting revoked clients.
- `TenancyController` (`/tenancy/...`: empresas, playas, usuarios, asignaciones) is `SuperAdminGuard`-only and
  deliberately does **not** accept the static token — platform changes need an identifiable person.

### Auth & permissions

- `JwtStrategy` (`src/utils/strategies/jwt.strategy.ts`) validates bearer tokens signed with `NEXTAUTH_SECRET`
  (tokens are minted by a NextAuth frontend, not here), then re-reads the user from the database: the account must
  exist, `payload.authVersion` must match `user.authVersion` (bumped on password change, so old sessions die), and
  a non-`SUPER_ADMIN` user's empresa must be `ACTIVA` or `SUSPENDIDA` (`BAJA` is locked out; the strategy returns
  `empresaEstado` on `req.user`). Login applies the same rule.
- `TenantGuard` (global `APP_GUARD`, `src/tenancy/tenant-access.ts`) is the real gate — controller-level
  `@UseGuards(AuthOrTokenAuthGuard)` is still present but no longer decides access on its own. It:
  - lets `PublicParkingReceiptsController.read` through unauthenticated (public comprobante links), and
    `AvisoMercadoPagoController.aviso` (the platform's MercadoPago webhook: it checks the signature and only uses
    the id to re-query MercadoPago with its own token), and `PlanesPublicosController.catalogo`
    (`GET /public/planes`: the active price list and payment periods the landing shows, readable from any origin
    — `Access-Control-Allow-Origin: *` on that response only — and nothing about empresas);
  - rate-limits `AuthController.login` (`src/auth/login-limiter.ts`: per-IP and per-identifier, using the
    connection IP, never a forwarded header) and requires `Bearer API_SECRET_TOKEN` for every *other*
    `AuthController` handler. The static token is now reserved for those server-side auth calls plus
    `UsersController.findAll`/`findOne` — **no operational route accepts it**;
  - lets a `SUSPENDIDA` empresa (any role) reach only `SUSPENDED_ENDPOINTS` (context, «Mi plan», finding and
    charging exits, receipts, MercadoPago QR, turnos, reading the caja), answering `EMPRESA_SUSPENDIDA` otherwise.
    The scanner stays reachable for the second scan; `TicketsService.createRegistration` rejects the opening one
    via `tenantContext` `suspendida`;
  - restricts `UsersController` to ADMIN/SUPER_ADMIN, except a user reading or re-passwording themselves;
  - allows role `USER` only the handlers listed in `src/tenancy/endpoint-policy.ts`.
- `OPERATOR_ENDPOINTS` is an allowlist keyed by **controller class + handler name** (not URL spelling, so casing
  or a trailing slash cannot bypass it). A new handler is administrator-only until it is added there.
  `endpoint-policy.spec.ts` fails if a name in `OPERATOR_ENDPOINTS`/`SUSPENDED_ENDPOINTS` is not a real method of
  that controller (a rename would otherwise surface as 403s in production); `tenant-access.spec.ts` covers the
  guard's decisions per role and empresa state.
- Endpoints that write money still need a real user on top of all this:
  `if (!req.user?.userId) throw new UnauthorizedException(...)` (see `TicketsController.closeRegistrationByPlate`,
  `requireUserId` in `TurnosController`) — `Movimiento.usuario` is not nullable.

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

### Pricing brackets

Hourly pricing lives in `src/tickets/pricing/pricing.ts`. `TicketPriceBracket` is scoped by vehicle and optional
`DAY`/`NIGHT`. A specific bracket overrides a general one only at the same duration; duplicates in the same scope
are rejected. Cascading cannot exceed the covering bracket. `uptoMinutes: null` is the open-ended bracket; with
`recurringUnitMinutes`, `recurringPriceMode: FIXED` uses its entered price per unit while `DERIVED` preserves the
legacy proportional calculation. Existing database rows default to DERIVED; new API rows default to FIXED.
`GET /tickets/priceBrackets/preview` uses this same calculator.

Each new stay freezes brackets and schedule in `pricingSnapshot`. `pricingDayTypeBasis` chooses ENTRY or EXIT
(existing configuration defaults to EXIT). Later changes only affect new stays. Old active rows without snapshots
use current settings and are explicitly marked in close summaries. Missing applicable tariffs block entry. The
established grace rule is retained: tolerance before moving up a bracket, except the final finite fallback.
Shared/exclusive PostgreSQL transaction locks keep snapshot capture and tariff updates consistent. Entity enums
live in `ticket.constants.ts` to avoid TypeORM initialization cycles.

Vehicle types are configurable rows (`VehicleTypeEntity`, table `ticket_vehicle_types`, unique per
`playaId` + `code`), not a closed AUTO/CAMIONETA union; a new playa is seeded with Auto and Camioneta. Disabling a
type blocks new entries, never existing exits.

### Plates

`src/tickets/utils/license-plate.util.ts` defines three stored columns per registration: `licensePlateOriginal`
(as typed, for display), `licensePlateNormalized` (uppercase alphanumeric, for active-duplicate detection),
`licensePlateSearch` (normalized + confusable folding O→0, I→1, S→5, B→8, for search). Always write all three
through `normalizePlate`/`toSearchKey`. Opening a second active registration for the same normalized plate is
rejected with code `DUPLICATE_ACTIVE_PLATE` unless the caller passes `duplicateOverride` + reason.
`noPlate: true` registrations require `lastNameCustomer` instead. `src/plate-recognition/` proxies the Plate
Recognizer ANPR API server-side so the key never reaches the browser; `image-signature.validator.ts` checks magic
bytes so a disguised document is rejected before anything parses it. There is **no platform key**: each playa
that buys the feature has its own Plate Recognizer account, whose token the super admin pastes in the empresa's
ficha (`PUT/DELETE /tenancy/playas/:id/patentes`, usage at `GET /tenancy/empresas/:id/patentes`). Tokens live
encrypted in `plate_recognizer_cuentas` (one row per playa, no TypeORM entity, operators get SELECT on their own
row only); a playa without a row answers `PATENTES_SIN_PLAN` and the context's `reconocimientoPatentes: false`
hides the camera. Every lookup is billed to that plan whether or not it finds a plate, so the front's live scanner
(`src/utils/plate-scan.ts` there) filters frames on the phone before sending any.

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

### Assistant (Gemini)

`src/assistant/` is an operator-facing chat (`POST /assistant/chat`, plus an SSE `chat/stream` that still buffers
the whole answer before emitting it). The Google key stays server-side. The model gets **read-only tools only** —
no SQL, no mutations — and every tool execution re-checks the tenant scope. `knowledge.ts` is versioned product
guidance that must be updated when screens, rules or permissions change. History and rate limits (8
questions/minute, one concurrent per user/playa) are per-process in memory; multiple instances would need shared
storage. Each question (text, topic from `temas.ts`, answered or not — never the answer) is also persisted in the
playa-scoped `assistant_preguntas` table, which feeds the super admin's metrics screen. `gemini-request.ts` owns retries and fallback models within a 65s budget. See `src/assistant/README.md`.

### Receipts / customers / parking

`src/customers/` holds recurring-customer billing (monthly parking, renters, receipt payments,
payment-history-on-account). `src/parking/` owns the spots: `ParkingOwner` (a garage spot belonging to a customer,
optionally rented out via `rent`/`rentActive`), `ParkingRenter`, and the customer-defined
`OwnerParkingType`/`RenterParkingType` price tiers. Owner/renter create-update logic was extracted out of
`CustomersService` into `ParkingOwnersService`/`ParkingRentersService` (see the "Reemplaza el bloque OWNER de
CustomersService" comments) — put new spot logic there, not back in customers.

**Entity names diverge from table names here** because of history under `synchronize: true`: `ParkingOwner` →
table `vehicles`, `ParkingRenter` → `vehicle_renters`, `OwnerParkingType` → `parking_types` (with its `name`
property mapped to the physical column `parkingType`). On `Customer` the relations are
`parkingOwners`/`parkingRenters`. Raw SQL, RLS migrations and relation strings must use these physical names.

### Plans and the empresa's account with the platform (`src/saas/`)

What the platform bills the empresa for using the system — not what a playa bills its abonados (that is
`receipts`/`cuentas`). Lifecycle: **alta** (editable `suscripciones.alta`) → optional free-trial days (no plan
needed; `diasPrueba` on empresa creation or `POST …/suscripcion/alta`) → when the trial ends the first month's
invoice is issued and is due that same day → days of delay count from there → more than 5 days late, the daily
`@Cron` (`SuscripcionesScheduler`, outside any tenant scope, advisory-locked, idempotent) suspends it
(`FALTA_DE_PAGO`); 60 days suspended → `BAJA`. Every payment moves the due date a month; the next invoice is issued
on its due date. `planes` is the price list (landing sizes: up to 50 / 51–120 / over 120 vehicles at once, each with
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
(`plan:<empresaId>:<desde>`) and a `preapproval` charging every period: with `MERCADOPAGO_PLATAFORMA_PUBLIC_KEY` the panel embeds
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

### Config & cross-cutting

- Config uses `@nestjs/config` with `registerAs` namespaces in `src/config/` (`app`, `database`), merged in
  `src/config/index.ts`, registered globally in `AppModule`.
- **Schema changes go through migrations.** `synchronize` is now `false` except when `DB_BOOTSTRAP=true`, which
  exists only to create the schema from entities on the *first* boot of an empty database (every migration here is
  an upgrade that ALTERs tables `synchronize` originally created, so they cannot run first on a blank DB).
  Migrations are an explicit **imported array** in `src/config/database.config.ts`, not a glob — a new file under
  `src/database/migrations/` does nothing until it is imported and appended there — and they run on boot
  (`migrationsRun`). Never leave `DB_BOOTSTRAP` on against a real database: it would let a deleted `@Column` drop
  its data. Obsolete fields stay `@deprecated` in place (`TicketRegistration.vehiclePlateCustomer`) and renamed
  properties keep their old physical column name via `@Column({ name: ... })`.
- `main.ts` applies `helmet()`, CORS restricted to `app.allowedOrigins`, and a global
  `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` (so every accepted field needs a DTO
  property). It deliberately no longer serves `uploads/` — local files must not bypass authentication and tenant
  authorization; do not re-add a static file route.
- Date/business-day logic uses `dayjs` with `utc`/`timezone`/`isBetween` pinned to
  `America/Argentina/Buenos_Aires`. New date logic must follow that, not raw `Date`/server-local time.
  Registrations store `entryDay`/`entryTime` as separate `date`/`time` columns — recombine them with `dayjs.tz`
  over a `"YYYY-MM-DD HH:mm:ss"` string, as `minutesSinceEntry` does.
- Three separate WebSocket gateways exist and should not be merged: `tickets/register-gateway.ts` (`TicketGateway`,
  event `new-registration`, emitted on both open and close), `customers/notification-interest-gateway.ts`, and
  `notes/notification-gateway.ts`. All emit through `TenantSocketAccess`, never `server.emit` directly.
- Image uploads go through Cloudinary (`src/libs/helpers/image-helper.ts`).
- Deployment builds from `Dockerfile` / `.nixpacks.toml`; both install chromium because puppeteer renders PDFs.
- Domain-facing code comments and all user-visible error messages are written in **Spanish** (the operators are
  Argentine); comments explain *why* a rule exists rather than restating the code. Match that. Structured errors
  use a `{ code, message }` body (`DUPLICATE_ACTIVE_PLATE`, `NO_OPEN_TURNO`, `TICKET_PRICE_BRACKET_NOT_FOUND`,
  `SOLO_SUPER_ADMIN`) so the frontend can branch on `code`.

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
