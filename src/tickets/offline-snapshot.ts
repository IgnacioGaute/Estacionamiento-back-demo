import { createHash } from 'crypto';

// Las fechas de renovación no cambian la operación. JSONB reordena claves al leer: la huella
// debe ser la misma antes y después de persistir, también para snapshots históricos anidados.
// Las estadías sin tarifa fijada llevan una copia de la vigente descargada: su fecha de captura es
// la de la descarga, no un dato de la estadía. Un snapshot histórico propio (otra fecha) sí cuenta.
export function offlineSnapshotFingerprint(snapshot: any): string {
  const vigente = snapshot.pricing?.capturedAt;
  const sinCaptura = (pricing: any) => (pricing ? { ...pricing, capturedAt: undefined } : pricing);
  const vehicles = Array.isArray(snapshot.vehicles)
    ? snapshot.vehicles.map((v: any) => (vigente && v?.pricing?.capturedAt === vigente ? { ...v, pricing: sinCaptura(v.pricing) } : v))
    : snapshot.vehicles;
  const content = { ...snapshot, capturedAt: undefined, expiresAt: undefined, pricing: sinCaptura(snapshot.pricing), vehicles };
  return createHash('sha256').update(JSON.stringify(content, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest('hex');
}
