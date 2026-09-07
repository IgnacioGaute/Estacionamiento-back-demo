# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager is **pnpm** (`packageManager: pnpm@9.15.4`).

```bash
pnpm install              # install dependencies
pnpm dev                  # start with watch mode (nest start --watch)
pnpm build                # compile (nest build)
pnpm start:prod           # run compiled output (node dist/main)
pnpm lint                 # eslint --fix over src/apps/libs/test
pnpm format               # prettier --write src/test
pnpm test                 # jest unit tests (rootDir: src, matches *.spec.ts)
pnpm test:watch           # jest watch mode
pnpm test:cov             # jest with coverage
pnpm test:e2e             # e2e tests via test/jest-e2e.json
```

Run a single unit test: `pnpm test -- path/to/file.spec.ts` (or `-t "test name"` to filter by name). Note: there are currently no `*.spec.ts` files in `src/`, so unit-test infra is configured but unused.

Requires a Postgres database; connection is read from env vars (`POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_NAME`, `POSTGRES_USER`, `POSTGRES_PASSWORD` — see `src/config/database.config.ts`). `docker-compose.yaml` / `Dockerfile` are available for containerized runs.

## Architecture

NestJS 10 REST API (+ Socket.IO gateways) for a parking-lot ("estacionamiento") management system, backed by TypeORM/Postgres. Each domain lives in `src/<domain>/` with the standard Nest module layout: `*.module.ts`, `*.controller.ts`, `*.service.ts`, `dto/`, `entities/`.

Modules (wired in `src/app.module.ts`): `receipts`, `scanner`, `tickets`, `box-lists`, `customers`, `users`, `auth`, `notes`.

### Domain flow

- **Barcode scanning is the entry point for the whole shop-floor workflow.** `ScannerService.start()` (`src/scanner/scanner.service.ts`) inspects the scanned code: an 11–15 digit numeric code is treated as a **receipt** barcode (looked up via `ReceiptsService`), anything else is treated as a **ticket** barcode (looked up via `TicketsService.findTicketByCode`, then registered via `TicketsService.createRegistration`).
- **Tickets** (`src/tickets/`) model parking sessions. `Ticket` is the physical/reusable barcode; `TicketRegistration` is a single entry/exit event tied to a ticket (created on first scan, closed/priced on the matching second scan — see `TicketsService.createRegistration` / `updateRegistration`); `TicketRegistrationForDay` is the separate flow for pre-paid day/week parking (`createRegistrationForDay`), priced from `TicketPrice` rows (per vehicle type × time type: `DIA`, `SEMANA`, `SEMANA_Y_DIA`). New registrations are broadcast over WebSocket via `TicketGateway` (`register-gateway.ts`, event `new-registration`).
- **Box lists** (`src/box-lists/`, `BoxListsService`) are the daily cash register ("caja"): one `BoxList` per calendar date (Argentina timezone, `America/Argentina/Buenos_Aires`), auto-created on first payment of the day and incremented via a pessimistic-lock query on `boxNumber` to avoid races. Ticket payments, day/week registrations, receipts, and ad-hoc `OtherPayment` (ingresos/egresos) all roll up into a box's `totalPrice`. Box lookups (`findBoxByDate`/`findOne`) eagerly load a deep relation graph (receipts → customers → vehicles/renters → payment history) — extend carefully, this is already a heavy query.
- **Receipts / customers** (`src/receipts/`, `src/customers/`): recurring-customer billing (monthly parking, vehicle renters, receipt payments, payment-history-on-account). `Customer` has `vehicles`/`vehicleRenters`; `Receipt` ties a customer to a box list and barcode. `CustomersModule` also exposes a separate `notification-interest-gateway.ts` WebSocket gateway, distinct from `NotesModule`'s `notification-gateway.ts`.
- **Notes** (`src/notes/`) are freeform pinned notes with their own WebSocket notification gateway.

### Auth

- `AuthService`/`AuthController` (`src/auth/`) handle login (by email or username, bcrypt-compared password) and email-verification / password-reset token issuance — but this backend does **not** itself mint the JWTs users authenticate with. `JwtStrategy` (`src/utils/strategies/jwt.strategy.ts`) validates bearer tokens signed with `NEXTAUTH_SECRET`, i.e. tokens are expected to come from a NextAuth-based frontend.
- Two other guard styles exist for machine-to-machine / hardware (scanner) access: `TokenGuard` checks a static bearer token against `API_SECRET_TOKEN`; `AuthOrTokenAuthGuard` (`src/utils/guards/auth-or-token.guard.ts`) accepts either a valid JWT or the static secret token, and is what most controllers (e.g. `TicketsController`) actually use via `@UseGuards(AuthOrTokenAuthGuard)`.

### Config & cross-cutting

- Config is loaded through `@nestjs/config` with `registerAs` namespaces in `src/config/` (`app`, `database`), merged in `src/config/index.ts` and registered globally in `AppModule`.
- `main.ts` applies `helmet()`, CORS restricted to `app.allowedOrigins`, a global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`, and serves `uploads/` as static assets at `/uploads`.
- `TypeOrmModuleOptions.synchronize` is currently `true` (schema auto-sync, no migrations run in normal dev flow) — see the `TODO` in `database.config.ts` before assuming migrations under `db/migrations` are authoritative.
- Timestamps/business-day logic throughout `tickets` and `box-lists` services use `dayjs` with the `utc`/`timezone`/`isBetween` plugins pinned to `America/Argentina/Buenos_Aires`; keep new date logic consistent with that rather than using raw `Date`/server-local time.
- Image uploads go through Cloudinary (`src/libs/helpers/image-helper.ts`, `CLOUDINARY_*` env vars).
- License-plate recognition from a photo (`src/plate-recognition/`) proxies to the Plate Recognizer ANPR API (`PLATE_RECOGNIZER_API_KEY` env var) so the key never reaches the browser — used by the mobile "scan plate with camera" button in the frontend's entry-by-plate dialog.
