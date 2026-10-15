// Sustitución de caracteres confundibles, siempre en la misma dirección — se aplica igual al
// guardar una patente y al texto que se busca, así "A8C123" encuentra "ABC123".
const CONFUSABLE_MAP: Record<string, string> = { O: '0', I: '1', S: '5', B: '8' };

export function normalizePlate(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function toSearchKey(normalized: string): string {
  return normalized.replace(/[OISB]/g, (c) => CONFUSABLE_MAP[c]);
}

// Hasta cuántos caracteres distintos (cambiados, de más o de menos) se consideran «la misma
// patente mal leída». Con 3 o más ya es otro auto.
const MAX_DIFERENCIAS_PARECIDAS = 2;

// Dos patentes que pueden ser el mismo auto mal leído: distintas, pero a 1 o 2 caracteres de
// distancia después de igualar los confundibles. Es la lectura equivocada típica de la cámara o
// del teclado (HHH664 / HHH644, ZZ437ZX / ZZ438ZN): sin avisarla, el auto quedaba adentro para
// siempre y a la salida se le cargaba una entrada nueva.
export function patentesParecidas(a: string, b: string): boolean {
  const x = toSearchKey(normalizePlate(a));
  const y = toSearchKey(normalizePlate(b));
  if (normalizePlate(a) === normalizePlate(b) || x.length < 5 || y.length < 5) return false;
  return distanciaEdicion(x, y) <= MAX_DIFERENCIAS_PARECIDAS;
}

// Levenshtein: cuántos caracteres hay que cambiar, agregar o quitar para pasar de una a otra.
function distanciaEdicion(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > MAX_DIFERENCIAS_PARECIDAS) return Infinity;
  let previa = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const actual = [i];
    for (let j = 1; j <= b.length; j++) {
      actual[j] = Math.min(previa[j] + 1, actual[j - 1] + 1, previa[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previa = actual;
  }
  return previa[b.length];
}

export type PlateFormat = 'OLD_AUTO' | 'MERCOSUR_AUTO' | 'OLD_MOTO' | 'MERCOSUR_MOTO' | 'UNKNOWN';

// Nunca bloquea el guardado — solo informa. Reconoce los cuatro formatos que conviven hoy.
export function classifyPlateFormat(normalized: string): PlateFormat {
  if (/^[A-Z]{3}\d{3}$/.test(normalized)) return 'OLD_AUTO';
  if (/^[A-Z]{2}\d{3}[A-Z]{2}$/.test(normalized)) return 'MERCOSUR_AUTO';
  if (/^\d{3}[A-Z]{3}$/.test(normalized)) return 'OLD_MOTO';
  if (/^[A-Z]\d{3}[A-Z]{3}$/.test(normalized)) return 'MERCOSUR_MOTO';
  return 'UNKNOWN';
}

export function isPlausiblePlate(normalized: string): boolean {
  return normalized.length >= 5 && normalized.length <= 8;
}
