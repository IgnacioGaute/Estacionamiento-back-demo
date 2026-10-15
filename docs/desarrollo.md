# Desarrollo y configuración

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
Jest and build; another builds and runs `test:integration` against the runner's preinstalled PostgreSQL; a third builds the ALPR Docker image and runs its Python contract tests. Railway
deploys `main` itself; with «Wait for CI» enabled on the service it only deploys a green commit.

Requires a Postgres database. `docker-compose.yaml` provides one (postgres:16.2, published on host port **5430**,
db/user/password `estacionamiento_demo`/`admin`/`admin`). Env vars read at boot: `PORT` (default 3030),
`ALLOWED_ORIGINS` (comma-separated), `POSTGRES_{HOST,PORT,NAME,USER,PASSWORD}`, `DB_BOOTSTRAP`, `NEXTAUTH_SECRET`,
`API_SECRET_TOKEN`, `ALPR_URL` / `ALPR_TOKEN` (reconocimiento propio para playas sin token; ver `alpr/README.md`), `CLOUDINARY_{NAME,API_KEY,API_SECRET}`,
`GEMINI_{API_KEY,MODEL,FALLBACK_MODELS}`,
`MERCADOPAGO_TOKEN_KEY` (32 bytes en hex, `openssl rand -hex 32`; cifra los tokens de MercadoPago de cada empresa y
los de Plate Recognizer de cada playa),
`PLATAFORMA_DATOS_PAGO` / `PLATAFORMA_WHATSAPP` (opcionales: datos de transferencia y WhatsApp que ve una empresa
en «Mi plan» para pagarle a la plataforma),
`MERCADOPAGO_PLATAFORMA_{ACCESS_TOKEN,PUBLIC_KEY,WEBHOOK_SECRET,WEBHOOK_URL}` y `PLATAFORMA_URL_FRONT` (la cuenta de
MercadoPago donde la plataforma cobra el plan; otra aplicación que la de los QR de las empresas).

Connecting an empresa's MercadoPago (`POST /mercadopago/conectar`) requires the current version of the usage
conditions (`src/mercadopago/condiciones.ts`, versioned text; never edit a published version, add a new one); the
account stores which version was accepted, by whom and when, and disconnecting clears it. Querying payments that
came into the account needs those conditions accepted and runs in the empresa's own scope — never for SUPER_ADMIN,
as the conditions promise.

**Transfer-to-alias verification** (`VerificacionAliasService`, `/mercadopago/alias/...`, rules in pure
`coincidencias.ts`; see `docs/verificacion-transferencias.md`): a cashier opens a `cobros_transferencia` attempt
(amount frozen, no charge or exit yet); the backend polls `/v1/payments/search` once per account every 4 s and, only
when there is exactly one unused transfer of that amount AND exactly one eligible attempt across all the account's
playas, records the TRANSFER movement and the exit in one transaction (`AUTOMATICO_COINCIDENCIA_UNICA`); otherwise
`REVISION` and the cashier picks (`MANUAL`). `transferencias_recibidas` is unique per (mpUserId, operacionId) and
stores no payer data. Both tables are READ empresa-wide (custom RLS policies) and attempts are WRITTEN only by their
playa. Gated three ways on every call: super admin add-on (`empresa_adicionales`, price stored but NOT billed yet),
the empresa's switch + alias on `mercadopago_cuentas`, and an ACTIVE connection with current conditions. The QR
charge is unrelated and unchanged. `TicketsService.acreditarTransferenciaEn` and the private `cerrarEnTransaccion`
let it close inside the caller's transaction — keep `closeRegistrationByPlate` going through the same path.

**QR payable from any bank or wallet** (`CajasQrService`, `mercadopago_cajas`): the old QR is the Checkout Pro
link (only the MercadoPago app or a phone camera can pay it). When a playa has a MercadoPago store + POS (created
once by the empresa ADMIN in Configuración → MercadoPago; MercadoPago requires the full address with coordinates),
`CobrosMercadoPagoService.crear` creates a dynamic Orders API order (`POST /v1/orders`, `type: qr`, idempotency key =
our cobro id) and draws its standard `qr_data` (interoperable QR); `consultar` reads the order status. Without a
POS, or if the order fails, it falls back to the link. An accredited stay QR registers the payment and, when no
saldo is left, the exit in the same transaction (`registrarPagoExterno` shares `acreditarPagoEn` with the alias
path); an ABONO QR leaves the abono paid and retired. The view's `salidaRegistrada` is read from the stay. `mercadopago_cajas` is empresa-scoped (RLS by empresa,
explicit `playaId`). MercadoPago validates the store's province/city against MercadoLibre's public
`classified_locations` list (exact spelling, accents included), so the admin activates a playa with one tap
(`POST /mercadopago/cajas/con-ubicacion`): the device location is reverse-geocoded with OpenStreetMap Nominatim
and matched to that list by `ubicacion.ts` (street/number from the playa's `direccion` first); if the city can't be
matched nothing is created and the manual form (lists, not free text) takes over.

`scripts/start-compiled.cjs` registers `tsconfig-paths` before `dist/main` — sources import each other as
`src/...`, so plain `node dist/main` only works where those paths resolve.
`node --env-file=.env scripts/assign-legacy-tenant.cjs <empresaId> <playaId>` back-fills pre-tenancy rows (backup
first, one transaction, only unassigned rows, safe to rerun).

Domain docs: `docs/tickets-tarifas.md` (tarifas y cierres), `docs/caja-turnos.md` (caja/turnos),
`docs/administracion-plataforma.md` (empresas, playas, RLS), `docs/comprobantes.md` (entrega de comprobantes),
`docs/security-review.md` (controles vigentes), `docs/planes-y-cuentas.md` (planes, vencimientos y suspensión de
empresas), `docs/verificacion-transferencias.md` (prueba de transferencias recibidas: qué está confirmado y qué
falta), `src/assistant/README.md` (asistente).

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
