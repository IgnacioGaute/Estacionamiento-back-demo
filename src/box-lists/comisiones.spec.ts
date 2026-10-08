import { validate } from 'class-validator';
import { tenantContext } from 'src/tenancy/tenant-context';
import { CuentaMercadoPago } from 'src/mercadopago/entities/cuenta-mercadopago.entity';
import { BoxListsService } from './box-lists.service';
import { claveComision, COMISIONES_CERO, COMISIONES_REFERENCIA, EvidenciaComisiones, resumenConComisiones } from './comisiones';
import { ComisionesCajaDto } from './dto/comisiones-caja.dto';

const evidencia = (): EvidenciaComisiones => ({ movimientos: new Map(), abonos: new Map(), inquilinos: new Map() });
describe('Comisiones por canal y medio de Mercado Pago', () => {
  it.each(['QR', 'ALIAS'] as const)('clasifica %s sólo con tipos informados', canal => {
    const p = canal === 'QR' ? 'qr' : 'alias';
    expect(claveComision(canal, 'credit_card')).toBe(p + 'Credito');
    expect(claveComision(canal, 'debit_card')).toBe(p + 'Debito');
    expect(claveComision(canal, 'bank_transfer')).toBe(p + 'Saldo');
    expect(claveComision(canal, 'account_money')).toBe(p + 'Saldo');
    expect(claveComision(canal, undefined)).toBeNull();
    expect(claveComision(canal, 'prepaid_card')).toBeNull();
  });
  it('aplica seis porcentajes distintos sin alterar los tickets ni el efectivo', () => {
    const tasas = { qrSaldo: 1, qrDebito: 2, qrCredito: 3, aliasSaldo: 4, aliasDebito: 5, aliasCredito: 6 };
    const e = evidencia();
    const ticketMovements = Object.keys(tasas).map((id, index) => {
      e.movimientos.set(id, id as keyof typeof tasas);
      return { id, metodo: index < 3 ? 'MERCADOPAGO' : 'TRANSFER', monto: 1000, tipo: 'SALDO' };
    });
    const box = { totalPrice: 3000, ticketMovements };
    const antes = JSON.stringify(box);
    expect(resumenConComisiones(box, tasas, e)).toMatchObject({ totalAntesComisiones: 9000, comisionEstimada: 210, totalNetoEstimado: 8790, importePendienteComision: 0 });
    expect(JSON.stringify(box)).toBe(antes);
  });
  it('no aplica comisión MP a transferencias manuales, recibos ni gastos', () => {
    const box = { totalPrice: 500, ticketMovements: [{ id: 'manual', metodo: 'TRANSFER', monto: 1000, tipo: 'SALDO' }],
      receiptPayments: [{ paymentType: 'TRANSFER', price: 1000 }], otherPayments: [{ paymentMethod: 'TRANSFER', type: 'EGRESOS', price: 100 }] };
    expect(resumenConComisiones(box, { ...COMISIONES_REFERENCIA, aliasSaldo: 99 })).toMatchObject({ totalAntesComisiones: 2400, totalNetoEstimado: 2400, comisionEstimada: 0 });
  });
  it('medio faltante y alias crédito sin tasa quedan pendientes, nunca se asumen saldo ni 0%', () => {
    const e = evidencia(); e.movimientos.set('alias', 'aliasCredito');
    const result = resumenConComisiones({ totalPrice: 0, ticketMovements: [
      { id: 'qr', metodo: 'MERCADOPAGO', monto: 1000, tipo: 'SALDO' },
      { id: 'alias', metodo: 'TRANSFER', monto: 2000, tipo: 'SALDO' },
    ] }, COMISIONES_REFERENCIA, e);
    expect(result).toMatchObject({ totalNetoEstimado: 3000, importePendienteComision: 3000, comisionEstimada: 0 });
    expect(result.medios.every(m => m.porcentaje === null)).toBe(true);
  });
  it('cero explícito permite una comisión bonificada', () => {
    const e = evidencia(); e.movimientos.set('qr', 'qrCredito');
    expect(resumenConComisiones({ totalPrice: 0, ticketMovements: [{ id: 'qr', metodo: 'MERCADOPAGO', monto: 1000, tipo: 'SALDO' }] }, COMISIONES_CERO, e)).toMatchObject({ comisionEstimada: 0, importePendienteComision: 0, totalNetoEstimado: 1000 });
  });
  it('redondea cada operación y conserva cuatro decimales del porcentaje final con IVA', () => {
    const e = evidencia(); ['a','b','c'].forEach(id => e.movimientos.set(id, 'qrDebito'));
    const result = resumenConComisiones({ totalPrice: 0, ticketMovements: ['a','b','c'].map(id => ({ id, monto: 10, metodo: 'MERCADOPAGO', tipo: 'SALDO' })) }, COMISIONES_REFERENCIA, e);
    expect(result.comisionEstimada).toBe(0.48);
    expect(result.totalNetoEstimado).toBe(29.52);
  });
  it('omite cortesías, abonos impagos y duplicados de recibos; una devolución no reintegra comisión', () => {
    const e = evidencia(); e.inquilinos.set('p', 'qrCredito'); e.abonos.set('a', 'qrDebito');
    const result = resumenConComisiones({ totalPrice: 0,
      ticketMovements: [{ metodo: 'MERCADOPAGO', monto: 500, tipo: 'CORTESIA' }],
      ticketRegistrationForDays: [{ id: 'a', paid: true, price: 100, paymentMetodo: 'MERCADOPAGO' }, { id: 'b', paid: false, price: 300, paymentMetodo: 'MERCADOPAGO' }],
      cobrosInquilinos: [{ id: 'p', metodo: 'MERCADOPAGO', monto: 1000 }, { id: 'd', metodo: 'MERCADOPAGO', monto: -1000 }],
      receiptPayments: [{ paymentType: 'MERCADOPAGO', price: 1000, cuentaMovimientoId: 'p' }],
    }, { ...COMISIONES_CERO, qrCredito: 5, qrDebito: 1 }, e);
    expect(result).toMatchObject({ totalAntesComisiones: 100, comisionEstimada: 51, totalNetoEstimado: 49 });
  });
  it.each([-1, 100.01, NaN, Infinity, 1.23456, '5', undefined])('rechaza porcentaje inválido: %s', async valor => {
    expect((await validate(Object.assign(new ComisionesCajaDto(), COMISIONES_REFERENCIA, { qrSaldo: valor }))).length).toBeGreaterThan(0);
  });
  it('acepta null como pendiente, 0, 100 y cuatro decimales', async () => {
    expect(await validate(Object.assign(new ComisionesCajaDto(), COMISIONES_REFERENCIA, { qrSaldo: 100, qrDebito: 0 }))).toHaveLength(0);
  });
});
describe('Configuración por empresa y cuenta vinculada', () => {
  const empresas = { a: { comisionesMp: null }, b: { comisionesMp: null } };
  let conectada = true;
  const repo = { findOneBy: jest.fn(async ({ id }) => empresas[id]), update: jest.fn(async ({ id }, cambios) => { Object.assign(empresas[id], cambios); }) };
  const getRepository = (entity: any) => entity === CuentaMercadoPago ? { existsBy: async () => conectada } : repo;
  const service = new BoxListsService({} as any, {} as any, { getRepository, manager: { getRepository } } as any);
  const scope = (empresaId: string, role = 'ADMIN') => ({ empresaId, role, playaId: 'playa', userId: 'usuario' });
  it('comparte configuración sólo dentro de la empresa y usa valores de referencia', async () => {
    await tenantContext.run(scope('a'), async () => {
      expect((await service.getComisiones()).tasas).toEqual(COMISIONES_REFERENCIA);
      expect((await service.configurarComisiones(COMISIONES_CERO)).tasas).toEqual(COMISIONES_CERO);
    });
    expect((await tenantContext.run(scope('b'), () => service.getComisiones())).tasas).toEqual(COMISIONES_REFERENCIA);
    expect(repo.update).toHaveBeenCalledWith({ id: 'a' }, { comisionesMp: COMISIONES_CERO });
  });
  it('bloquea edición sin cuenta activa, de operadores y sin empresa', async () => {
    conectada = false;
    await expect(tenantContext.run(scope('a'), () => service.configurarComisiones(COMISIONES_CERO))).rejects.toThrow('Vinculá');
    await expect(tenantContext.run(scope('a', 'USER'), () => service.configurarComisiones(COMISIONES_CERO))).rejects.toThrow('administrador');
    await expect(service.getComisiones()).rejects.toThrow('empresa');
  });
});
