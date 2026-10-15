---
paths:
  - "src/database/migrations/**"
  - "src/config/database.config.ts"
  - "src/**/*.entity.ts"
---

# Migraciones
- Leer docs/desarrollo.md; usar /nueva-migracion para cambios de esquema.
- Registrar clase y orden en el array explícito de database.config.ts; un archivo nuevo solo no corre.
- Preservar datos existentes y nombres físicos legacy; no activar synchronize para resolver un upgrade.
- Revisar el uso ya desplegado antes de editar una migración existente: normalmente agregar otra.
- Probar contra PostgreSQL temporal y comprobar grants/RLS con el rol operativo, no solo el dueño.
