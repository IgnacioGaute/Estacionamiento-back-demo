---
paths:
  - "src/assistant/**"
  - "src/tickets/*receipt*"
  - "src/tickets/public-parking-receipts.controller.ts"
  - "src/cuentas/**"
  - "public/recibo.template.html"
---

# Asistente y comprobantes
- Asistente: herramientas de solo lectura, revalidación del scope y claves solo en backend.
  Leer src/assistant/README.md; actualizar knowledge.ts ante cambios visibles o de permisos.
- Comprobantes públicos: conservar snapshot, token aleatorio, idempotencia, mínimo de datos,
  no-store/noindex y compatibilidad con estacionamiento-comprobantes-demo.
- Referencias: docs/architecture/comprobantes.md y docs/comprobantes.md.
