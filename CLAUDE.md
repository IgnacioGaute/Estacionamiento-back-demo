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
pnpm format               # prettier --write src/test
pnpm test                 # jest unit tests (rootDir: src, matches *.spec.ts)
pnpm test:cov             # jest with coverage
pnpm test:e2e             # e2e tests via test/jest-e2e.json
```

Run pricing unit tests with `pnpm exec jest --runInBand pricing.spec.ts`. After `pnpm build`, run `node --test test/tickets.integration.cjs`: it creates and removes an isolated temporary PostgreSQL cluster and never reads `.env`. Set `PG_TEST_BIN` if PostgreSQL binaries are not in `C:/Program Files/PostgreSQL/18/bin`. See `docs/tickets-tarifas.md` for contracts and compatibility.

Requires a Postgres database. `docker-compose.yaml` provides one (postgres:16.2, published on host port **5430**, db/user/password `estacionamiento_demo`/`admin`/`admin`). Env vars read at boot: `PORT` (default 3030), `ALLOWED_ORIGINS` (comma-separated), `POSTGRES_{HOST,PORT,NAME,USER,PASSWORD}`, `NEXTAUTH_SECRET`, `API_SECRET_TOKEN`, `CLOUDINARY_{NAME,API_KEY,API_SECRET}`, `PLATE_RECOGNIZER_API_KEY`.

## Architecture

NestJS 10 REST API (+ Socket.IO gateways) for a parking-lot ("estacionamiento") management system, backed by TypeORM/Postgres. Each domain lives in `src/<domain>/` with the standard Nest module layout: `*.module.ts`, `*.controller.ts`, `*.service.ts`, `dto/`, `entities/`.

Modules (wired in `src/app.module.ts`): `receipts`, `scanner`, `tickets`, `box-lists`, `customers`, `users`, `auth`, `notes`, `parking`, `turnos`, `movimientos`, `plate-recognition`.

### Two entry flows for parking stays

Both flows produce a `TicketRegistration` row. New rows persist `entryMode` and `vehicleType`; legacy rows fall back to the `ticket` relation or `codeBarTicket`.

- **Barcode flow.** `ScannerService.start()` checks known physical cards first, including numeric ones; unknown 11–15 digit codes fall back to receipt lookup. The first scan opens a stay. The second returns `requiresClose: true` and `registrationId` without charging. The UI opens the shared close panel. The card is unlinked only after a confirmed close. Scanner requests require bearer authentication (user JWT or hardware token).
- **Plate flow.** `POST /tickets/registrations/by-plate` opens the stay. Both origins close through `PATCH /tickets/registrations/:id/close` after `GET /tickets/registrations/:id/close-summary`. Closing requires a real user, `expectedPrice` and `expectedCollected`; stale amounts return `TICKET_PRICE_CHANGED`. Registration, movements and box delta commit in one transaction. Retrying an already completed close does not charge again.
- `TicketScheduleSettings.barcodeTicketsEnabled` is a single-row setting surfaced at `GET/PATCH /tickets/schedule-settings`; it is a **frontend** toggle for hiding the legacy flow — the backend does not gate anything on it.
- `TicketRegistrationForDay` is a separate flow for pre-paid day/week parking (`createRegistrationForDay`), priced from `TicketPrice` rows (per vehicle type × `DIA`/`SEMANA`/`SEMANA_Y_DIA`) — unrelated to the bracket ladder below.

### Money: the `Movimiento` ledger

`src/movimientos/` is the source of truth for everything charged. It is **append-only** — no edit/delete endpoint exists, and corrections are new rows of `tipo: 'AJUSTE'` with a `motivo`. New registrations use `movimientosService.sumByRegistration(id)`, excluding `CORTESIA`. Legacy registrations may add a frozen `legacyCollectedOffset` for old scalar-only advances. Reducing an advance creates a negative `AJUSTE` with a reason; excess at checkout requires `refundMetodo`. `MovimientosService.create` is the single entry point (it is where the mandatory-`motivo` rule for `AJUSTE`/`CORTESIA` lives); `Movimiento.sequence` is an incrementing int because the reserved `hashAnterior`/`hash` chain needs a definite "previous row".

`src/turnos/` now supports one shared physical cash drawer with successive shifts, regardless of calendar date. New shifts (`cashVersion=2`) calculate expected cash from `fondoInicial + cash_entries`, covering tickets, day passes, receipts and other cash changes. Closing records counted cash, withdrawal and a handover amount; reopening acknowledges that handover exactly once. Transfers, checks and courtesy are excluded from physical cash. Once the first new shift is opened, cash mutations between shifts are rejected atomically. Legacy shifts retain their previous ticket-only calculation. See `docs/caja-turnos.md` for adoption and API contracts.

`src/box-lists/` tracks daily net physical cash (not transfer/check revenue or shift handovers). All cash mutations must use its transaction-aware helpers, which append `cash_entries` in the same transaction. Receipt payments must also save through their query-runner manager to avoid orphan payments or blocking on newly created boxes. The daily cash register ("caja"): one `BoxList` per calendar date (Argentina timezone), auto-created on first payment of the day and incremented atomically under transaction locks, including first-row creation. Both ticket flows reach it through `TicketsService.linkToTodaysBoxList`, which must be called on any new payment path — a `Movimiento` alone is invisible to the caja and the planilla. Box lookups also return `ticketMovements` by Argentina calendar date, so advances remain on the day collected even if the registration later links to another box. The planilla uses these daily entries, with legacy fallback only for records without movements or pricing snapshots. Box lookups (`findBoxByDate`/`findOne`) eagerly load a deep relation graph (receipts → customers → parkingOwners/parkingRenters → payment history) — extend carefully, this is already a heavy query.

### Pricing brackets

Hourly pricing lives in `src/tickets/pricing/pricing.ts`. `TicketPriceBracket` is scoped by vehicle and optional `DAY`/`NIGHT`. A specific bracket overrides a general one only at the same duration; duplicates in the same scope are rejected. Cascading cannot exceed the covering bracket. `uptoMinutes: null` is the open-ended bracket; with `recurringUnitMinutes`, `recurringPriceMode: FIXED` uses its entered price per unit while `DERIVED` preserves the legacy proportional calculation. Existing database rows default to DERIVED; new API rows default to FIXED. `GET /tickets/priceBrackets/preview` uses this same calculator.

Each new stay freezes brackets and schedule in `pricingSnapshot`. `pricingDayTypeBasis` chooses ENTRY or EXIT (existing configuration defaults to EXIT). Later changes only affect new stays. Old active rows without snapshots use current settings and are explicitly marked in close summaries. Missing applicable tariffs block entry. The established grace rule is retained: tolerance before moving up a bracket, except the final finite fallback. Shared/exclusive PostgreSQL transaction locks keep snapshot capture and tariff updates consistent. Entity enums live in `ticket.constants.ts` to avoid TypeORM initialization cycles.

### Plates

`src/tickets/utils/license-plate.util.ts` defines three stored columns per registration: `licensePlateOriginal` (as typed, for display), `licensePlateNormalized` (uppercase alphanumeric, for active-duplicate detection), `licensePlateSearch` (normalized + confusable folding O→0, I→1, S→5, B→8, for search). Always write all three through `normalizePlate`/`toSearchKey`. Opening a second active registration for the same normalized plate is rejected with code `DUPLICATE_ACTIVE_PLATE` unless the caller passes `duplicateOverride` + reason. `noPlate: true` registrations require `lastNameCustomer` instead. `src/plate-recognition/` proxies the Plate Recognizer ANPR API server-side so the key never reaches the browser.

### Receipts / customers / parking

`src/customers/` holds recurring-customer billing (monthly parking, renters, receipt payments, payment-history-on-account). `src/parking/` owns the spots: `ParkingOwner` (a garage spot belonging to a customer, optionally rented out via `rent`/`rentActive`), `ParkingRenter`, and the customer-defined `OwnerParkingType`/`RenterParkingType` price tiers. Owner/renter create-update logic was extracted out of `CustomersService` into `ParkingOwnersService`/`ParkingRentersService` (see the "Reemplaza el bloque OWNER de CustomersService" comments) — put new spot logic there, not back in customers.

**Entity names diverge from table names here** because of history under `synchronize: true`: `ParkingOwner` → table `vehicles`, `ParkingRenter` → `vehicle_renters`, `OwnerParkingType` → `parking_types` (with its `name` property mapped to the physical column `parkingType`). On `Customer` the relations are `parkingOwners`/`parkingRenters`. Raw SQL and relation strings must use these physical names.

### Auth

- `AuthService`/`AuthController` handle login (by email or username, bcrypt) and email-verification / password-reset tokens — but this backend does **not** mint the JWTs users authenticate with. `JwtStrategy` (`src/utils/strategies/jwt.strategy.ts`) validates bearer tokens signed with `NEXTAUTH_SECRET`, i.e. tokens come from a NextAuth-based frontend.
- Nearly every controller uses `@UseGuards(AuthOrTokenAuthGuard)` (`src/utils/guards/auth-or-token.guard.ts`), which accepts **either** a valid JWT **or** the static `API_SECRET_TOKEN` (for scanner hardware / machine-to-machine).
- Because the static-token path leaves `req.user` unset, any endpoint that writes money must additionally require a real user: the pattern is an explicit `if (!req.user?.userId) throw new UnauthorizedException(...)` in the controller (see `TicketsController.closeRegistrationByPlate` and `requireUserId` in `TurnosController`). Follow it for new charging endpoints — `Movimiento.usuario` is not nullable.

### Config & cross-cutting

- Config uses `@nestjs/config` with `registerAs` namespaces in `src/config/` (`app`, `database`), merged in `src/config/index.ts`, registered globally in `AppModule`.
- `main.ts` applies `helmet()`, CORS restricted to `app.allowedOrigins`, a global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` (so every accepted field needs a DTO property), and serves `uploads/` at `/uploads`.
- **`TypeOrmModuleOptions.synchronize` is `true`** and there is no `db/migrations` directory despite the configured path. Consequences to respect: removing a `@Column` drops its data, so obsolete fields are marked `@deprecated` and left in place (`TicketRegistration.vehiclePlateCustomer`), and renamed properties keep their old physical column name via `@Column({ name: ... })`.
- Date/business-day logic uses `dayjs` with `utc`/`timezone`/`isBetween` pinned to `America/Argentina/Buenos_Aires`. New date logic must follow that, not raw `Date`/server-local time. Registrations store `entryDay`/`entryTime` as separate `date`/`time` columns — recombine them with `dayjs.tz` over a `"YYYY-MM-DD HH:mm:ss"` string, as `minutesSinceEntry` does.
- Three separate WebSocket gateways exist and should not be merged: `tickets/register-gateway.ts` (`TicketGateway`, event `new-registration`, emitted on both open and close), `customers/notification-interest-gateway.ts`, and `notes/notification-gateway.ts`.
- Image uploads go through Cloudinary (`src/libs/helpers/image-helper.ts`).
- Domain-facing code comments and all user-visible error messages are written in **Spanish** (the operators are Argentine); comments explain *why* a rule exists rather than restating the code. Match that. Structured errors use a `{ code, message }` body (`DUPLICATE_ACTIVE_PLATE`, `NO_OPEN_TURNO`, `TICKET_PRICE_BRACKET_NOT_FOUND`) so the frontend can branch on `code`.


### Tarifas configurables y claridad de uso

- Forma de cobro y Cruces de horario son optativas y viven en `pricingOptions`; Reglas de permanencia está temporalmente retirada: el backend fuerza `stay.enabled = false` para nuevas entradas, configuraciones y simulaciones, conservando los snapshots históricos; las estadías conservan una copia al ingresar. Motor compartido `stay-pricing.ts`, simulador y cierre usan el mismo cálculo.
- Los tipos de vehículo son códigos configurables (varchar), no una unión cerrada AUTO/CAMIONETA. Migración del backend previa a synchronize conserva datos. Desactivar bloquea nuevos ingresos, no salidas existentes.
- La UI debe explicar decisiones con ejemplos, ocultar campos de opciones apagadas y separar configurar precios de cobrar. El simulador acepta opciones sin guardar sin producir movimientos. El operador elige medio de pago y confirma importe antes de cerrar.
- Detalles y semántica: documentación del backend `docs/tickets-tarifas.md`. No presentar la antigua escalera como importe final cuando hay opciones avanzadas activas.
