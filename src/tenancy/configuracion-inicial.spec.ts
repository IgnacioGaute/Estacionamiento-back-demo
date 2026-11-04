import { BadRequestException } from '@nestjs/common';
import { aplicarAvance } from './configuracion-inicial';

const ahora = new Date('2026-11-02T15:00:00.000Z');

describe('aplicarAvance', () => {
  it('suma pasos hechos en el orden del recorrido, sin repetir, y recuerda dónde quedó', () => {
    let estado = aplicarAvance({}, { hecho: 'ubicacion', paso: 'vehiculos' }, ahora);
    estado = aplicarAvance(estado, { hecho: 'nombre' }, ahora);
    estado = aplicarAvance(estado, { hecho: 'nombre' }, ahora);
    expect(estado).toEqual({ hechos: ['nombre', 'ubicacion'], omitidos: [], paso: 'vehiculos' });
  });

  it('omitir solo vale para pases, turnos, MercadoPago y usuarios', () => {
    expect(aplicarAvance({}, { omitido: 'mercadopago' }, ahora).omitidos).toEqual(['mercadopago']);
    expect(aplicarAvance({}, { omitido: 'pases' }, ahora).omitidos).toEqual(['pases']);
    expect(() => aplicarAvance({}, { omitido: 'tarifas' }, ahora)).toThrow(BadRequestException);
  });

  it('un paso omitido que después se completa deja de figurar como omitido, y al revés', () => {
    const omitido = aplicarAvance({}, { omitido: 'turnos' }, ahora);
    const hecho = aplicarAvance(omitido, { hecho: 'turnos' }, ahora);
    expect(hecho).toMatchObject({ hechos: ['turnos'], omitidos: [] });
    expect(aplicarAvance(hecho, { omitido: 'turnos' }, ahora)).toMatchObject({ hechos: [], omitidos: ['turnos'] });
  });

  it('terminar exige los pasos obligatorios y no cambia la fecha si se repite', () => {
    const casi = { hechos: ['nombre', 'ubicacion', 'vehiculos'] as const };
    try {
      aplicarAvance({ hechos: [...casi.hechos] }, { terminar: true }, ahora);
      throw new Error('debía rechazarse');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'CONFIGURACION_INCOMPLETA', faltan: ['tarifas'] });
    }
    const terminada = aplicarAvance({ hechos: [...casi.hechos] }, { hecho: 'tarifas', omitido: 'usuarios', terminar: true }, ahora);
    expect(terminada.terminadaEn).toBe(ahora.toISOString());
    expect(aplicarAvance(terminada, { terminar: true }, new Date('2026-12-01T00:00:00Z')).terminadaEn).toBe(ahora.toISOString());
  });
});
