import { cambiosDeDesglose, conteoDelArqueo, DENOMINACIONES, desgloseValido } from './conteo-billetes';

const codigo = (fn: () => unknown) => {
  try { fn(); } catch (e: any) { return e.getResponse?.().code; }
  return null;
};

describe('conteo por billetes', () => {
  test('las denominaciones van de mayor a menor y llegan a $1', () => {
    expect([...DENOMINACIONES]).toEqual([...DENOMINACIONES].sort((a, b) => b - a));
    expect(DENOMINACIONES[DENOMINACIONES.length - 1]).toBe(1);
  });

  test('el total lo calcula el servidor; se guarda ordenado y sin ceros', () => {
    const r = desgloseValido([{ denominacion: 1000, cantidad: 3 }, { denominacion: 20000, cantidad: 2 }, { denominacion: 500, cantidad: 0 }, { denominacion: 5, cantidad: 1 }]);
    expect(r.total).toBe(43005);
    expect(r.desglose).toEqual([{ denominacion: 20000, cantidad: 2 }, { denominacion: 1000, cantidad: 3 }, { denominacion: 5, cantidad: 1 }]);
  });

  test('«No hay efectivo» es un desglose vacío de $0', () => {
    expect(desgloseValido([])).toEqual({ total: 0, desglose: [] });
  });

  test('rechaza denominaciones no admitidas, cantidades no enteras o negativas y repetidas', () => {
    expect(codigo(() => desgloseValido([{ denominacion: 300, cantidad: 1 }]))).toBe('CONTEO_BILLETES_INVALIDO');
    expect(codigo(() => desgloseValido([{ denominacion: 1000, cantidad: 1.5 }]))).toBe('CONTEO_BILLETES_INVALIDO');
    expect(codigo(() => desgloseValido([{ denominacion: 1000, cantidad: -1 }]))).toBe('CONTEO_BILLETES_INVALIDO');
    expect(codigo(() => desgloseValido([{ denominacion: 1000, cantidad: 1 }, { denominacion: 1000, cantidad: 2 }]))).toBe('CONTEO_BILLETES_INVALIDO');
  });

  test('no confía en el total de la pantalla: uno distinto del desglose se rechaza', () => {
    expect(codigo(() => conteoDelArqueo({ desglose: [{ denominacion: 1000, cantidad: 2 }], efectivoContado: 3000 }))).toBe('CONTEO_NO_COINCIDE');
    const dto: { desglose: { denominacion: number; cantidad: number }[]; efectivoContado?: number; primerConteo?: number } = { desglose: [{ denominacion: 1000, cantidad: 2 }] };
    const r = conteoDelArqueo(dto);
    expect(dto.efectivoContado).toBe(2000);
    expect(dto.primerConteo).toBe(2000);
    expect(r.primerDesglose).toEqual(r.desglose);
  });

  test('conserva el primer conteo y su desglose cuando se vuelve a contar', () => {
    const dto = { desglose: [{ denominacion: 1000, cantidad: 5 }], primerConteoDesglose: [{ denominacion: 1000, cantidad: 3 }], primerConteo: 3000 } as Parameters<typeof conteoDelArqueo>[0];
    const r = conteoDelArqueo(dto);
    expect(dto.efectivoContado).toBe(5000);
    expect(dto.primerConteo).toBe(3000);
    expect(r.primerDesglose).toEqual([{ denominacion: 1000, cantidad: 3 }]);
    expect(cambiosDeDesglose(r.primerDesglose, r.desglose)).toBe('Billetes corregidos: $1.000: de 3 a 5.');
  });

  test('sin desglose no inventa uno (cierres sin conexión anteriores)', () => {
    const dto = { efectivoContado: 5000, primerConteo: 4500 };
    expect(conteoDelArqueo(dto)).toEqual({ desglose: null, primerDesglose: null });
    expect(dto).toEqual({ efectivoContado: 5000, primerConteo: 4500 });
  });
});
