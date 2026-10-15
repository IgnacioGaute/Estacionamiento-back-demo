---
name: "revisar-cambio"
description: "Revisar un diff del estacionamiento buscando regresiones de dinero, permisos, contratos y pruebas antes de integrar cambios."
---

# Revisión independiente
1. Delimitar el diff de la tarea y las reglas del dominio; no atribuir todo el working tree a la tarea.
2. Dar al revisor los archivos, el comportamiento buscado y los tests ejecutados. Incluir el diff
   relevante como contexto: los subagentes tienen Read/Grep/Glob, no herramientas de shell.
3. Elegir revisor-aislamiento para permisos/RLS, revisor-cobros para dinero/concurrencia y
   revisor-contratos para consumidores y cobertura. No lanzar los tres para una edición trivial.
4. Si hay varios riesgos independientes, se pueden revisar en paralelo, sin editar el mismo código.
5. Confirmar cada hallazgo contra la implementación antes de modificar. Priorizar defectos con
   condición de activación, impacto, archivo/línea y comprobación propuesta. No inventar hallazgos.
6. Corregir dentro del alcance y volver a ejecutar las pruebas afectadas. Distinguir problemas
   demostrados, preguntas abiertas y límites de la revisión.
