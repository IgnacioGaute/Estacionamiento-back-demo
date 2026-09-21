import { calculateStayPrice, validatePricingOptions } from './stay-pricing';
import { calculatePrice } from './pricing';
import { defaultPricingOptions, PricingOptions, PricingSnapshot } from './pricing.types';
const at = (time: string) => new Date(`2026-09-18T${time}:00-03:00`);
function snapshot(edit?: (options: PricingOptions) => void): PricingSnapshot {
  const options = defaultPricingOptions(); edit?.(options);
  return { version: 1, capturedAt: at('08:00').toISOString(), schedule: { dayStartHour: 8, dayEndHour: 20, graceMinutes: 0, pricingDayTypeBasis: 'ENTRY', pricingOptions: options }, brackets: [
    { id: 'hour', vehicleType: 'AUTO', ticketDayType: null, label: 'Una hora', uptoMinutes: 60, price: 600, recurringUnitMinutes: null },
    { id: 'extra', vehicleType: 'AUTO', ticketDayType: null, label: 'Hora adicional', uptoMinutes: null, price: 600, recurringUnitMinutes: 60, recurringPriceMode: 'FIXED' },
  ] };
}
function advanced(edit?: (options: PricingOptions) => void) {
  return snapshot(o => { o.charging.enabled = true; o.charging.mode = 'PROPORTIONAL'; o.charging.rates = [{ vehicleType: 'AUTO', dayPrice: 600, nightPrice: 1200 }]; edit?.(o); });
}
function run(s: PricingSnapshot, minutes: number, entry = at('10:00')) {
  const result = calculateStayPrice(s, 'AUTO', entry, new Date(entry.getTime() + minutes * 60000));
  expect(result.breakdown.reduce((sum, line) => sum + line.amount, 0)).toBeCloseTo(result.price, 7);
  return result;
}
describe('Reglas configurables y explicación del importe', () => {
  test.each([0, 1, 30, 60, 61, 120, 137, 1440])('apagadas conservan el cálculo anterior a los %s minutos', minutes => {
    const s = snapshot(); expect(run(s, minutes).price).toBe(calculatePrice(s.brackets, 'AUTO', 'DAY', minutes, 0).price);
  });
  test.each([0, 1, 59, 61, 137])('permanencia activa con valores neutros conserva la escala a los %s minutos', minutes => {
    const s = snapshot(o => { o.stay.enabled = true; });
    expect(run(s, minutes).price).toBe(calculatePrice(s.brackets, 'AUTO', 'DAY', minutes, 0).price);
  });
  test.each([['STARTED', 1800], ['COMPLETED', 1200], ['PROPORTIONAL', 1370]] as const)('%s para 2 h 17 min', (mode, expected) => {
    expect(run(advanced(o => { o.charging.mode = mode; }), 137).price).toBe(expected);
  });
  test('fracción de 15 minutos iniciada', () => {
    expect(run(advanced(o => { o.charging.mode = 'STARTED'; o.charging.unitMinutes = 15; }), 16).price).toBe(1200);
  });
  test('tolerancia permite superar una unidad sin cobrar otra, pero no libera la primera', () => {
    const s = advanced(o => { o.charging.mode = 'STARTED'; }); s.schedule.graceMinutes = 5;
    expect(run(s, 1).price).toBe(600); expect(run(s, 65).price).toBe(600); expect(run(s, 66).price).toBe(1200);
  });
  test('gratis primero y mínimo una sola vez sobre el saldo de minutos', () => {
    const s = advanced(o => { o.stay.enabled = true; o.stay.freeMinutes = 15; o.stay.minimumMinutes = 60; });
    expect(run(s, 15).price).toBe(0); expect(run(s, 20).price).toBe(600); expect(run(s, 90).price).toBe(750);
  });
  test('apagar permanencia desactiva los valores que quedaron guardados', () => {
    expect(run(advanced(o => { o.stay.freeMinutes = 500; o.stay.minimumMinutes = 999; o.stay.capEnabled = true; o.stay.caps = [{ vehicleType: 'AUTO', amount: 1 }]; }), 60).price).toBe(600);
  });
  test.each([['ENTRY', 1370], ['EXIT', 2740], ['SPLIT', 2440]] as const)('cruce %s con entrada 19:30 y permanencia 2 h 17', (mode, expected) => {
    expect(run(advanced(o => { o.crossing = { enabled: true, mode }; }), 137, at('19:30')).price).toBe(expected);
  });
  test('en cruce, las unidades iniciadas se cuentan por cada tramo', () => {
    const s = advanced(o => { o.charging.mode = 'STARTED'; o.crossing = { enabled: true, mode: 'SPLIT' }; });
    expect(run(s, 137, at('19:30')).price).toBe(3000);
  });
  test('los minutos gratis pueden atravesar el cambio día/noche', () => {
    const s = advanced(o => { o.stay.enabled = true; o.stay.freeMinutes = 45; o.crossing = { enabled: true, mode: 'SPLIT' }; });
    expect(run(s, 137, at('19:30')).price).toBe(1840);
  });
  test('tope limita la suma de día/noche y se repite desde la entrada', () => {
    const s = advanced(o => { o.crossing = { enabled: true, mode: 'SPLIT' }; o.stay.enabled = true; o.stay.capEnabled = true; o.stay.capMinutes = 720; o.stay.caps = [{ vehicleType: 'AUTO', amount: 1000 }]; });
    expect(run(s, 137, at('19:30')).price).toBe(1000);
    expect(run(s, 750, at('08:00')).price).toBe(1600);
    expect(run(s, 1440, at('08:00')).price).toBe(2000);
  });
  test('tope permite cobrar menos cuando la estadía es corta', () => {
    expect(run(advanced(o => { o.stay.enabled = true; o.stay.capEnabled = true; o.stay.caps = [{ vehicleType: 'AUTO', amount: 1000 }]; }), 30).price).toBe(300);
  });
  test('múltiples cruces y horario diurno que atraviesa medianoche', () => {
    const s = advanced(o => { o.crossing = { enabled: true, mode: 'SPLIT' }; });
    s.schedule.dayStartHour = 20; s.schedule.dayEndHour = 8;
    expect(run(s, 1440, at('19:00')).price).toBe(21600);
  });
  test('redondeo una sola vez después de sumar los tramos', () => {
    const s = advanced(o => { o.crossing = { enabled: true, mode: 'SPLIT' }; o.charging.rates = [{ vehicleType: 'AUTO', dayPrice: 100, nightPrice: 100 }]; });
    expect(run(s, 2, at('19:59')).price).toBe(3);
  });
  test('falta de precio o tope bloquea el cálculo en lugar de inventar un importe', () => {
    expect(() => run(advanced(o => { o.charging.rates = []; }), 60)).toThrow();
    expect(() => run(advanced(o => { o.stay.enabled = true; o.stay.capEnabled = true; }), 60)).toThrow();
  });
  test('rechaza precios duplicados y mínimos superiores al período del tope', () => {
    const o = advanced().schedule.pricingOptions!;
    o.charging.rates.push(o.charging.rates[0]); expect(() => validatePricingOptions(o)).toThrow();
    o.charging.rates.pop(); o.stay.enabled = true; o.stay.capEnabled = true; o.stay.minimumMinutes = 1441;
    expect(() => validatePricingOptions(o)).toThrow();
  });
  test('rechaza fechas invertidas', () => { expect(() => calculateStayPrice(snapshot(), 'AUTO', at('12:00'), at('11:00'))).toThrow(); });
});
