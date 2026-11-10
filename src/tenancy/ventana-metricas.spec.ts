import { inicioVentana } from './ventana-metricas';

describe('inicioVentana', () => {
  it('30 días son hoy y los 29 anteriores, desde la medianoche de Argentina', () => {
    // 9/11 a las 21:52 en Argentina (00:52 del 10/11 en UTC).
    const ahora = new Date('2026-11-10T00:52:00.000Z');
    expect(inicioVentana(30, 1, ahora).toISOString()).toBe('2026-10-11T03:00:00.000Z');
  });

  it('el período anterior tiene el mismo largo y termina donde empieza el actual', () => {
    const ahora = new Date('2026-11-09T15:00:00.000Z');
    const actual = inicioVentana(30, 1, ahora);
    const previo = inicioVentana(30, 2, ahora);
    expect(previo.toISOString()).toBe('2026-09-11T03:00:00.000Z');
    expect((actual.getTime() - previo.getTime()) / 86_400_000).toBe(30);
  });

  it('una ventana de un día es solo hoy', () => {
    const ahora = new Date('2026-11-09T02:30:00.000Z'); // 8/11 23:30 en Argentina
    expect(inicioVentana(1, 1, ahora).toISOString()).toBe('2026-11-08T03:00:00.000Z');
  });
});
