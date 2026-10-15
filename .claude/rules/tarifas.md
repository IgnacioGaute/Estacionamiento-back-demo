---
paths:
  - "src/tickets/pricing/**"
  - "src/tickets/tariff*"
  - "src/tickets/tickets.service.ts"
  - "src/tickets/dto/**"
  - "scripts/build-offline-pricing.cjs"
---

# Tarifas
- Leer docs/architecture/tarifas.md y docs/tickets-tarifas.md.
- Simulador, cierre y cálculo offline deben conservar la misma semántica; no cobrar al simular.
- Preservar snapshots existentes salvo la aplicación explícita a activos, con su transacción y locks.
- Reglas de permanencia están deshabilitadas para nuevas configuraciones/entradas, conservando historia.
- Probar bordes de tolerancia, medianoche, tipos desactivados, anticipos y falta de tarifas aplicables.
