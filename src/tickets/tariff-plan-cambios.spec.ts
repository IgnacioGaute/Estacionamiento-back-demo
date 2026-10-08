import { cambiosDeTarifas } from './tariff-plan-cambios';
import { defaultPricingOptions, PricingBracket, PricingSchedule } from './pricing/pricing.types';

const vehiculos = [
  { code: 'AUTO', name: 'Auto' },
  { code: 'CAMIONETA', name: 'Camioneta' },
];

const horario = (cambios: Partial<PricingSchedule> = {}): PricingSchedule => ({
  dayStartHour: 8,
  dayEndHour: 20,
  graceMinutes: 10,
  pricingDayTypeBasis: 'EXIT',
  pricingOptions: defaultPricingOptions(),
  ...cambios,
});

const franja = (cambios: Partial<PricingBracket> = {}): PricingBracket => ({
  id: 'f1',
  vehicleType: 'AUTO',
  ticketDayType: 'DAY',
  label: 'Hasta 1 h',
  uptoMinutes: 60,
  price: 1200,
  recurringUnitMinutes: null,
  recurringPriceMode: 'FIXED',
  ...cambios,
});

describe('cambiosDeTarifas', () => {
  it('no anota nada si el plan quedó igual', () => {
    const plan = { schedule: horario(), brackets: [franja()] };
    expect(cambiosDeTarifas(plan, { ...plan }, vehiculos)).toEqual({});
  });

  it('cuenta el precio de una franja con el nombre del vehículo y del horario', () => {
    const cambios = cambiosDeTarifas(
      { schedule: horario(), brackets: [franja()] },
      { schedule: horario(), brackets: [franja({ price: 1500 })] },
      vehiculos,
    );
    expect(cambios).toEqual({
      'franjas.«Auto · Hasta 1 h · día».price': { de: 1200, a: 1500 },
    });
  });

  it('una franja nueva viene de nada y una quitada va a nada', () => {
    const cambios = cambiosDeTarifas(
      { schedule: horario(), brackets: [franja()] },
      {
        schedule: horario(),
        brackets: [franja({ id: 'f2', vehicleType: 'CAMIONETA', ticketDayType: null, label: 'Estadía', uptoMinutes: null, price: 9000 })],
      },
      vehiculos,
    );
    expect(cambios).toEqual({
      'franjas.«Camioneta · Estadía».price': { de: null, a: 9000 },
      'franjas.«Auto · Hasta 1 h · día».price': { de: 1200, a: null },
    });
  });

  it('un cambio de nombre es la misma franja, no una quitada y otra agregada', () => {
    const cambios = cambiosDeTarifas(
      { schedule: horario(), brackets: [franja()] },
      { schedule: horario(), brackets: [franja({ label: 'Primera hora' })] },
      vehiculos,
    );
    expect(cambios).toEqual({
      'franjas.«Auto · Primera hora · día».label': { de: 'Hasta 1 h', a: 'Primera hora' },
    });
  });

  it('cambia los puntos de un nombre para no partir la ruta', () => {
    const cambios = cambiosDeTarifas(
      { schedule: horario(), brackets: [] },
      { schedule: horario(), brackets: [franja({ label: '1.5 h' })] },
      vehiculos,
    );
    expect(Object.keys(cambios)).toEqual(['franjas.«Auto · 1,5 h · día».price']);
  });

  it('anota el horario, la forma de cobro por vehículo y los cruces', () => {
    const despues = defaultPricingOptions();
    despues.charging = { enabled: true, mode: 'COMPLETED', unitMinutes: 60, rates: [{ vehicleType: 'AUTO', dayPrice: 1000, nightPrice: 1300 }] };
    despues.crossing = { enabled: true, mode: 'SPLIT' };
    const cambios = cambiosDeTarifas(
      { schedule: horario(), brackets: [] },
      { schedule: horario({ graceMinutes: 15, pricingOptions: despues }), brackets: [] },
      vehiculos,
    );
    expect(cambios).toEqual({
      graceMinutes: { de: 10, a: 15 },
      'pricingOptions.charging.enabled': { de: false, a: true },
      'pricingOptions.charging.mode': { de: 'STARTED', a: 'COMPLETED' },
      'pricingOptions.charging.«Auto».dayPrice': { de: null, a: 1000 },
      'pricingOptions.charging.«Auto».nightPrice': { de: null, a: 1300 },
      'pricingOptions.crossing.enabled': { de: false, a: true },
      'pricingOptions.crossing.mode': { de: 'EXIT', a: 'SPLIT' },
    });
  });
});
