import { HttpStatus } from '@nestjs/common';

// El limitador guarda los intentos en un Map del módulo: cada test carga una copia nueva.
const freshLimiter = async () => {
  jest.resetModules();
  return (await import('./login-limiter')).limitLogin;
};

const statusOf = (fn: () => void) => {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as { getStatus(): number }).getStatus();
  }
};

describe('Límite de intentos de login', () => {
  afterEach(() => jest.useRealTimers());

  test('quince intentos por IP e identificador, sin importar mayúsculas ni espacios', async () => {
    const limitLogin = await freshLimiter();
    for (let i = 0; i < 15; i++) limitLogin('10.0.0.1', i % 2 ? 'Ana@Example.test ' : 'ana@example.test');
    expect(statusOf(() => limitLogin('10.0.0.1', 'ANA@EXAMPLE.TEST'))).toBe(HttpStatus.TOO_MANY_REQUESTS);
    // Otro usuario desde la misma IP todavía puede entrar.
    expect(statusOf(() => limitLogin('10.0.0.1', 'otro@example.test'))).toBeNull();
  });

  test('cien intentos por IP aunque cambie el identificador', async () => {
    const limitLogin = await freshLimiter();
    for (let i = 0; i < 100; i++) limitLogin('10.0.0.2', `usuario-${i}`);
    expect(statusOf(() => limitLogin('10.0.0.2', 'nuevo'))).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(statusOf(() => limitLogin('10.0.0.3', 'nuevo'))).toBeNull();
  });

  test('pasada la ventana de cinco minutos vuelve a dejar intentar', async () => {
    jest.useFakeTimers({ now: new Date('2026-05-01T12:00:00Z') });
    const limitLogin = await freshLimiter();
    for (let i = 0; i < 15; i++) limitLogin('10.0.0.4', 'ana');
    expect(statusOf(() => limitLogin('10.0.0.4', 'ana'))).toBe(HttpStatus.TOO_MANY_REQUESTS);
    jest.setSystemTime(new Date('2026-05-01T12:05:01Z'));
    expect(statusOf(() => limitLogin('10.0.0.4', 'ana'))).toBeNull();
  });
});
