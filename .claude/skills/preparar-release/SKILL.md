---
name: "preparar-release"
description: "Preparar una entrega verificable del estacionamiento: diff por repo, pruebas, migraciones y compatibilidad antes de un commit, push o deploy solicitado."
---

# Preparar entrega
1. Revisar git status, rama y diff de cada repo involucrado; delimitar qué pertenece a esta tarea.
2. Ejecutar verificaciones de CI pertinentes y pruebas de contrato/UI afectadas. Comprobar migraciones
   registradas y compatibilidad de despliegues separados. No tratar configuración declarada como CI verde.
3. Si se pidió un commit, agregar archivos por ruta explícita y revisar todo el índice antes de crearlo.
   Un archivo modificado por otra sesión necesita separación/revisión; un worktree no incorpora WIP ajeno.
4. Antes de publicar, verificar el remoto y la rama reales y la autorización de la tarea. Memorias antiguas
   que nombran origin/mitre no autorizan push a todos los remotos. Aprovechar autorización ya dada sin repetirla.
5. Documentar comportamiento, pruebas y limitaciones. Si se autorizó publicar, seguir el flujo existente,
   observar CI/despliegue cuando haya acceso y distinguir build local de despliegue confirmado.
6. Si falta autorización para publicar, dejar la entrega preparada y concreta. No tocar producción,
   bases reales ni credenciales como parte de una simple revisión de release.
