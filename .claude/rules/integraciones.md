---
paths:
  - "src/mercadopago/**"
  - "src/saas/**"
  - "src/plate-recognition/**"
  - "alpr/**"
---

# Integraciones externas
- MercadoPago de la plataforma y MercadoPago de cada empresa son cuentas y circuitos separados.
- Acreditar desde estado confirmado por API, con unicidad e idempotencia; revisar firmas y scope.
- No modificar condiciones publicadas: agregar una nueva versión si cambia lo aceptado.
- Patentes: token de playa usa Plate Recognizer; sin token usar ALPR cuando está configurado;
  sin ambos, PATENTES_SIN_PLAN. No eliminar este fallback por documentación histórica.
- Consultar docs/verificacion-transferencias.md, docs/planes-y-cuentas.md o
  docs/architecture/patentes.md según el proveedor. Las pruebas usan doubles o entornos temporales.
