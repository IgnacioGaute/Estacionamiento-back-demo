import { calculatePrice, resolveDayType, selectBrackets, validateBracket } from './pricing';
import { PricingBracket, PricingSchedule } from './pricing.types';

const bracket = (id: string, uptoMinutes: number | null, price: number, extra: Partial<PricingBracket> = {}): PricingBracket => ({
  id, vehicleType: 'AUTO', ticketDayType: null, label: id, uptoMinutes, price, recurringUnitMinutes: null, ...extra,
});
const schedule: PricingSchedule = { dayStartHour: 8, dayEndHour: 20, graceMinutes: 5, pricingDayTypeBasis: 'EXIT' };

describe('Tarifas compartidas', () => {
  test.each([[7, 'NIGHT'], [8, 'DAY'], [19, 'DAY'], [20, 'NIGHT']])('horario a las %s', (hour, expected) => {
    expect(resolveDayType(schedule, Number(hour))).toBe(expected);
  });
  test('horario que cruza medianoche', () => {
    expect(resolveDayType({ ...schedule, dayStartHour: 20, dayEndHour: 8 }, 23)).toBe('DAY');
    expect(resolveDayType({ ...schedule, dayStartHour: 20, dayEndHour: 8 }, 12)).toBe('NIGHT');
  });
  const ladder = [bracket('15 min', 15, 500), bracket('1 h', 60, 2000), bracket('2 h', 120, 3500)];
  test.each([[0, 500], [15, 500], [20, 500], [21, 2000], [65, 2000], [66, 2500], [90, 3500], [120, 3500]])('duración %s', (minutes, price) => {
    expect(calculatePrice(ladder, 'AUTO', 'DAY', minutes, 5).price).toBe(price);
  });
  test('avisa cuando no hay cobertura', () => {
    expect(calculatePrice(ladder, 'AUTO', 'DAY', 121, 5)).toMatchObject({ price: 3500, usedFallback: true });
  });
  test('la cascada no supera el precio de la franja superior', () => {
    const rows = [bracket('15 min', 15, 1800), bracket('1 h', 60, 2000), bracket('2 h', 120, 3000)];
    expect(calculatePrice(rows, 'AUTO', 'DAY', 70, 5).price).toBe(3000);
  });
  test('una franja específica reemplaza a la general sin depender del orden', () => {
    const general = bracket('general', 60, 1000);
    const night = bracket('noche', 60, 2000, { ticketDayType: 'NIGHT' });
    for (const rows of [[general, night], [night, general]]) {
      expect(calculatePrice(rows, 'AUTO', 'NIGHT', 30, 5).price).toBe(2000);
      expect(calculatePrice(rows, 'AUTO', 'DAY', 30, 5).price).toBe(1000);
    }
  });
  test('un precio recurrente propio se respeta', () => {
    const rows = [bracket('hora', 60, 2000), bracket('extra', null, 1500, { recurringUnitMinutes: 60, recurringPriceMode: 'FIXED' })];
    expect(calculatePrice(rows, 'AUTO', 'DAY', 66, 5).price).toBe(3500);
    expect(calculatePrice(rows, 'AUTO', 'DAY', 121, 5).price).toBe(5000);
  });
  test('el modo derivado preserva la referencia explícita', () => {
    const rows = [bracket('hora', 60, 2000), bracket('extra', null, 1500, { recurringUnitMinutes: 60, recurringPriceMode: 'DERIVED' })];
    expect(calculatePrice(rows, 'AUTO', 'DAY', 66, 5).price).toBe(4000);
  });
  test('el proporcional redondea una sola vez al final', () => {
    const rows = [bracket('hora', 60, 1000), bracket('extra', null, 1500, { recurringUnitMinutes: 1, recurringPriceMode: 'DERIVED' })];
    expect(calculatePrice(rows, 'AUTO', 'DAY', 120, 5).price).toBe(2000);
  });
  test('tarifa sin límite sola', () => {
    expect(calculatePrice([bracket('única', null, 1000)], 'AUTO', 'DAY', 2000, 5).price).toBe(1000);
  });
  test('no admite duplicados ni recurrencia con techo', () => {
    const row = bracket('una', 60, 1000);
    expect(() => validateBracket({ ...row, id: 'otra' }, [row])).toThrow();
    expect(() => selectBrackets([row, { ...row, id: 'otra' }], 'AUTO', 'DAY')).toThrow();
    expect(() => validateBracket({ ...row, recurringUnitMinutes: 15 }, [])).toThrow();
    expect(() => validateBracket({ ...row, id: 'noche', ticketDayType: 'NIGHT' }, [row])).not.toThrow();
  });
  test('no cobra con duración negativa o sin tarifas', () => {
    expect(() => calculatePrice(ladder, 'AUTO', 'DAY', -1, 5)).toThrow();
    expect(() => calculatePrice([], 'AUTO', 'DAY', 5, 5)).toThrow();
  });
});
