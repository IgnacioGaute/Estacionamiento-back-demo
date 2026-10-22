import { offlineSnapshotFingerprint } from './offline-snapshot';

test('la huella tolera renovación de fechas y el orden de claves de JSONB', () => {
  const first = { capturedAt: 'antes', expiresAt: 1, playaId: 'playa', vehicles: [{ id: 'auto', plate: 'ABC123' }], pricing: { capturedAt: 'antes', brackets: [{ price: 1000, label: 'Hora' }] } };
  const second = { pricing: { brackets: [{ label: 'Hora', price: 1000 }], capturedAt: 'después' }, vehicles: [{ plate: 'ABC123', id: 'auto' }], playaId: 'playa', capturedAt: 'después', expiresAt: 2 };
  expect(offlineSnapshotFingerprint(first)).toBe(offlineSnapshotFingerprint(second));
  second.pricing.brackets[0].price = 2000;
  expect(offlineSnapshotFingerprint(first)).not.toBe(offlineSnapshotFingerprint(second));
});
test('la tarifa vigente copiada en estadías sin tarifa fijada no cambia la huella; una histórica sí', () => {
  const copia = (capturedAt: string, historica: string) => ({
    capturedAt,
    pricing: { capturedAt, brackets: [{ price: 1000 }] },
    vehicles: [
      { id: 'sin-fijar', pricing: { capturedAt, brackets: [{ price: 1000 }] } },
      { id: 'fijada', pricing: { capturedAt: historica, brackets: [{ price: 800 }] } },
    ],
  });
  expect(offlineSnapshotFingerprint(copia('antes', '2026-01-01'))).toBe(offlineSnapshotFingerprint(copia('después', '2026-01-01')));
  expect(offlineSnapshotFingerprint(copia('antes', '2026-01-01'))).not.toBe(offlineSnapshotFingerprint(copia('antes', '2026-02-01')));
});
test.each(['userId', 'playaId', 'modalidad', 'shift', 'vehicles', 'receipts'])('un cambio en %s invalida la copia', field => {
  expect(offlineSnapshotFingerprint({ [field]: 'anterior' })).not.toBe(offlineSnapshotFingerprint({ [field]: 'nuevo' }));
});
