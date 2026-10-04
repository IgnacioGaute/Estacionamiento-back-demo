# Estacionamiento: API

API REST (NestJS 10 + TypeORM + PostgreSQL) del sistema de gestión de playas de estacionamiento. Es
multiempresa: cada **empresa** tiene sus **playas**, y la base aísla los datos de cada una con Row Level
Security. La interfaz de los operadores está en `estacionamiento-front-demo`.

## Levantarlo en local

```bash
pnpm install
docker compose up -d   # PostgreSQL 16 en el puerto 5430 (base, usuario y clave: estacionamiento_demo / admin / admin)
pnpm dev               # API en http://localhost:3030, se reinicia al guardar
```

Las variables de entorno van en `.env`; la lista completa está en [CLAUDE.md](CLAUDE.md). Con una base
vacía, el primer arranque se hace con `DB_BOOTSTRAP=true` para crear las tablas. Después hay que apagarlo:
encendido contra una base real puede borrar columnas. Las migraciones corren solas en cada arranque.

## Tests

Hay tres niveles:

| Nivel | Dónde | Qué usa | En el CI |
|---|---|---|---|
| Unitarios | `src/**/*.spec.ts` | Jest, sin base de datos | Sí |
| Integración | `test/*.integration.cjs` y otros `test/*.test.cjs` | `node --test` contra un PostgreSQL real | Sí |
| Interfaz | el resto de `test/*.cjs` | puppeteer y los repos vecinos | No, solo en local |

```bash
pnpm test                              # unitarios (unos 10 s)
pnpm test pricing                      # solo los archivos que coinciden con "pricing"
pnpm test -- -t "tolerancia"           # solo los casos cuyo nombre contiene "tolerancia" (el -- es necesario)
pnpm build && pnpm test:integration    # integración (alrededor de 1,5 min); usan lo compilado en dist/
pnpm typecheck && pnpm lint:ci         # tipos y lint, como en el CI
```

### Unitarios

Prueban reglas y cálculos sin base de datos: muchos casos en milisegundos. Cuando hace falta un
servicio, se le pasan repositorios simulados.

| Archivo | Qué cubre |
|---|---|
| `tickets/pricing/pricing.spec.ts` | Tarifas por tramos: horario diurno y nocturno (también cruzando medianoche), tolerancia, tramo adicional, validación de tramos. |
| `tickets/pricing/stay-pricing.spec.ts` | Forma de cobro configurable: fracciones, tolerancia, cruces de horario y la explicación del importe. |
| `tickets/planned-payment.spec.ts` | Estadía con precio fijado al ingresar: descuenta lo anticipado y no cobra menos que el anticipo. |
| `tickets/offline-shift.spec.ts` | Cobros del modo sin conexión: a qué turno se imputan al sincronizar. |
| `tickets/utils/license-plate.util.spec.ts` | Patentes: normalización, búsqueda que tolera confusiones (B/8, O/0, I/1, S/5) y formatos vigentes. |
| `turnos/turnos.service.spec.ts` | Apertura de turno: toma el nombre del usuario autenticado, no el que se envía. |
| `movimientos/movimientos.service.spec.ts` | Libro de caja: motivo obligatorio en ajustes y cortesías, turno de cada movimiento, total cobrado sin cortesías. |
| `cuentas/anulacion.spec.ts` | Cuenta corriente de inquilinos: qué se puede anular y hasta cuándo. |
| `saas/estado-cuenta.spec.ts` | Cuenta de la empresa con la plataforma: prueba gratis, vencimiento, días de atraso, suspensión, días extra. |
| `auth/login-limiter.spec.ts` | Límite de intentos de login, por IP y por usuario. |
| `tenancy/tenant-access.spec.ts` | Permisos: qué puede llamar cada rol y qué puede hacer una empresa suspendida. |
| `tenancy/endpoint-policy.spec.ts` | Las listas de permisos nombran métodos que existen: renombrar uno sin actualizar la lista hace fallar el test. |

