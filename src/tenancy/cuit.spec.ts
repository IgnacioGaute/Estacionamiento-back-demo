import { cuitValido, normalizarCuit } from './cuit';

describe('CUIT', () => {
  it('acepta un CUIT con su verificador y lo guarda sin guiones', () => {
    // 20-12345678-6: 2·5+0·4+1·3+2·2+3·7+4·6+5·5+6·4+7·3+8·2 = 148; 148 % 11 = 5; 11 − 5 = 6.
    expect(normalizarCuit('20-12345678-6')).toBe('20123456786');
    expect(normalizarCuit('20 12345678 6')).toBe('20123456786');
    expect(cuitValido('20123456786')).toBe(true);
  });

  it('rechaza un número cambiado, un largo distinto y letras', () => {
    expect(cuitValido('20123456787')).toBe(false);
    expect(cuitValido('2012345678')).toBe(false);
    expect(cuitValido('2012345678a')).toBe(false);
  });

  it('el verificador 0 sale de un resto 11', () => {
    // 20-00000006-0: 2·5 + 6·2 = 22, múltiplo de 11; 11 − 0 = 11 → verificador 0.
    expect(cuitValido('20000000060')).toBe(true);
  });

  it('no toca lo que no es texto', () => {
    expect(normalizarCuit(null)).toBeNull();
    expect(normalizarCuit(undefined)).toBeUndefined();
  });
});
