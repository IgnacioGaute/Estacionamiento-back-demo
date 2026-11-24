import { operationContext } from 'src/common/operation-context';
import { efectivoDeclarado } from './efectivo-recibido';

const codigo = (fn: () => unknown) => {
  try { fn(); } catch (e: any) { return e.getResponse?.().code; }
  return null;
};

describe('efectivoDeclarado', () => {
  test('pago justo: recibido igual a lo aplicado y vuelto cero', () => {
    expect(efectivoDeclarado(3500, 3500)).toEqual({ efectivoRecibido: 3500, vuelto: 0 });
  });

  test('con vuelto: el servidor lo calcula', () => {
    expect(efectivoDeclarado(3500, 10000)).toEqual({ efectivoRecibido: 10000, vuelto: 6500 });
  });

  test('pago mixto: el vuelto es contra el efectivo aplicado, no contra el total', () => {
    // Total $5.000: $2.000 en efectivo y $3.000 por transferencia; entrega un billete de $5.000.
    expect(efectivoDeclarado(2000, 5000)).toEqual({ efectivoRecibido: 5000, vuelto: 3000 });
  });

  test('lo recibido que no alcanza se rechaza: no se convierte en descuento ni en deuda', () => {
    expect(codigo(() => efectivoDeclarado(3500, 3000))).toBe('EFECTIVO_INSUFICIENTE');
  });

  test('sin «Calcular vuelto» el cobro se confirma igual y queda sin informar, sin asumir pago justo', () => {
    expect(efectivoDeclarado(3500, undefined)).toBeNull();
    expect(efectivoDeclarado(3500, null)).toBeNull();
  });

  test('sin efectivo aplicado no se declaran billetes', () => {
    expect(efectivoDeclarado(0, undefined)).toBeNull();
    expect(codigo(() => efectivoDeclarado(0, 1000))).toBe('EFECTIVO_RECIBIDO_SIN_EFECTIVO');
  });

  test('importes con centavos o negativos se rechazan', () => {
    expect(codigo(() => efectivoDeclarado(1000, 1000.5))).toBe('EFECTIVO_RECIBIDO_INVALIDO');
    expect(codigo(() => efectivoDeclarado(1000, -1))).toBe('EFECTIVO_RECIBIDO_INVALIDO');
  });

  test('una operación sin conexión guardada por una versión anterior se sincroniza sin el dato', () => {
    const resultado = operationContext.run({} as never, () => efectivoDeclarado(3500, undefined));
    expect(resultado).toBeNull();
    // Si la operación lo trae, se valida igual.
    expect(codigo(() => operationContext.run({} as never, () => efectivoDeclarado(3500, 100)))).toBe('EFECTIVO_INSUFICIENTE');
  });
});
