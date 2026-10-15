# Claude Code en estacionamiento

Configuración de proyecto preparada para Node 20 y Claude Code 2.1.252, sin plugins
adicionales ni instalación de paquetes para los hooks. Se usan eventos y campos
compatibles con esa versión, sin depender del soporte nativo reciente de AGENTS.md.

## Qué se carga y dónde se mantiene

```text
CLAUDE.md                         Importa AGENTS.md explícitamente
AGENTS.md                         Reglas comunes y mapa del proyecto (<200 líneas)
.claude/
  settings.json                   Permisos portables y registro de hooks
  settings.local.json             Excepciones personales, ignorado
  rules/*.md                      Reglas condicionadas por paths
  skills/<nombre>/SKILL.md         Procedimientos que Claude puede descubrir
  agents/*.md                     Revisores con Read, Grep y Glob
  hooks/project-hooks.cjs         Implementación de los tres hooks
  hooks/*.test.cjs                Pruebas de comportamiento y configuración
  worktrees/                      Worktrees nativos de Claude, ignorados
.worktrees/                       Alternativa manual, ignorada
docs/desarrollo.md                Comandos, variables y detalles de entorno
docs/architecture/*.md            Conocimiento técnico trasladado del CLAUDE anterior
```

CLAUDE.local.md es opcional y está ignorado; no se crea uno vacío. Las reglas sin
paths cargarían siempre: aquí las reglas están acotadas a los archivos pertinentes.
Las referencias técnicas se leen a demanda; no se importan todas desde CLAUDE.md.
Los agentes que solo entienden AGENTS.md tienen una tabla de referencias equivalente.

Las notas automáticas de ~/.claude/projects son memoria personal, no una fuente
compartida de estado del producto. Se promovieron al repo las reglas de staging
explícito y edición UTF-8; comprobar contra código las notas antiguas de pendientes.

## Skills del backend

| Comando | Uso |
| --- | --- |
| /verificar-cambio | Seleccionar y ejecutar pruebas por dominio; compilar antes de dist; informar resultados reales. |
| /nueva-migracion | Cambio de esquema, datos previos, registro de clase, RLS/grants/triggers y PostgreSQL temporal. |
| /cambio-api | Cambiar DTOs, endpoints o sockets junto con consumidores, permisos y compatibilidad. |
| /revisar-cambio | Elegir revisión independiente por riesgo, confirmar hallazgos y verificar correcciones. |
| /preparar-release | Preparar diff, pruebas y migraciones; publicar solo dentro de la autorización de la tarea. |
| /trabajo-aislado | Preparar worktree, ubicar checkouts hermanos y preservar cambios de otras sesiones. |

Las skills tienen selección implícita habilitada: no es obligatorio recordar el comando.
También pueden invocarse explícitamente. Crear una skill no significa que se ejecute
en cada turno; las descripciones delimitan cuándo resulta útil.

Ejemplos:

```text
/verificar-cambio Revisá los cambios de esta tarea en tickets y caja.
/nueva-migracion Agregá el campo solicitado conservando filas existentes y RLS.
/cambio-api Actualizá este contrato y sus consumidores del frontend.
/revisar-cambio Revisá el cierre por transferencia y sus reintentos.
/preparar-release Prepará una entrega verificable de esta tarea.
```

## Revisores

| Agente | Revisa |
| --- | --- |
| revisor-aislamiento | Auth, empresa/playa, permisos, RLS, referencias cruzadas y sockets. |
| revisor-cobros | Transacciones, caja, ledger, tarifas, idempotencia y MercadoPago. |
| revisor-contratos | Consumidores, contratos, despliegue separado y cobertura de pruebas. |

Solo tienen Read/Grep/Glob: no disponen de shell, edición, pagos ni despliegues.
Heredan el modelo elegido para la sesión y tienen un máximo de 16 turnos.
El agente principal proporciona el diff y ejecuta los tests; los revisores no deben
afirmar que los ejecutaron. No se fuerza una revisión múltiple para cambios triviales.

## Hooks automáticos

