---
name: "cambio-api"
description: "Implementar cambios de contratos HTTP o sockets entre el backend y los consumidores frontend, comprobantes o landing."
---

# Contrato entre aplicaciones
1. Identificar endpoint/evento, DTO, respuesta, código de error y consumidores reales buscando sus usos.
2. Leer instrucciones de cada repo involucrado. Localizar checkouts en worktrees; no asumir ../ funciona.
3. Mantener coherencia de validación, autenticación, scope, OPERATOR_ENDPOINTS y SUSPENDED_ENDPOINTS.
4. Actualizar consumidor, tipos, schema, servicio y action según el patrón del frontend.
   Para sockets revisar authVersion, reconexión y cambio de playa; evitar emisiones globales.
5. Considerar despliegue separado: preferir cambios compatibles; documentar orden si no lo son.
6. Comprobar éxito, error estructurado y rol no autorizado. Si cambia el flujo de cobro,
   comprobar importe obsoleto, reintento e idempotencia. Actualizar docs y knowledge.ts si corresponde.
7. Validar ambos extremos. Informar por repo los archivos y pruebas, sin mezclar staging entre repos.