### Integración

Cada archivo crea un cluster de PostgreSQL temporal, corre las migraciones, prueba flujos completos
(base, transacciones, RLS) y lo borra al terminar. No leen `.env`. Si los binarios de PostgreSQL no están en
`C:/Program Files/PostgreSQL/18/bin`, indicá dónde con `PG_TEST_BIN`.

| Archivo | Qué cubre |
|---|---|
| `tickets.integration.cjs` | Ingreso, cierre y cobro de estadías; caja diaria y turnos. |
| `tenancy.integration.cjs` | Altas, ediciones y bajas de empresas, playas y usuarios; asignación de playas; modo sin conexión. |
| `tenant-isolation.integration.cjs` | Aislamiento entre empresas (RLS), permisos por rol, comprobantes públicos, sockets, empresa suspendida. |
| `suscripciones.integration.cjs` | Planes, prueba gratis, facturas, atraso, suspensión y pagos a la plataforma. |
| `cuentas.integration.cjs` | Cuenta corriente de inquilinos: abonos, pagos, devoluciones, anulaciones (motivo e importe), cobro con QR. |
| `tariff-plan.integration.cjs` | Editor de tarifas: simulador sin guardar, aplicar, guardados simultáneos, rollback ante un error. |
| `assistant.test.cjs` | Asistente: herramientas limitadas a la playa del usuario, historial por usuario, sin clave falla sin consultar. |
| `gemini-request.test.cjs` | Reintentos y modelos de respaldo cuando Gemini falla. |
| `image-signature.test.cjs` | Lectura de patentes: rechaza documentos disfrazados de imagen. |

> **Windows:** corré los de integración desde una ruta que empiece con `C:\` en mayúscula. Con `c:\`, Node
> carga las entidades dos veces y todo falla con «No metadata for "Empresa"».

Un archivo nuevo de este tipo tiene que sumarse al script `test:integration` de `package.json`; si no,
el CI no lo corre.

### Solo en local

Usan puppeteer y leen archivos de los repos vecinos (`../estacionamiento-front-demo` y
`../estacionamiento-comprobantes-demo`, con `node_modules` instalado), por eso el CI no los corre.

| Archivo | Qué cubre |
|---|---|
| `receipt-mobile-layout.test.cjs` | El comprobante en el celular: diálogo, QR y botones no desbordan. |
| `receipt-history-panel.test.cjs` | Historial de comprobantes: arranca en hoy, abonos y fechas en hora de Argentina. |
| `parking-receipt-export.test.cjs` | Exportar comprobantes y recibos de inquilinos a PNG y PDF sin cortar textos. |
| `pwa-offline.test.cjs` | Modo sin conexión de la PWA: entradas, salidas, datos cifrados y reintento de sincronización. |
| `assistant-message-render.test.cjs` | Mensajes del asistente: muestra negritas y no interpreta HTML. |
| `tariff-editor-rules.test.cjs` | Reglas del editor de tarifas del front. |
| `admin-frequent.ui.cjs`, `admin-tariffs.ui.cjs` | Pantallas de frecuentes y de tarifas, también en ancho móvil. |

## CI/CD

[.github/workflows/ci.yml](.github/workflows/ci.yml) corre en cada push a `main` y en cada pull request. Lo
hace en dos partes en paralelo:

1. **Verificación:** tipos, lint, tests unitarios y build.
2. **Integración:** build y `test:integration` contra el PostgreSQL del runner.

El deploy lo hace Railway con cada push a `main`. Con «Wait for CI» activado en el servicio, solo despliega
un commit que pasó el CI.

## Más documentación

- [CLAUDE.md](CLAUDE.md): arquitectura, multiempresa, permisos y convenciones.
- [docs/](docs/): tarifas, caja y turnos, administración de la plataforma, comprobantes, planes y cuentas, seguridad.
