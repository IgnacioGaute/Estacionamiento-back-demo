# Revisión de seguridad — 19/09/2026

## Alcance y controles

Revisión del backend Nest, sesiones y acciones del frontend, PostgreSQL/RLS, sockets y exposición de archivos. Las pruebas modifican únicamente una base PostgreSQL temporal. No son una certificación de infraestructura de producción.

| Acceso | Control efectivo |
| --- | --- |
| Login | Credenciales, cuenta vigente, empresa activa; límite de intentos por IP e identificador |
| Auth interno | Secreto del servidor; no admite JWT de usuario |
| Lecturas internas de usuarios | Secreto del servidor, sólo `findAll` y `findOne`, sin contraseñas |
| Empresas, playas y asignaciones globales | JWT vigente + SUPER_ADMIN consultado en la base |
| Operación | JWT vigente + empresa activa + playa autorizada + RLS |
| Tarifas, configuración, altas/bajas y cierres históricos | Además, rol administrador |
| Cuenta propia | Lectura y cambio de contraseña; no permite cambiarse el rol |
| Sockets | JWT, caducidad, empresa, playa y versión de credenciales; se revalidan antes de emitir |
| Archivos locales | Se quitó `/uploads` público; no se sirve ningún archivo privado sin autorización |

La lista de acciones permitidas al operador está en `src/tenancy/endpoint-policy.ts`. Una acción nueva no incluida queda reservada al administrador. El guard usa el controlador y método resueltos por Nest: cambiar mayúsculas o agregar una barra a la URL no elude permisos. El SUPER_ADMIN conserva el acceso global autorizado por el producto; el frontend muestra sólo administración de plataforma.

## Correcciones

- Se retiraron las escrituras genéricas de usuarios mediante el secreto interno.
- El alta del frontend exige un administrador y usa su empresa/playa; no existe autorregistro anónimo.
- Los endpoints de actualización de usuario y contraseña dejan de devolver hashes.
- El frontend obtiene rol e identidad de la base, no de `session.update` enviado por el navegador. No renueva sesiones inválidas automáticamente.
- La migración `AuthVersion1790000002000` invalida sesiones anteriores cuando cambia una contraseña, incluso si la cambia un administrador.
- Recuperación de contraseña transaccional: comprueba el enlace, su vencimiento y consume el token una sola vez; dos peticiones simultáneas no pueden reutilizarlo.
- Consultas por email/token codificadas en URL; mensajes de acceso inválido sin revelar si existe una cuenta; destino de login restringido a rutas locales.
- Un operador no puede atribuir una nota a otro usuario.
- El pago/cancelación de un recibo comprueba que el recibo corresponda al cliente indicado. Se rechazan importes negativos en los DTO de pagos.
- La planilla del operador no expone el arqueo completo de otros turnos por una ruta alternativa al historial administrativo.
- Se quitaron tokens de los mensajes de error y datos de pagos de los logs de diagnóstico.

## Validación reproducible

Backend:

```powershell
pnpm exec tsc -p tsconfig.build.json --incremental false
node --test test/tenant-isolation.integration.cjs test/tenancy.integration.cjs test/tickets.integration.cjs test/image-signature.test.cjs
```

Frontend:

```powershell
pnpm exec tsc --noEmit
node --test test/auth-session.test.cjs test/platform-access.test.cjs
```

Se comprueban todos los handlers HTTP montados sin credenciales (119 endpoints protegidos), permisos de operador, IDs de otra empresa, cabeceras de playa manipuladas, relaciones cruzadas, reutilización del pool, concurrencia, revocación de usuarios, sesiones y eventos entre playas. El login es el único endpoint público; sus casos de error y límites se prueban aparte. Los tests también verifican que cada tabla con `playaId` tenga RLS forzada o no sea legible por el rol operativo.

## Dependencias y límites operativos

Se actualizaron Next.js a 15.5.24 y Auth.js a beta.32; Nest se mantiene en la rama 10, TypeORM en 0.3 y Multer pasa a 2. Se eliminaron librerías de PDF/JWT del frontend sin usos en el código y el servidor estático no utilizado del backend. Referencias: [Next.js Windows](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36), [Auth.js](https://github.com/nextauthjs/next-auth/security/advisories/GHSA-8fpg-xm3f-6cx3).

Los límites de intentos son por proceso: un despliegue con varias réplicas necesita un contador compartido o límite en el proxy. No se verificaron TLS, firewall, permisos del servidor de producción ni servicios externos de correo/OCR. No se enviaron correos reales ni imágenes a servicios externos durante las pruebas.

La revisión de dependencias debe repetirse con `pnpm audit --prod`: no equivale a una prueba de explotación. No se debe interpretar el éxito de las pruebas como ausencia garantizada de cualquier vulnerabilidad.

## Resultado de la verificación

- Backend: 45 pruebas aprobadas, incluyendo los 119 handlers protegidos sin credenciales. Compilación TypeScript aprobada.
- Frontend: 4 pruebas de sesión/permisos aprobadas, TypeScript y compilación de producción aprobados. La compilación se hizo en una copia temporal para no interferir con el servidor de desarrollo.
- Navegador: acceso del operador a su playa y del administrador a la asignación de operadores verificados sin modificar datos. Se comprobó también que el anónimo vuelve al login, SUPER_ADMIN se dirige a empresas y un operador no entra a la administración de plataforma, cambiando de cuenta en el mismo navegador.
- Backend local reiniciado con la migración de versión de credenciales. Se creó un respaldo de PostgreSQL antes de aplicarla. Frontend local reiniciado con caché nueva.
- Las lecturas de clientes desde el navegador pasan por acciones del servidor. Los servicios de recibos incorporan cabeceras de sesión y playa también cuando antes sólo enviaban Content-Type.
- OCR: límite de 6 MB y comprobación de firmas JPEG/PNG/WebP antes de enviar al proveedor. No se invoca el detector genérico de documentos/archivos comprimidos sobre entradas del usuario. Esto comprueba el formato permitido, no garantiza que toda imagen esté íntegra.

### Avisos de dependencias pendientes

`pnpm audit --prod`, al cierre de esta revisión:

| Proyecto | Críticos | Altos | Moderados | Bajos |
| --- | ---: | ---: | ---: | ---: |
| Backend | 0 | 6 | 9 | 2 |
| Frontend | 0 | 18 | 9 | 2 |

Los conteos son avisos del árbol de dependencias, no cantidad de endpoints vulnerables. **La actualización de dependencias no está completamente resuelta.**

- Backend: quedan avisos en Fastify/find-my-way (adaptador no usado por la aplicación Express), extract-zip (instalación del navegador de Puppeteer), file-type (el endpoint OCR ya no utiliza ese detector), lodash, uuid, diff y Nest Core. El aviso de Nest corresponde a SSE; no se encontraron endpoints SSE. Deben reevaluarse antes de incorporar usos nuevos y resolver las actualizaciones pendientes del árbol.
- Frontend: quedan avisos de `xlsx` (se usa para exportar; no se encontró importación de archivos Excel), `ws` y dependencias de compilación/estilos como minimatch, glob, postcss y Babel. No se consideran resueltos sólo por no haber demostrado explotación en estas pruebas.
- Persisten advertencias de configuración antigua de Next y de compatibilidad de react-day-picker. La compilación y las pantallas verificadas funcionaron; no se recorrieron todas las pantallas del producto.

La revisión cubre autorización de la aplicación y los escenarios automatizados descritos. La infraestructura de producción, el proveedor de correo y el de OCR requieren comprobaciones en su entorno correspondiente.