| Evento | Comportamiento |
| --- | --- |
| SessionStart | Consulta rama y estado del checkout activo, señala cambios existentes y recuerda aislar sesiones concurrentes. |
| PreToolUse (Bash/PowerShell) | Rechaza formas habituales de staging masivo: git add -A/--all/-u, git add ./*/:/ y git commit -a. Sugiere rutas explícitas. |
| PostToolUse (Edit/Write/MultiEdit) | Tras editar migraciones o controllers del backend, recuerda registro/RLS o contratos/permisos. |

Los scripts leen JSON por stdin y devuelven el formato de hooks de Claude. No leen
.env, no llaman servicios ni modelos, no cambian archivos y no ejecutan suites pesadas.
Las consultas a Git usan execFile con argumentos y timeout; no interpolan comandos.
Las pruebas también verifican que comandos permitidos no devuelvan una aprobación
que saltee los permisos normales de Claude.

El guard de staging evita accidentes comunes; no es un parser completo de shell
ni una frontera de seguridad. No analiza scripts externos, aliases, comandos
construidos dinámicamente o todos los pathspecs posibles. Los recordatorios de
PostToolUse cubren las herramientas indicadas, no cambios hechos por un script de shell.
Si un hook falla, el comportamiento depende del evento/versión de Claude; no se
promete bloqueo ante fallos. Git y CI siguen siendo necesarios.

No hay un Stop hook que obligue a repetir tests o bloquee respuestas por cambios
preexistentes. La validación completa se ejecuta con la skill apropiada y en CI.

## Git, permisos e integraciones

Se eliminó del settings compartido el historial de permisos y rutas de otros proyectos.
Solo se preautorizan consultas Git y comandos habituales de comprobación. No se
agregaron permisos globales de shell ni bypassPermissions.
Los permisos globales existentes de tu usuario siguen aplicándose según la precedencia
de Claude: esta limpieza de proyecto no revoca excepciones globales de otros trabajos.

.claude/ deja de estar ignorada en bloque. Se comparten reglas, skills, revisores,
hooks y settings; solo se ignoran configuración local, memoria local y worktrees.
Los archivos deben entrar en un commit para viajar a otra máquina; esta instalación
no crea un commit ni cambia remotos automáticamente.

La salida de comandos se muestra en terminal por defecto. Si un proceso en segundo
plano o un diagnóstico necesita archivos de log, guardarlos en .tmp/logs/<tarea>/,
nunca en la raíz. Los hooks de esta configuración no crean archivos de log. Al
terminar una tarea, retirar únicamente sus auxiliares innecesarios y conservar
los archivos de otras sesiones o que sigan abiertos por un proceso.

Playwright y Pencil ya estaban declarados en la configuración global de esta máquina.
No se duplicaron en un .mcp.json ni se agregaron servicios con credenciales. En otra
máquina, conectar los que se necesiten y confirmar su estado con /mcp. Los hooks y
la validación del backend no dependen de MCP. Tener un servidor declarado no prueba
que esté conectado; la skill visual informa si no hay navegador disponible.

## Frontend y otros repositorios

El frontend tiene su propio AGENTS.md, reglas, hooks y documentación. Sus skills son
/verificar-cambio, /verificar-interfaz, /react-doctor y /trabajo-aislado; sus revisores
son revisor-frontend y revisor-contratos. React Doctor usa un adaptador a la fuente
versionada en .agents/skills/react-doctor, evitando otra copia del playbook.

Los dos repos principales incluyen pnpm test:agents en su CI. Los hooks se copian
en ambos para que cada clone funcione sin depender del repo hermano; al cambiar
su implementación común, aplicar el mismo cambio y ejecutar sus pruebas en ambos.

Los repos de comprobantes y landing tienen instrucciones ligeras propias para sus
contratos y verificación. No requieren replicar revisores financieros o de RLS.

## Trabajo simultáneo

Usar una rama y worktree por tarea concurrente. El worktree nace de un commit;
no incluye cambios sin commit del árbol original. No stashear ni trasladar trabajo
ajeno automáticamente. Los archivos settings.local.json y .env ignorados no viajan.

Los tests de UI del backend resuelven repos hermanos mediante ../. Para tareas
entre repos, preparar una topología de checkouts hermanos dentro del directorio
de la tarea o resolver esas rutas explícitamente. Un worktree anidado bajo
.claude/worktrees no recrea esa topología por sí solo.

No se crea un worktree vacío durante esta configuración: usar /trabajo-aislado
cuando exista una tarea concreta. No borrar árboles con trabajo pendiente.

## Verificación y uso

```bash
pnpm test:agents
```

Se prueban descubrimiento/frontmatter, patrones de reglas, hooks registrados,
configuración portable, importación de AGENTS.md, política de ignorados y conexión
con CI. El parser YAML se reutiliza de la instalación existente de ESLint. No se
agregan paquetes. Las pruebas de hooks usan un repositorio Git temporal sin red.

Abrir una sesión nueva de Claude en el repo y comprobar:
- /context o /memory: CLAUDE.md e importación de AGENTS.md.
- /agents: revisores del proyecto.
- /hooks: eventos registrados.
- /mcp: conexiones disponibles si la tarea requiere navegador/diseño.

Claude puede pedir confiar en la carpeta antes de ejecutar hooks de proyecto.
La configuración de este repo no controla las herramientas de otra aplicación de IA.
Las pruebas locales comprueban scripts y archivos; la carga efectiva de una sesión
se confirma dentro de Claude, sin asumirla por la mera existencia de los archivos.

Documentación oficial consultada:
- https://code.claude.com/docs/en/memory
- https://code.claude.com/docs/en/skills
- https://code.claude.com/docs/en/sub-agents
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/settings
