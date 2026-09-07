// Sustitución de caracteres confundibles, siempre en la misma dirección — se aplica igual al
// guardar una patente y al texto que se busca, así "A8C123" encuentra "ABC123".
const CONFUSABLE_MAP: Record<string, string> = { O: '0', I: '1', S: '5', B: '8' };

export function normalizePlate(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function toSearchKey(normalized: string): string {
  return normalized.replace(/[OISB]/g, (c) => CONFUSABLE_MAP[c]);
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
