# Empresas, playas y acceso a los datos

SUPER_ADMIN administra empresas, playas, usuarios y asignaciones en `/admin/empresas`.
El frontend no muestra operación, caja ni avisos a ese rol. Su acceso operativo en el
backend requiere elegir explícitamente una playa mediante `X-Playa-Id`.

## Operación por empresa y playa

- ADMIN ve los usuarios de su empresa y puede operar sus playas. USER solo puede operar
  las playas asignadas. Una cuenta sin empresa activa no accede a registros operativos.
- Cada solicitud autentica la cuenta actual en la base y valida `X-Playa-Id`. Si hay una
  sola playa autorizada se elige automáticamente; si hay varias se exige elegir una.
- Usuarios pertenecen a empresa. Clientes, recibos, cocheras, tickets, precios, vehículos,
  cajas, turnos, movimientos y avisos pertenecen a playa. Reportes y relaciones respetan
  el mismo límite. Una playa nueva comienza sin registros ni precios de otras playas.
- Al crear una playa se cargan Auto y Camioneta en su catálogo propio. Al crear un usuario
  desde el admin de empresa se asigna a esa empresa y a la playa activa.
- El selector muestra empresa y playa. Al cambiar, se valida la elección en el servidor,
  guarda una cookie por identidad y recarga la aplicación para descartar datos anteriores.
- Las conexiones de sockets se autentican y se unen a su playa. Antes de cada envío se
  revalida el acceso; usuarios revocados o con tokens vencidos dejan de recibir eventos.

## Protección de base de datos

La migración `TenantIsolation1790000001000` crea políticas PostgreSQL RLS y el rol
`parking_scoped`, sin login ni bypass de RLS. El instalador necesita permiso para crear
ese rol y concedérselo al usuario de la aplicación. Cada QueryRunner configura la empresa
 y playa de su solicitud en su propia conexión antes de ejecutar consultas. El rol y
los valores se limpian antes de devolver la conexión al pool. Aplica también a consultas
SQL, joins, agregados y transacciones explícitas de los servicios existentes.

Un subscriber y triggers asignan el scope de los registros nuevos. RLS rechaza IDs ajenos
incluso si el servicio omite un filtro. Triggers validan referencias nuevas o cambiadas,
porque las FK normales de PostgreSQL no aplican RLS. Las referencias históricas sin
cambios se conservan, incluyendo operaciones de usuarios hoy superadministradores.

Las consultas de autenticación y administración de plataforma usan la conexión interna
privilegiada. Las rutas operativas nunca admiten el token estático de servicio. Ese token
se conserva exclusivamente para las funciones de autenticación/cuentas del servidor.
No ejecutar tareas operativas de fondo sin `tenantContext.run` con destino explícito.

`synchronize` está desactivado: los cambios de esquema deben pasar por migraciones.
La migración se aplica sobre el esquema existente del proyecto; no elimina registros.

## Datos históricos y recuperación

`node --env-file=.env scripts/assign-legacy-tenant.cjs <empresaId> <playaId>` comprueba el
destino, guarda un pg_dump en `~/.codex/backups`, y asigna únicamente filas sin playa y
usuarios sin empresa (excepto SUPER_ADMIN). Es transaccional e idempotente.
En este proyecto se asignaron a Estacionamiento Calle Mitre / Playa Mitre 1543.
Las contraseñas, importes, tickets y recibos históricos se conservan.

Las bajas de usuarios son lógicas en plataforma. Empresas con historial no se borran.
Los estados/planes SaaS no implementan facturación automática. ADMIN todavía no tiene
un formulario para crear playas; SUPER_ADMIN lo hace desde la administración.

## Pruebas

- Backend: `pnpm exec tsc -p tsconfig.build.json --incremental false`.
- `node --test test/tenant-isolation.integration.cjs test/tenancy.integration.cjs test/tickets.integration.cjs`.
- Las integraciones usan clústeres PostgreSQL temporales; no leen `.env` del proyecto.
- Frontend: TypeScript, build aislado y revisión de usuarios/tickets en escritorio y móvil.
- Para ejecutar el compilado con aliases: `node scripts/start-compiled.cjs`.
