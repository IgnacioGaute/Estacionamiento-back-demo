import {
  correspondeFactura,
  DatosCuenta,
  finDePrueba,
  periodoDelPago,
  situacionDeCuenta,
  sumarMeses,
} from './estado-cuenta';

const cuenta = (extra: Partial<DatosCuenta> = {}): DatosCuenta => ({
  empresaEstado: 'ACTIVA',
  alta: '2026-03-01',
  bonificada: false,
  pruebaHasta: null,
  pagadoHasta: null,
  prorrogaHasta: null,
  motivoSuspension: null,
  ...extra,
});

describe('Estado de la cuenta con la plataforma', () => {
  test('sin prueba ni pago no vence: queda sin activar', () => {
    const s = situacionDeCuenta(cuenta(), '2026-06-01');
    expect(s.estado).toBe('SIN_ACTIVAR');
    expect(s.suspendeEl).toBeNull();
  });

  test('el alta cuenta como primer día de prueba; con 0 días la factura vence el día del alta', () => {
    expect(finDePrueba('2026-03-01', 7)).toBe('2026-03-07');
    expect(finDePrueba('2026-03-01', 0)).toBe('2026-02-28');
  });

  test('en prueba hasta el último día, y al día siguiente la factura ya venció ese día', () => {
    const datos = cuenta({ pruebaHasta: '2026-03-07' });
    expect(situacionDeCuenta(datos, '2026-03-07').estado).toBe('PRUEBA');
    const vencida = situacionDeCuenta(datos, '2026-03-08');
    expect(vencida.estado).toBe('VENCIDA');
    expect(vencida.proximoVencimiento).toBe('2026-03-08');
    expect(vencida.diasDeAtraso).toBe(0);
  });

  test('se suspende recién con más de cinco días de atraso', () => {
    const datos = cuenta({ pagadoHasta: '2026-04-30' });
    const quinto = situacionDeCuenta(datos, '2026-05-06');
    expect(quinto.diasDeAtraso).toBe(5);
    expect(quinto.debeSuspenderse).toBe(false);
    expect(quinto.suspendeEl).toBe('2026-05-07');
    const sexto = situacionDeCuenta(datos, '2026-05-07');
    expect(sexto.diasDeAtraso).toBe(6);
    expect(sexto.debeSuspenderse).toBe(true);
  });

  test('con débito automático la gracia es de diez días', () => {
    const s = situacionDeCuenta(
      cuenta({ pagadoHasta: '2026-04-30', conDebito: true }),
      '2026-05-08',
    );
    expect(s.diasDeGracia).toBe(10);
    expect(s.debeSuspenderse).toBe(false);
  });

  test('los días extra corren el corte, no el vencimiento', () => {
    const s = situacionDeCuenta(
      cuenta({ pagadoHasta: '2026-04-30', prorrogaHasta: '2026-05-20' }),
      '2026-05-15',
    );
    expect(s.proximoVencimiento).toBe('2026-05-01');
    expect(s.diasDeAtraso).toBe(14);
    expect(s.debeSuspenderse).toBe(false);
    expect(s.suspendeEl).toBe('2026-05-21');
  });

  test('bonificada no vence ni acumula atraso', () => {
    const s = situacionDeCuenta(
      cuenta({ bonificada: true, pagadoHasta: '2026-01-31' }),
      '2026-06-01',
    );
    expect(s.estado).toBe('BONIFICADA');
    expect(s.diasDeAtraso).toBe(0);
    expect(
      correspondeFactura(
        cuenta({ bonificada: true, pagadoHasta: '2026-01-31' }),
        '2026-06-01',
      ),
    ).toBe(false);
  });

  test('el estado de la empresa manda sobre las fechas', () => {
    expect(
      situacionDeCuenta(
        cuenta({ empresaEstado: 'SUSPENDIDA', pagadoHasta: '2026-12-31' }),
        '2026-06-01',
      ).estado,
    ).toBe('SUSPENDIDA');
    expect(
      situacionDeCuenta(
        cuenta({ empresaEstado: 'BAJA', pagadoHasta: '2026-12-31' }),
        '2026-06-01',
      ).estado,
    ).toBe('BAJA');
  });

  test.each([
    ['2026-01-31', '2026-02-28'],
    ['2026-02-28', '2026-03-31'],
    ['2026-01-15', '2026-02-15'],
  ])(
    'un mes después de %p es %p (el fin de mes sigue siendo fin de mes)',
    (desde, hasta) => {
      expect(sumarMeses(desde, 1)).toBe(hasta);
    },
  );

  test('un pago atrasado sigue desde el vencimiento; cortada por falta de pago arranca el día del pago', () => {
    const atrasada = cuenta({ pagadoHasta: '2026-04-30' });
    expect(periodoDelPago(atrasada, 1, '2026-05-04')).toEqual({
      desde: '2026-05-01',
      hasta: '2026-05-31',
    });
    const cortada = cuenta({
      pagadoHasta: '2026-04-30',
      empresaEstado: 'SUSPENDIDA',
      motivoSuspension: 'FALTA_DE_PAGO',
    });
    expect(periodoDelPago(cortada, 1, '2026-06-10')).toEqual({
      desde: '2026-06-10',
      hasta: '2026-07-09',
    });
  });
});
