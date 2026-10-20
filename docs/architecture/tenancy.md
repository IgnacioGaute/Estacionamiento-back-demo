# Referencia técnica: tenancy

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
- Sockets: all gateways (tickets, notes, interest and `PlayaConfigGateway`) go through `TenantSocketAccess` (`src/tenancy/tenant-socket.ts`), which verifies the
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
  - restricts `UsersController` to ADMIN/SUPER_ADMIN, except a user reading or re-passwording themselves.
    A role change (`PATCH /users/:id { role, playaId? }`, `UsersService.cambiarRol`) runs outside the playa
    scope (like operator assignments: `usuario_playas` and `turnos` are filtered by the current playa) with every
    query bound to the account's empresa. It locks the empresa's admins, rejects changing one's own role
    (`ROL_PROPIO`), leaving no admin (`ULTIMO_ADMIN`, also against two admins demoting each other), a demotion
    without a determinable playa (`PLAYA_REQUERIDA`) or with an open turno in another playa (`TURNO_ABIERTO`),
    rewrites `usuario_playas` (one `OPERADOR` row, or `ENCARGADO` on promotion) and bumps `authVersion` so the
    account signs in again with the new role;
  - allows role `USER` only the handlers listed in `src/tenancy/endpoint-policy.ts`.
- `OPERATOR_ENDPOINTS` is an allowlist keyed by **controller class + handler name** (not URL spelling, so casing
  or a trailing slash cannot bypass it). A new handler is administrator-only until it is added there.
  `endpoint-policy.spec.ts` fails if a name in `OPERATOR_ENDPOINTS`/`SUSPENDED_ENDPOINTS` is not a real method of
  that controller (a rename would otherwise surface as 403s in production); `tenant-access.spec.ts` covers the
  guard's decisions per role and empresa state.
- Endpoints that write money still need a real user on top of all this:
  `if (!req.user?.userId) throw new UnauthorizedException(...)` (see `TicketsController.closeRegistrationByPlate`,
  `requireUserId` in `TurnosController`) — `Movimiento.usuario` is not nullable.

### Modalidad de operación (con cobro / gratuito)

`playas.modalidad` is set only by the super admin (`PATCH /tenancy/playas/:id/modalidad`; `parking_scoped` only reads
`playas`). `TenantScope.modalidad` carries it; `TenantInterceptor` answers `403 MODALIDAD_GRATUITA` to the handlers in
`FREE_MODE_BLOCKED` (`endpoint-policy.ts`, class + handler like the other lists) when the playa is GRATUITO, for every
role. A new money or receipt handler must be added there; `endpoint-policy.spec.ts` checks the names. Money funnels
re-check inside their transaction with `exigirCobro` (`src/tenancy/modalidad.ts`). See `docs/modalidad-gratuita.md`.
