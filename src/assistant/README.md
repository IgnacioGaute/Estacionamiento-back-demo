# Asistente

Configuración privada del backend:

```
GEMINI_API_KEY=clave_privada
GEMINI_MODEL=gemini-3.1-flash-lite
```

La clave nunca se entrega al navegador. Las preguntas y los resultados mínimos de las consultas autorizadas se envían a Google. La cuota y la facturación dependen del proyecto de Google; la app no activa planes pagos.

`knowledge.ts` contiene la guía versionada. Actualizarla al modificar pantallas, reglas o permisos. No aprende de usuarios ni convierte sus mensajes en documentación.

POST /assistant/chat requiere usuario autenticado y playa autorizada mediante TenantGuard/TenantInterceptor. El modelo no recibe herramientas SQL ni mutaciones. Herramientas iniciales: activos por hora (15 resultados y conteo), caja actual, configuración de tarifas (hasta 60 franjas), desglose de ingreso activo, últimos cinco cierres (solo ADMIN). Cada ejecución comprueba nuevamente el contexto. El historial está en memoria, separado por empresa/playa/usuario/rol, caduca en 30 minutos y conserva cinco intercambios; se pierde al reiniciar o cambiar de instancia. Los límites son por proceso (8 preguntas/minuto y una simultánea por usuario/playa). Para múltiples instancias migrar historial y límites a un almacenamiento compartido.

Frontend: `components/assistant/assistant-widget.tsx`. Reemplazar Bot por el ícono final. Posición arrastrable persistida en localStorage; los chats no se guardan en localStorage y se vacían al cambiar de cuenta/playa. Botón accesible por teclado; flechas lo mueven.
