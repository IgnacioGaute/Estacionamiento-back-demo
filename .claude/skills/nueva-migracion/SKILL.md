---
name: "nueva-migracion"
description: "Crear o revisar una migración TypeORM del estacionamiento conservando datos legacy, registro explícito y aislamiento empresa/playa."
---

# Cambio de esquema
1. Leer AGENTS.md, docs/desarrollo.md, src/config/database.config.ts, entidades y migraciones del dominio.
2. Definir cómo se actualizan filas existentes, defaults/nullabilidad, índices y restricciones.
   Inspeccionar nombres físicos reales; ParkingOwner usa vehicles y ParkingRenter vehicle_renters.
3. Crear una clase con identificador único conforme al repositorio e importarla en el array explícito.
   No reescribir migraciones ya aplicadas ni activar DB_BOOTSTRAP/synchronize en una base con datos.
4. Para datos tenant comprobar scope, backfill, RLS forzada, grants y triggers que validan referencias.
   Definir si el alcance es playa o empresa; no copiar una política sin verificar esa diferencia.
5. Probar upgrade y operaciones con el rol scoped sobre PostgreSQL temporal. Cubrir datos previos,
   acceso cruzado, escritura válida y rechazo esperado. Registrar la suite en test:integration si es nueva.
6. Revisar el impacto del arranque automático: locks, tiempo y compatibilidad de consumidores.
   Explicar reversibilidad real y recuperación; no prometer un down seguro si pierde datos.
7. Ejecutar /verificar-cambio para el alcance. Pedir al revisor-aislamiento una revisión independiente
   si cambia el límite entre tenants. El revisor informa hallazgos; quien implementa aplica los cambios.
