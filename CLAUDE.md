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
pnpm exec tsc -p tsconfig.build.json --incremental false   # typecheck only
```

Jest unit tests cover only the pricing engines (`src/tickets/pricing/*.spec.ts`). Run one file with
`pnpm exec jest --runInBand pricing.spec.ts` (or `stay-pricing.spec.ts`), a single case with `-t "<name>"`.

The real coverage lives in `test/*.cjs`, run with `node --test` **after `pnpm build`** (they load from `dist/`):

```bash
node --test test/tickets.integration.cjs          # pricing, cierre, caja, turnos
node --test test/tenancy.integration.cjs          # empresa/playa scoping
node --test test/tenant-isolation.integration.cjs # RLS, permisos, comprobantes públicos
node --test test/assistant.test.cjs test/gemini-request.test.cjs test/image-signature.test.cjs
```

The three `*.integration.cjs` create and remove an isolated temporary PostgreSQL cluster and never read `.env`.
Set `PG_TEST_BIN` if PostgreSQL binaries are not in `C:/Program Files/PostgreSQL/18/bin`.
Two puppeteer tests read **sibling repos** and fail without them: `test/receipt-mobile-layout.test.cjs` needs
`../estacionamiento-front-demo` and `test/parking-receipt-export.test.cjs` needs
`../estacionamiento-comprobantes-demo` (both with `node_modules` installed).

Requires a Postgres database. `docker-compose.yaml` provides one (postgres:16.2, published on host port **5430**,
db/user/password `estacionamiento_demo`/`admin`/`admin`). Env vars read at boot: `PORT` (default 3030),
`ALLOWED_ORIGINS` (comma-separated), `POSTGRES_{HOST,PORT,NAME,USER,PASSWORD}`, `DB_BOOTSTRAP`, `NEXTAUTH_SECRET`,
`API_SECRET_TOKEN`, `CLOUDINARY_{NAME,API_KEY,API_SECRET}`, `PLATE_RECOGNIZER_API_KEY`,
`GEMINI_{API_KEY,MODEL,FALLBACK_MODELS}`.

`scripts/start-compiled.cjs` registers `tsconfig-paths` before `dist/main` — sources import each other as
`src/...`, so plain `node dist/main` only works where those paths resolve.
`node --env-file=.env scripts/assign-legacy-tenant.cjs <empresaId> <playaId>` back-fills pre-tenancy rows (backup
first, one transaction, only unassigned rows, safe to rerun).

Domain docs: `docs/tickets-tarifas.md` (tarifas y cierres), `docs/caja-turnos.md` (caja/turnos),
`docs/administracion-plataforma.md` (empresas, playas, RLS), `docs/comprobantes.md` (entrega de comprobantes),
`docs/security-review.md` (controles vigentes), `src/assistant/README.md` (asistente).

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
  a non-`SUPER_ADMIN` user's empresa must be `ACTIVA`.
- `TenantGuard` (global `APP_GUARD`, `src/tenancy/tenant-access.ts`) is the real gate — controller-level
  `@UseGuards(AuthOrTokenAuthGuard)` is still present but no longer decides access on its own. It:
  - lets `PublicParkingReceiptsController.read` through unauthenticated (public comprobante links);
  - rate-limits `AuthController.login` (`src/auth/login-limiter.ts`: per-IP and per-identifier, using the
    connection IP, never a forwarded header) and requires `Bearer API_SECRET_TOKEN` for every *other*
    `AuthController` handler. The static token is now reserved for those server-side auth calls plus
    `UsersController.findAll`/`findOne` — **no operational route accepts it**;
  - restricts `UsersController` to ADMIN/SUPER_ADMIN, except a user reading or re-passwording themselves;
  - allows role `USER` only the handlers listed in `src/tenancy/endpoint-policy.ts`.
- `OPERATOR_ENDPOINTS` is an allowlist keyed by **controller class + handler name** (not URL spelling, so casing
  or a trailing slash cannot bypass it). A new handler is administrator-only until it is added there.
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

`src/turnos/` supports one shared physical cash drawer with successive shifts, regardless of calendar date. New
shifts (`cashVersion=2`) calculate expected cash from `fondoInicial + cash_entries`, covering tickets, day passes,
receipts and other cash changes. Closing records counted cash, withdrawal and a handover amount; reopening
acknowledges that handover exactly once. Transfers, checks and courtesy are excluded from physical cash. Once the
first new shift is opened, cash mutations between shifts are rejected atomically. Legacy shifts retain their
previous ticket-only calculation. See `docs/caja-turnos.md` for adoption and API contracts.

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
bytes so a disguised document is rejected before anything parses it.

### Comprobantes (parking receipts)

`src/tickets/parking-receipts.service.ts` + `PublicParkingReceiptsController`. Per-playa delivery channels live in
`TicketScheduleSettings.receiptDelivery` (`{whatsapp, qr, print, paperWidth: 58|80}`, all off by default).
Issuing freezes a `snapshot` and a random 256-bit token; `ParkingReceipt` is unique per
`playaId + registrationId + kind` (`ENTRY`/`EXIT`), so a retry reuses the same link instead of charging again.
`GET /public/parking-receipts/:token` is the only unauthenticated route in the app: it returns vehicle, playa,
times and amounts — never users or internal movements — with `no-store`/`noindex` headers. Its only consumer is
`../estacionamiento-comprobantes-demo`, a separate Next app on its own domain whose whole job is rendering that
response (`/c/<token>`), so the link a customer receives never exposes the system's domain. It fetches
server-side, so no CORS entry is needed for it. See `docs/comprobantes.md`.

### Assistant (Gemini)

`src/assistant/` is an operator-facing chat (`POST /assistant/chat`, plus an SSE `chat/stream` that still buffers
the whole answer before emitting it). The Google key stays server-side. The model gets **read-only tools only** —
no SQL, no mutations — and every tool execution re-checks the tenant scope. `knowledge.ts` is versioned product
guidance that must be updated when screens, rules or permissions change. History and rate limits (8
questions/minute, one concurrent per user/playa) are per-process in memory; multiple instances would need shared
storage. `gemini-request.ts` owns retries and fallback models within a 65s budget. See `src/assistant/README.md`.

### Receipts / customers / parking / saas

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

`src/saas/` (`Plan`, `Suscripcion`, `FacturaSaas`) is what the platform bills the empresa for using the system —
not what a playa bills its abonados (that is `receipts`). Entities only; no controller yet.

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
