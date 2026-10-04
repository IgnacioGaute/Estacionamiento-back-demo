import { Anulable, ContextoAnulacion, reglaAnulacion } from './anulacion';
import { CuentaMovimiento } from './entities/cuenta-movimiento.entity';

// Hoy es 15 de octubre de 2026 en Argentina. El motivo de 10 caracteres y el importe tipeado
// los controla CuentasService.anular dentro de la transacción: eso lo cubre cuentas.integration.
const ctx = (extra: Partial<ContextoAnulacion> = {}): ContextoAnulacion => ({
  mes: '2026-10',
  hoy: '2026-10-15',
  turnosAbiertos: new Set(),
  anulados: new Set(),
  origenes: new Map(),
  recibosConPagos: new Set(),
  ...extra,
});

const asiento = (extra: Partial<CuentaMovimiento> = {}) =>
  ({
    id: 'mov-1',
    tipo: 'CARGO',
    importe: 50000,
    metodo: null,
    fecha: '2026-10-15',
    createdAt: new Date('2026-10-15T13:00:00Z'),
    receiptId: null,
    anulaId: null,
    detalle: null,
    ...extra,
  }) as CuentaMovimiento;

// Sin strictNullChecks TypeScript no distingue el caso por `ok`: se pregunta por la propiedad,
// igual que CuentasService.anular.
const codigo = (fila: CuentaMovimiento, contexto = ctx()) => {
  const regla = reglaAnulacion(fila, contexto);
  return 'code' in regla ? regla.code : 'OK';
};
const motivo = (regla: Anulable) => ('motivo' in regla ? regla.motivo : null);

describe('Qué se puede anular en la cuenta de un inquilino', () => {
  test('una anulación no se anula, y lo ya anulado tampoco', () => {
    expect(codigo(asiento({ tipo: 'ANULACION' }))).toBe('ES_ANULACION');
    expect(codigo(asiento(), ctx({ anulados: new Set(['mov-1']) }))).toBe('YA_ANULADO');
  });

  test('la historia migrada del sistema anterior se corrige con ajustes, nunca se anula', () => {
    expect(codigo(asiento({ detalle: { migrado: true } }))).toBe('HISTORIA_MIGRADA');
  });

  test('un pago acreditado por MercadoPago no se anula, aunque sea de hoy', () => {
    expect(codigo(asiento({ tipo: 'PAGO', metodo: 'MERCADOPAGO', importe: -50000 }))).toBe('PAGO_MERCADOPAGO');
  });

  describe('pagos y devoluciones', () => {
    test.each(['PAGO', 'DEVOLUCION'] as const)('%s con turno: solo mientras ese turno siga abierto', (tipo) => {
      const fila = asiento({ tipo, metodo: 'CASH', importe: tipo === 'PAGO' ? -50000 : 20000, detalle: { turnoId: 'turno-1' } });
      expect(codigo(fila, ctx({ turnosAbiertos: new Set(['turno-1']) }))).toBe('OK');
      expect(codigo(fila, ctx({ turnosAbiertos: new Set(['turno-2']) }))).toBe('TURNO_CERRADO');
    });

    test('con el turno cerrado, aunque sea el mismo día, el efectivo ya se rindió', () => {
      const fila = asiento({ tipo: 'PAGO', metodo: 'CASH', importe: -50000, fecha: '2026-10-15', detalle: { turnoId: 'turno-1' } });
      const regla = reglaAnulacion(fila, ctx());
      expect(regla).toEqual(expect.objectContaining({ ok: false, code: 'TURNO_CERRADO' }));
      expect(motivo(regla)).toContain('registrá una devolución');
    });

    test('sin turnos, solo el mismo día', () => {
      const pago = (fecha: string) => asiento({ tipo: 'PAGO', metodo: 'TRANSFER', importe: -50000, fecha });
      expect(codigo(pago('2026-10-15'))).toBe('OK');
      expect(codigo(pago('2026-10-14'))).toBe('FUERA_DE_PLAZO');
    });
  });

  describe('cargos y ajustes', () => {
    test('se anulan dentro del mes en que se cargaron', () => {
      expect(codigo(asiento({ createdAt: new Date('2026-10-01T12:00:00Z') }))).toBe('OK');
      expect(codigo(asiento({ createdAt: new Date('2026-09-20T12:00:00Z') }))).toBe('FUERA_DE_PLAZO');
    });

    test('el mes de carga es el de Argentina, no el de UTC', () => {
      // 1 de octubre 02:00 UTC es 30 de septiembre 23:00 en Buenos Aires: se cargó en septiembre.
      expect(codigo(asiento({ createdAt: new Date('2026-10-01T02:00:00Z') }))).toBe('FUERA_DE_PLAZO');
      expect(codigo(asiento({ createdAt: new Date('2026-10-01T03:00:00Z') }))).toBe('OK');
    });

    test('pasado el mes indica cómo corregir: bonificación para deuda, recargo para crédito', () => {
      const septiembre = new Date('2026-09-20T12:00:00Z');
      const deuda = reglaAnulacion(asiento({ importe: 50000, createdAt: septiembre }), ctx());
      const credito = reglaAnulacion(asiento({ tipo: 'AJUSTE', importe: -5000, createdAt: septiembre }), ctx());
      expect(motivo(deuda)).toBe('Se cargó en septiembre 2026: pasado el mes, se corrige con una bonificación.');
      expect(motivo(credito)).toContain('un recargo');
    });

    test('el cargo que creó un recibo con pagos pide anular primero esos pagos', () => {
      const origen = asiento({ id: 'cargo-1', receiptId: 'recibo-1' });
      const conPagos = ctx({ origenes: new Map([['recibo-1', 'cargo-1']]), recibosConPagos: new Set(['recibo-1']) });
      expect(codigo(origen, conPagos)).toBe('RECIBO_CON_PAGOS');
      // Sin pagos, o si el asiento no es el que creó el recibo (un ajuste posterior), se puede.
      expect(codigo(origen, ctx({ origenes: new Map([['recibo-1', 'cargo-1']]) }))).toBe('OK');
      expect(codigo(asiento({ id: 'ajuste-2', receiptId: 'recibo-1', tipo: 'AJUSTE' }), conPagos)).toBe('OK');
    });
  });
});
