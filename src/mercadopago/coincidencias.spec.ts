import {
  GRACIA_PAGO_TARDIO_MS,
  IntentoParaDecidir,
  TransferenciaParaDecidir,
  decidir,
  esTransferenciaRecibida,
} from './coincidencias';

const T0 = new Date('2026-10-06T15:00:00Z');
const en = (segundos: number) => new Date(T0.getTime() + segundos * 1000);

const intento = (
  id: string,
  extra: Partial<IntentoParaDecidir> = {},
): IntentoParaDecidir => ({
  id,
  importe: 3500,
  moneda: 'ARS',
  estado: 'ESPERANDO',
  buscarDesde: en(-60),
  cerradoEl: null,
  ...extra,
});

const transferencia = (
  operacionId: string,
  extra: Partial<TransferenciaParaDecidir> = {},
): TransferenciaParaDecidir => ({
  operacionId,
  importe: 3500,
  moneda: 'ARS',
  fechaOperacion: en(20),
  estado: 'DISPONIBLE',
  ...extra,
});

// Lo que devolvió MercadoPago en la prueba real (05/10/2026), recortado a lo que se mira.
const alCvu = {
  collector_id: 111,
  status: 'approved',
  currency_id: 'ARS',
  transaction_amount: 15,
  operation_type: 'account_fund',
  payment_type_id: 'bank_transfer',
  payment_method_id: 'cvu',
  point_of_interaction: { type: 'PSP_TRANSFER' },
};

describe('Qué cuenta como transferencia recibida', () => {
  test('la transferencia al CVU de la prueba real', () => {
    expect(esTransferenciaRecibida(alCvu, '111')).toBe(true);
  });

  test('una transferencia entre cuentas de MercadoPago', () => {
    expect(
      esTransferenciaRecibida(
        {
          collector_id: 111,
          status: 'approved',
          currency_id: 'ARS',
          transaction_amount: 10,
          operation_type: 'money_transfer',
          payment_type_id: 'account_money',
        },
        '111',
      ),
    ).toBe(true);
  });

  test.each([
    ['otra cuenta la cobró', { collector_id: 222 }],
    ['sin cobrador informado', { collector_id: undefined }],
    ['pendiente', { status: 'pending' }],
    ['rechazada', { status: 'rejected' }],
    ['en dólares', { currency_id: 'USD' }],
    ['sin importe', { transaction_amount: 0 }],
    ['generada por el sistema (QR)', { external_reference: 'cobro-1' }],
    [
      'tarjeta de crédito',
      {
        operation_type: 'regular_payment',
        payment_type_id: 'credit_card',
        point_of_interaction: { type: 'CHECKOUT' },
      },
    ],
    [
      'suscripción',
      {
        operation_type: 'recurring_payment',
        payment_type_id: 'credit_card',
        point_of_interaction: { type: 'SUBSCRIPTIONS' },
      },
    ],
    [
      'pago con QR en un local',
      {
        operation_type: 'regular_payment',
        payment_type_id: 'account_money',
        point_of_interaction: { type: 'INSTORE' },
      },
    ],
    [
      'PSP_TRANSFER que no es bank_transfer',
      { payment_type_id: 'account_money' },
    ],
  ])('queda afuera: %s', (_, cambio) => {
    expect(esTransferenciaRecibida({ ...alCvu, ...cambio }, '111')).toBe(false);
  });
});

describe('Cuándo se confirma sola y cuándo pasa a revisión', () => {
  test('una transferencia y un solo cobro esperándola: se confirma', () => {
    const a = intento('a');
    expect(decidir(a, [transferencia('op1')], [a])).toEqual({
      tipo: 'CONFIRMAR',
      operacionId: 'op1',
    });
  });

  test('todavía no entró nada: espera', () => {
    const a = intento('a');
    expect(decidir(a, [], [a])).toEqual({ tipo: 'ESPERAR' });
  });

  test('dos transferencias del mismo importe: revisión con las dos', () => {
    const a = intento('a');
    expect(
      decidir(
        a,
        [
          transferencia('op1'),
          transferencia('op2', { fechaOperacion: en(40) }),
        ],
        [a],
      ),
    ).toEqual({
      tipo: 'REVISION',
      motivo: 'VARIAS_TRANSFERENCIAS',
      operaciones: ['op1', 'op2'],
    });
  });

  test('una transferencia y dos cobros del mismo importe (aunque sean de otra playa): revisión', () => {
    const a = intento('a');
    const otraPlaya = intento('b', { buscarDesde: en(-30) });
    expect(decidir(a, [transferencia('op1')], [a, otraPlaya])).toMatchObject({
      tipo: 'REVISION',
      motivo: 'VARIOS_COBROS',
    });
  });

  test('otro importe no compite', () => {
    const a = intento('a');
    const b = intento('b', { importe: 4000 });
    expect(decidir(a, [transferencia('op1')], [a, b])).toMatchObject({
      tipo: 'CONFIRMAR',
    });
    expect(
      decidir(a, [transferencia('op1', { importe: 3500.5 })], [a]),
    ).toEqual({ tipo: 'ESPERAR' });
  });

  test('una transferencia ya usada no se vuelve a ofrecer', () => {
    const a = intento('a');
    expect(
      decidir(a, [transferencia('op1', { estado: 'USADA' })], [a]),
    ).toEqual({ tipo: 'ESPERAR' });
  });

  test('una transferencia anterior al período de búsqueda no cuenta', () => {
    const a = intento('a');
    expect(
      decidir(a, [transferencia('op1', { fechaOperacion: en(-61) })], [a]),
    ).toEqual({ tipo: 'ESPERAR' });
  });

  test('un cobro cancelado hace poco compite: un pago tardío no se le da al siguiente', () => {
    const a = intento('a', { buscarDesde: en(0) });
    const cancelado = intento('b', {
      estado: 'CANCELADO',
      buscarDesde: en(-300),
      cerradoEl: en(-10),
    });
    expect(decidir(a, [transferencia('op1')], [a, cancelado])).toMatchObject({
      tipo: 'REVISION',
      motivo: 'VARIOS_COBROS',
    });
    const viejo = {
      ...cancelado,
      cerradoEl: new Date(en(20).getTime() - GRACIA_PAGO_TARDIO_MS - 1000),
    };
    expect(decidir(a, [transferencia('op1')], [a, viejo])).toMatchObject({
      tipo: 'CONFIRMAR',
    });
  });

  test('un cobro ya confirmado no compite', () => {
    const a = intento('a');
    const b = intento('b', { estado: 'CONFIRMADO', cerradoEl: en(5) });
    expect(decidir(a, [transferencia('op1')], [a, b])).toMatchObject({
      tipo: 'CONFIRMAR',
    });
  });

  test('una transferencia que ya quedó en revisión no se confirma sola', () => {
    const a = intento('a');
    expect(
      decidir(a, [transferencia('op1', { estado: 'REVISION' })], [a]),
    ).toMatchObject({ tipo: 'REVISION', motivo: 'YA_EN_REVISION' });
  });

  test('un cobro en revisión no se confirma solo aunque quede una sola opción', () => {
    const a = intento('a', { estado: 'REVISION' });
    expect(decidir(a, [transferencia('op1')], [a])).toEqual({
      tipo: 'REVISION',
      motivo: 'YA_EN_REVISION',
      operaciones: ['op1'],
    });
  });
});
