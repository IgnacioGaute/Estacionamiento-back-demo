import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { OPERATOR_ENDPOINTS, SUSPENDED_ENDPOINTS } from './endpoint-policy';

// Las listas de permisos nombran clase y método como texto. Si alguien renombra un handler o
// escribe mal un nombre, nada falla al compilar: el operador empieza a recibir 403 (o la empresa
// suspendida queda sin poder cerrar su turno) recién en producción. Esto compara cada nombre con
// los controladores reales.

const archivos = (dir: string): string[] =>
  readdirSync(dir).flatMap((nombre) => {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) return archivos(ruta);
    return nombre.endsWith('.ts') && !nombre.endsWith('.spec.ts') ? [ruta] : [];
  });

// Dónde está declarado cada controlador (algunos viven fuera de un *.controller.ts).
const ubicacion = new Map<string, string>();
for (const ruta of archivos(join(__dirname, '..'))) {
  for (const [, clase] of readFileSync(ruta, 'utf8').matchAll(/export class (\w+Controller)\b/g)) ubicacion.set(clase, ruta);
}

const politicas = { OPERATOR_ENDPOINTS, SUSPENDED_ENDPOINTS };
const casos = Object.entries(politicas).flatMap(([politica, lista]) =>
  Object.entries(lista).map(([controlador, handlers]) => [politica, controlador, handlers] as const),
);

describe('Listas de permisos por endpoint', () => {
  test.each(casos)('%s → %s: cada handler existe en el controlador', async (_politica, controlador, handlers) => {
    const ruta = ubicacion.get(controlador);
    expect(ruta).toBeDefined();
    const clase = (await import(ruta!))[controlador];
    const inexistentes = handlers.filter((h) => typeof clase.prototype[h] !== 'function');
    expect(inexistentes).toEqual([]);
  });

  test('sin handlers repetidos en una misma lista', () => {
    for (const lista of Object.values(politicas))
      for (const handlers of Object.values(lista)) expect(new Set(handlers).size).toBe(handlers.length);
  });
});
