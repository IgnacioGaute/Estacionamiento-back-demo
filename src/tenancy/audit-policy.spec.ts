import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { AUDIT_RULES } from './audit-policy';

// AUDIT_RULES nombra clase y método como texto, igual que las listas de permisos. Un nombre mal
// escrito no falla en ningún lado: esa acción simplemente deja de aparecer en la Actividad de la
// empresa, y nadie lo nota hasta que la busca. Esto compara cada nombre con los controladores
// reales.

const archivos = (dir: string): string[] =>
  readdirSync(dir).flatMap((nombre) => {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) return archivos(ruta);
    return nombre.endsWith('.ts') && !nombre.endsWith('.spec.ts') ? [ruta] : [];
  });

const ubicacion = new Map<string, string>();
for (const ruta of archivos(join(__dirname, '..'))) {
  for (const [, clase] of readFileSync(ruta, 'utf8').matchAll(/export class (\w+Controller)\b/g)) ubicacion.set(clase, ruta);
}

const casos = Object.entries(AUDIT_RULES).map(([controlador, reglas]) => [controlador, Object.keys(reglas)] as const);

describe('Acciones auditadas', () => {
  test.each(casos)('%s: cada handler existe en el controlador', async (controlador, handlers) => {
    const ruta = ubicacion.get(controlador);
    expect(ruta).toBeDefined();
    const clase = (await import(ruta!))[controlador];
    const inexistentes = handlers.filter((h) => typeof clase.prototype[h] !== 'function');
    expect(inexistentes).toEqual([]);
  });
});
