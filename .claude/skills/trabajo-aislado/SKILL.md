---
name: "trabajo-aislado"
description: "Preparar una rama y worktree para una tarea simultánea en estacionamiento, ubicando repos hermanos y dependencias de pruebas."
---

# Trabajo simultáneo
1. Leer git status y git worktree list. Elegir un nombre de tarea nuevo; no reutilizar ni borrar un árbol ajeno.
2. Crear un worktree con rama propia cuando la tarea requiere editar en paralelo. Usar el mecanismo nativo
   de Claude o git worktree add -b <rama> .worktrees/<tarea> <base-verificada>, con argumentos concretos.
3. Los cambios sin commit no viajan con HEAD. No copiar, stashear ni descartar trabajo ajeno automáticamente.
4. Instalar con pnpm install --frozen-lockfile si faltan dependencias. Las integraciones usan PostgreSQL
   temporal; para dev resolver configuración local sin copiar secretos a archivos versionados.
5. Localizar repos hermanos desde el checkout principal; tests que codifican ../ requieren topología
   compatible. Si la tarea cambia varios repos, usar un directorio de tarea con cada checkout hermano
   o documentar y resolver explícitamente las rutas antes de ejecutar esos tests.
6. Antes de integrar, revisar diff y pruebas. Eliminar el worktree solo cuando esté limpio y su trabajo
   esté conservado; no usar limpieza forzada para resolver cambios inesperados.
