# Claude Code — backend

@AGENTS.md

Las reglas de .claude/rules/ se cargan por ruta. No importes todas las referencias
de docs/architecture/ al inicio: leé solamente el dominio de la tarea.

Skills disponibles: /verificar-cambio, /nueva-migracion, /cambio-api,
/revisar-cambio, /preparar-release y /trabajo-aislado.
La descripción de cada skill permite descubrirla automáticamente cuando aplica.

Los revisores personalizados tienen herramientas de lectura y no modifican código.
Usalos para cambios de riesgo o revisiones pedidas, no para cada edición pequeña.

Configuración, hooks, ejemplos y límites: docs/claude-workflow.md.
Compatible con la importación explícita de AGENTS.md de Claude Code 2.1.252.
