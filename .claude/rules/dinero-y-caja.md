---
paths:
  - "src/tickets/**"
  - "src/movimientos/**"
  - "src/turnos/**"
  - "src/box-lists/**"
  - "src/receipts/**"
  - "src/cuentas/**"
  - "src/mercadopago/**"
---

# Dinero y caja
- Leer docs/architecture/caja.md y el documento del dominio afectado.
- Usar el mismo manager transaccional para pago, ledger, caja y cierre. Revisar duplicados,
  reintentos, importes obsoletos, rollback y concurrencia, incluidos los primeros registros del día.
- Movimiento no equivale automáticamente a caja: conservar linkToTodaysBoxList y cash_entries.
- Separar efectivo físico, ingresos por medio de pago y fondos de apertura/traspasos.
- En cuentas de inquilinos, leer docs/architecture/cuentas.md: cargos, pagos, devoluciones y
  anulaciones tienen semánticas diferentes; no reutilizar endpoints legacy para saltear el ledger.
- Elegir tickets/cajas/cuentas/verificacion-alias.integration.cjs según los flujos cambiados.
