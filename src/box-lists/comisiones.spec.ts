import { validate } from 'class-validator';
import { tenantContext } from 'src/tenancy/tenant-context';
import { BoxListsService } from './box-lists.service';
import { COMISIONES_CERO, resumenConComisiones } from './comisiones';
import { ComisionesCajaDto } from './dto/comisiones-caja.dto';

describe('Comisiones estimadas de caja', () => {
  const tasas = { qrPorcentaje: 5, transferenciaPorcentaje: 1 };
  it('suma efectivo y pagos digitales sin alterar el bruto del ticket ni el cajón', () => {
    const box = { totalPrice: 3000, ticketMovements: [
      { monto: 10000, metodo: 'MERCADOPAGO', tipo: 'SALDO' },
      { monto: 2000, metodo: 'TRANSFER', tipo: 'ANTICIPO' },
      { monto: 3000, metodo: 'CASH', tipo: 'SALDO' },
    ] };
    const antes = JSON.stringify(box);
    expect(resumenConComisiones(box, tasas)).toMatchObject({ efectivo: 3000, totalAntesComisiones: 15000, comisionEstimada: 520, totalNetoEstimado: 14480 });
    expect(JSON.stringify(box)).toBe(antes);
  });
  it('cero por defecto conserva el total y cada empresa puede recalcular su estimación', () => {
    const box = { totalPrice: 0, ticketMovements: [{ monto: 100, metodo: 'TRANSFER', tipo: 'SALDO' }] };
    expect(resumenConComisiones(box, COMISIONES_CERO).totalNetoEstimado).toBe(100);
    expect(resumenConComisiones(box, tasas).totalNetoEstimado).toBe(99);
  });
  it('excluye cortesías y abonos impagos y suma el abono pagado', () => {
    expect(resumenConComisiones({ totalPrice: 0,
      ticketMovements: [{ monto: 1000, metodo: 'MERCADOPAGO', tipo: 'CORTESIA' }],
      ticketRegistrationForDays: [{ paid: false, price: 500, paymentMetodo: 'MERCADOPAGO' }, { paid: true, price: 200, paymentMetodo: 'MERCADOPAGO' }],
    }, tasas)).toMatchObject({ totalAntesComisiones: 200, comisionEstimada: 10, totalNetoEstimado: 190 });
  });
  it('cuenta una sola vez un pago de inquilino imputado a varios recibos', () => {
    expect(resumenConComisiones({ totalPrice: 0,
      cobrosInquilinos: [{ metodo: 'MERCADOPAGO', monto: 10000 }],
      receiptPayments: [{ paymentType: 'MERCADOPAGO', price: 6000, cuentaMovimientoId: 'pago' }, { paymentType: 'MERCADOPAGO', price: 4000, cuentaMovimientoId: 'pago' }, { paymentType: 'TRANSFER', price: 1000 }],
      paymentHistoryOnAccount: [{ paymentType: 'CREDIT', price: 9999 }],
    }, tasas)).toMatchObject({ totalAntesComisiones: 11000, comisionEstimada: 510, totalNetoEstimado: 10490 });
  });
  it('resta egresos y devoluciones sin cobrar ni devolver una comisión supuesta', () => {
    expect(resumenConComisiones({ totalPrice: -100,
      ticketMovements: [{ monto: 1000, metodo: 'TRANSFER', tipo: 'SALDO' }, { monto: -1000, metodo: 'TRANSFER', tipo: 'AJUSTE' }],
      otherPayments: [{ paymentMethod: 'TRANSFER', type: 'EGRESOS', price: 200 }, { paymentMethod: 'TRANSFER', type: 'INGRESOS', price: 100 }],
    }, tasas)).toMatchObject({ totalAntesComisiones: -200, comisionEstimada: 11, totalNetoEstimado: -211 });
  });
  it('redondea por cobro a centavos', () => {
    const result = resumenConComisiones({ totalPrice: 0, ticketMovements: Array.from({ length: 3 }, () => ({ monto: 10, metodo: 'MERCADOPAGO', tipo: 'SALDO' })) }, { qrPorcentaje: 1.35, transferenciaPorcentaje: 0 });
    expect(result.comisionEstimada).toBe(0.42);
    expect(result.totalNetoEstimado).toBe(29.58);
  });
  it.each([-1, 100.01, NaN, Infinity, 1.234, '5', null, undefined])('rechaza porcentaje inválido: %s', async valor => {
    expect((await validate(Object.assign(new ComisionesCajaDto(), { qrPorcentaje: valor, transferenciaPorcentaje: 0 }))).length).toBeGreaterThan(0);
  });
  it('acepta 0 y 100', async () => {
    expect(await validate(Object.assign(new ComisionesCajaDto(), { qrPorcentaje: 100, transferenciaPorcentaje: 0 }))).toHaveLength(0);
  });
});

describe('Configuración por empresa', () => {
  const empresas = { a: { comisionQrPorcentaje: '5.00', comisionTransferenciaPorcentaje: '1.00' }, b: { comisionQrPorcentaje: '0.00', comisionTransferenciaPorcentaje: '0.00' } };
  const repo = { findOneBy: jest.fn(async ({ id }) => empresas[id]), update: jest.fn(async ({ id }, cambios) => { Object.assign(empresas[id], cambios); }) };
  const ds = { getRepository: () => repo, manager: { getRepository: () => repo } };
  const service = new BoxListsService({} as any, {} as any, ds as any);
  const scope = (empresaId: string, role = 'ADMIN') => ({ empresaId, role, playaId: 'playa', userId: 'usuario' });
  it('lee y edita únicamente la empresa de la sesión', async () => {
    await tenantContext.run(scope('a'), async () => {
      expect(await service.getComisiones()).toEqual({ qrPorcentaje: 5, transferenciaPorcentaje: 1 });
      expect(await service.configurarComisiones({ qrPorcentaje: 6, transferenciaPorcentaje: 2 })).toEqual({ qrPorcentaje: 6, transferenciaPorcentaje: 2 });
    });
    expect(await tenantContext.run(scope('b'), () => service.getComisiones())).toEqual(COMISIONES_CERO);
    expect(repo.update).toHaveBeenCalledWith({ id: 'a' }, { comisionQrPorcentaje: 6, comisionTransferenciaPorcentaje: 2 });
  });
  it('rechaza cambios de un operador y consultas sin empresa', async () => {
    await expect(tenantContext.run(scope('a', 'USER'), () => service.configurarComisiones(COMISIONES_CERO))).rejects.toThrow('administrador');
    await expect(service.getComisiones()).rejects.toThrow('empresa');
  });
});
