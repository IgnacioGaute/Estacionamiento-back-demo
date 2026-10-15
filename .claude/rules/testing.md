---
paths:
  - "test/**"
  - "src/**/*.spec.ts"
  - ".github/workflows/**"
  - "package.json"
  - ".claude/**"
---

# Validación
- Leer package.json y la sección de pruebas de docs/desarrollo.md antes de elegir comandos.
- Integración importa dist/: compilar después del último cambio, antes de ejecutar node --test.
- Agregar nuevas suites autocontenidas al script test:integration para incluirlas en CI.
- UI/puppeteer necesita repos hermanos: localizar checkouts reales antes de ejecutar.
- No usar .env ni la base real para reemplazar el cluster temporal de integración.
- Configuración/hooks: pnpm test:agents; son pruebas locales que no llaman modelos ni servicios.
