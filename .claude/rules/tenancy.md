---
paths:
  - "src/tenancy/**"
  - "src/auth/**"
  - "src/users/**"
  - "src/utils/guards/**"
  - "src/utils/strategies/**"
  - "src/database/migrations/**"
  - "src/**/*.controller.ts"
  - "src/**/*gateway.ts"
---

# Aislamiento y acceso
- Leer docs/architecture/tenancy.md cuando cambien permisos o aislamiento.
- Nuevos handlers: revisar OPERATOR_ENDPOINTS y SUSPENDED_ENDPOINTS; verificar USER, ADMIN,
  SUPER_ADMIN, empresa suspendida, acceso revocado y solicitudes a otra playa/empresa.
- Datos tenant nuevos necesitan scope, índices, políticas RLS, grants y triggers de referencias.
- Tareas fuera de HTTP necesitan tenantContext explícito; sockets usan TenantSocketAccess.
- Pruebas pertinentes: tenant-access, endpoint-policy y test/tenant-isolation.integration.cjs.
