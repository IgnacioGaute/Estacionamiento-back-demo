---
name: "verificar-cambio"
description: "Seleccionar y ejecutar las pruebas del backend de estacionamiento después de un cambio; incluye PostgreSQL temporal y dependencias entre repos."
---

# Verificar un cambio
1. Leer AGENTS.md, package.json, git status y el diff de la tarea. Separar cambios preexistentes.
2. Elegir por impacto:
   - TypeScript: typecheck, lint:ci y unitarios del dominio.
   - Cobros/caja: tickets y/o cajas.integration.cjs; cuentas si afecta inquilinos.
   - Permisos, entidades tenant o SQL: tenancy y tenant-isolation.integration.cjs.
   - Tarifas: pricing/stay-pricing y tariff-plan.integration.cjs.
   - SaaS: estado-cuenta y suscripciones.integration.cjs.
   - Alias: coincidencias y verificacion-alias.integration.cjs.
   - Asistente: assistant.test.cjs y gemini-request.test.cjs.
   - Configuración de Claude: pnpm test:agents.
3. Compilar con pnpm build antes de cualquier test que importe dist/. Ejecutar las suites de
   PostgreSQL en secuencia; si faltan binarios, informar PG_TEST_BIN y el bloqueo, sin usar otra base.
4. Si cambia UI/contratos, localizar los repos consumidores y ejecutar sus comprobaciones pertinentes.
   Para un cambio transversal o preparar publicación, ejecutar la suite completa de CI correspondiente.
5. Entregar comandos ejecutados, resultados y pruebas omitidas con motivo. No atribuir un fallo previo
   al cambio sin comprobarlo. No repetir suites verdes si no cambió lo que prueban.
Referencia: docs/desarrollo.md. Este procedimiento no hace commit ni despliega por sí mismo.
