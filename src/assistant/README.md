# Asistente

Configuración privada del backend:

```
GEMINI_API_KEY=clave_privada
GEMINI_MODEL=gemini-3.5-flash-lite
GEMINI_FALLBACK_MODELS=gemini-3.1-flash-lite
```

La clave nunca se entrega al navegador. Las preguntas y los resultados mínimos de las consultas autorizadas se envían a Google. La cuota y la facturación dependen del proyecto de Google; la app no activa planes pagos.

Resiliencia: dos intentos por modelo ante cortes de red, respuestas incompletas o HTTP 500/502/503/504. Se consume el cuerpo dentro del timeout de 12 segundos por intento. El presupuesto total es 65 segundos, menor que el timeout del frontend de 90 segundos. Los modelos de respaldo se pueden separar por comas (máximo tres modelos contando el principal); un valor vacío desactiva el respaldo. No se reintentan errores de clave o cuota. El respaldo predeterminado usa la misma clave de Google, sujeto a su disponibilidad para ese proyecto.

Ambos endpoints, `/assistant/chat` y `/assistant/chat/stream`, permiten operadores autenticados de la playa. El endpoint SSE se conserva para el widget, pero la respuesta de Google se consume completa antes de mostrarla: así se pueden reintentar cortes sin mostrar texto parcial y se conservan las firmas originales requeridas por las herramientas. El texto aparece al finalizar, no palabra por palabra.

`knowledge.ts` contiene la guía versionada. Actualizarla al modificar pantallas, reglas o permisos. No aprende de usuarios ni convierte sus mensajes en documentación.

POST /assistant/chat requiere usuario autenticado y playa autorizada mediante TenantGuard/TenantInterceptor. El modelo no recibe herramientas SQL ni mutaciones. Herramientas iniciales: activos por hora (15 resultados y conteo), caja actual, configuración de tarifas (hasta 60 franjas), desglose de ingreso activo, últimos cinco cierres (solo ADMIN). Cada ejecución comprueba nuevamente el contexto. El historial está en memoria, separado por empresa/playa/usuario/rol, caduca en 30 minutos y conserva cinco intercambios; se pierde al reiniciar o cambiar de instancia. Los límites son por proceso (8 preguntas/minuto y una simultánea por usuario/playa). Para múltiples instancias migrar historial y límites a un almacenamiento compartido.

Frontend: `components/assistant/assistant-widget.tsx`. Reemplazar Bot por el ícono final. Posición arrastrable persistida en localStorage; los chats no se guardan en localStorage y se vacían al cambiar de cuenta/playa. Botón accesible por teclado; flechas lo mueven.
