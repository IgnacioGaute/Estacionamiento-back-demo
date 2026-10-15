import { classifyPlateFormat, isPlausiblePlate, normalizePlate, patentesParecidas, toSearchKey } from './license-plate.util';

describe('Patentes parecidas', () => {
  test.each([
    ['HHH664', 'HHH644'],
    ['AB123CD', 'AB128CD'],
    ['AB123CD', 'A8123C0'],
    ['AB123CD', 'AB12CD'],
    ['ABC123', 'ABC1234'],
    ['AE972XA', 'AE972XY'],
    // Dos caracteres distintos todavía se avisan: un número y una letra.
    ['ZZ437ZX', 'ZZ438ZN'],
    ['ZZ430ZX', 'ZZ438ZN'],
    ['ABC12', 'ABD13'],
    ['AB123CD', 'AB13CD'],
  ])('%p y %p pueden ser el mismo auto', (a, b) => {
    expect(patentesParecidas(a, b)).toBe(true);
  });

  test.each([
    ['ABC123', 'ABC123'],
    // Desde tres caracteres distintos ya es otro auto.
    ['AB123CD', 'AB456CD'],
    ['ABC123', 'XYZ123'],
    ['ZZ437ZX', 'ZZ158ZN'],
    ['ABCD', 'ABCE'],
  ])('%p y %p no se ofrecen', (a, b) => {
    expect(patentesParecidas(a, b)).toBe(false);
  });
});

describe('Patentes', () => {
  test.each([
    ['ab 123 cd', 'AB123CD'],
    ['abc-123', 'ABC123'],
    ['  a.b.c 1 2 3 ', 'ABC123'],
  ])('normaliza %p como %p', (raw, expected) => {
    expect(normalizePlate(raw)).toBe(expected);
  });

  test('la búsqueda pliega los caracteres confundibles en las dos puntas', () => {
    // Se guarda y se busca con la misma clave: un 8 tipeado en lugar de una B encuentra la patente.
    expect(toSearchKey(normalizePlate('ABC123'))).toBe(toSearchKey(normalizePlate('A8C123')));
    expect(toSearchKey('OISB')).toBe('0158');
    expect(toSearchKey('ACD777')).toBe('ACD777');
  });

  test.each([
    ['ABC123', 'OLD_AUTO'],
    ['AB123CD', 'MERCOSUR_AUTO'],
    ['123ABC', 'OLD_MOTO'],
    ['A123BCD', 'MERCOSUR_MOTO'],
    ['ZZ', 'UNKNOWN'],
  ])('%p es %p', (plate, format) => {
    expect(classifyPlateFormat(plate)).toBe(format);
  });

  test('una patente plausible tiene entre 5 y 8 caracteres', () => {
    expect(isPlausiblePlate('ABCD')).toBe(false);
    expect(isPlausiblePlate('ABC12')).toBe(true);
    expect(isPlausiblePlate('AB123CDE')).toBe(true);
    expect(isPlausiblePlate('AB123CDEF')).toBe(false);
  });
});
