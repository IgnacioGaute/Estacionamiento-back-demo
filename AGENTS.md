# Estacionamiento — instrucciones del backend

## Proyecto y alcance

API NestJS 10, TypeScript, TypeORM/PostgreSQL y Socket.IO. Usar pnpm 9.15.4.
Cada dominio está en src/<dominio>/ con controller, service, DTO y entities.
Responder al usuario en español. Mensajes del producto y comentarios del dominio en español argentino.
Los comentarios explican decisiones; conservar el estilo del archivo y evitar reformateos ajenos.

Repos hermanos, rutas relativas al checkout principal:
- ../estacionamiento-front-demo: interfaz Next.js/React de operadores y administradores.
- ../estacionamiento-comprobantes-demo: comprobantes públicos, impresión y exportación.
- ../estacionamiento-landing: presentación y catálogo público de planes.
En worktrees esas rutas pueden no existir: localizar los checkouts con git worktree list
y agregar los directorios necesarios explícitamente; no crear reemplazos vacíos.
Antes de editar otro repo, leer sus instrucciones y revisar su estado.

## Reglas que siempre importan

- Empresa es el límite de aislamiento; playa es el ámbito operativo. Conservar permisos,
  tenantContext, RLS, grants, triggers y validación de referencias entre tenants.
- Cobro, movimiento, caja y cierre deben conservar su atomicidad e idempotencia.
  Corregir libros contables con movimientos de ajuste, no reescribiendo historia.
- Cambios de esquema mediante migraciones registradas en src/config/database.config.ts.
  DB_BOOTSTRAP es solo para una base local nueva; las migraciones corren al arrancar.
- Tarifas históricas usan snapshots. Tipos de vehículo configurables; desactivar no impide salir.
- Fechas de negocio: America/Argentina/Buenos_Aires con las utilidades dayjs existentes.
- DTOs y errores estructurados { code, message }; no romper contratos de consumidores.
- Tokens de terceros permanecen en backend. El asistente del producto usa Gemini y herramientas
  de solo lectura; actualizar src/assistant/knowledge.ts si cambia la ayuda del producto.

## Trabajo existente y Git

- Revisar git status y el diff antes de editar; preservar cambios del usuario y de otras sesiones.
- Si hay sesiones que escribirán simultáneamente, usar ramas/worktrees separados por tarea.
  No trasladar automáticamente cambios sin commit a otro árbol.
- Cuando corresponda un commit, usar git add -- <archivos concretos> y revisar
  git diff --cached --name-only y git diff --cached. No git add -A, git add ., git add -u
  ni git commit -a: ya hubo una migración incompleta de otra sesión incorporada por accidente.
- Editar mediante herramientas de parches/edición con UTF-8. Evitar Get-Content | Set-Content
  y scripts inline con template literals: hubo corrupción de acentos y backticks en Windows.
- Mostrar la salida de comandos en la terminal por defecto. Crear logs solo si hacen falta para
  procesos en segundo plano o diagnóstico, dentro de .tmp/logs/<tarea>/; nunca en la raíz.
  Guardar otros auxiliares de la tarea en .tmp/. Al terminar, retirar solo los propios que ya
  no hagan falta; no mover ni borrar logs abiertos por procesos activos ni archivos de otra sesión.
- La autorización de implementar no implica publicar o desplegar. Si el usuario ya autorizó
  commit/push/deploy para la tarea, continuar sin pedir nuevamente; verificar destino y diff.

## Verificación

Comandos exactos en package.json; CI en .github/workflows/ci.yml.
- pnpm typecheck: incluye specs; Jest transpila y no demuestra ausencia de errores de tipos.
- pnpm lint:ci: lectura, sin correcciones; pnpm lint y pnpm format sí modifican archivos.
- pnpm test <archivo.spec.ts>: unitarios. Para un caso: pnpm test -- -t "nombre".
- pnpm build antes de pruebas test/*.cjs que importan dist/.
- pnpm test:integration: suites autocontenidas, PostgreSQL temporal, sin leer .env.
  PG_TEST_BIN permite ubicar los binarios; no sustituirlo por una conexión a producción.
- pnpm test:agents: configuración de agentes y pruebas de hooks, sin base ni red.
- Tests de UI bajo test/ pueden necesitar frontend/comprobantes y sus node_modules.
  No afirmar que CI los ejecuta: elegirlos según el cambio.
Ejecutar comprobaciones proporcionales a la tarea y reportar comandos, resultado y limitaciones.
No repetir suites exitosas sin cambios o un motivo concreto. Un bloqueo de entorno no es un pase.

## Referencias por tarea

Leer solo las filas relevantes; estas rutas no se importan automáticamente.

| Cambio | Referencias |
| --- | --- |
| Configuración, arranque, variables, CI | docs/desarrollo.md |
| Permisos, empresa/playa, sockets | docs/architecture/tenancy.md; docs/administracion-plataforma.md |
| Cobros, cierre, caja, turnos | docs/architecture/caja.md; docs/caja-turnos.md; docs/comisiones-caja.md |
| Tarifas y snapshots | docs/architecture/tarifas.md; docs/tickets-tarifas.md |
| Inquilinos, cargos, pagos y anulaciones | docs/architecture/cuentas.md |
| MercadoPago, QR y alias | docs/desarrollo.md; docs/verificacion-transferencias.md |
| SaaS y suscripciones | docs/architecture/saas.md; docs/planes-y-cuentas.md |
| Patentes y ALPR | docs/architecture/patentes.md; alpr/README.md |
| Comprobantes | docs/architecture/comprobantes.md; docs/comprobantes.md |
| Clientes y cocheras | docs/architecture/clientes.md |
| Asistente Gemini | docs/architecture/asistente.md; src/assistant/README.md |
| Offline | docs/pwa-offline.md |
| Herramientas de Claude y trabajo entre repos | docs/claude-workflow.md |

El código y sus pruebas describen el comportamiento vigente. Si una referencia los contradice,
verificar la intención y corregir la documentación; no revertir una función solo para coincidir con una nota vieja.
