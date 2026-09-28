const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const file = path.resolve(__dirname, '../../estacionamiento-front-demo/src/utils/tariff-plan.utils.ts');
const rules = { exports: {} };
new Function('module', 'exports', ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText)(rules, rules.exports);
const { changeMethod, changeCrossing, useDayPricesAllDay, tariffForVehicle, validateTariffDraft } = rules.exports;
const make = () => ({ schedule: { dayStartHour: 8, dayEndHour: 20, graceMinutes: 10, pricingDayTypeBasis: 'EXIT', pricingOptions: {
  charging: { enabled: false, mode: 'STARTED', unitMinutes: 60, rates: [{ vehicleType: 'AUTO', dayPrice: 2000, nightPrice: 3000 }] },
  crossing: { enabled: true, mode: 'SPLIT' }, stay: { enabled: false, caps: [] },
} }, brackets: [
  { id: 'general', vehicleType: 'AUTO', ticketDayType: null, label: 'Media hora', uptoMinutes: 30, price: 1000, recurringUnitMinutes: null },
  { id: 'day', vehicleType: 'AUTO', ticketDayType: 'DAY', label: 'Día', uptoMinutes: 30, price: 1200, recurringUnitMinutes: null },
  { id: 'night', vehicleType: 'AUTO', ticketDayType: 'NIGHT', label: 'Noche', uptoMinutes: 30, price: 1800, recurringUnitMinutes: null },
  { id: 'extra', vehicleType: 'AUTO', ticketDayType: null, label: 'Adicional original', uptoMinutes: null, price: 500, recurringUnitMinutes: 30, recurringPriceMode: 'DERIVED' },
] });

test('cambiar y volver de modalidad conserva precios, cruces y reglas históricas sin mutar', () => {
  const initial = make(), copy = structuredClone(initial);
  assert.deepEqual(changeMethod(changeMethod(initial, 'STARTED'), 'CUSTOM'), copy);
  assert.deepEqual(initial, copy);
  assert.equal(changeCrossing(initial, 'ENTRY').schedule.pricingOptions.crossing.enabled, false);
  assert.equal(changeCrossing(initial, 'ENTRY').schedule.pricingDayTypeBasis, 'ENTRY');
});

test('usar precios diurnos respeta precedencia específica y conserva adicional DERIVED y SPLIT', () => {
  const initial = make(), allDay = useDayPricesAllDay(initial);
  assert.equal(allDay.brackets.length, 2);
  assert.equal(allDay.brackets.find(row => row.uptoMinutes === 30).price, 1200);
  assert.equal(allDay.brackets.find(row => row.uptoMinutes === null).recurringPriceMode, 'DERIVED');
  assert.ok(allDay.brackets.every(row => row.ticketDayType === null));
  assert.equal(allDay.schedule.pricingOptions.crossing.mode, 'SPLIT');
  assert.equal(initial.brackets.length, 4);
});

test('simular un vehículo permite borrador parcial, guardar exige precios completos', () => {
  const draft = changeMethod(make(), 'STARTED');
  draft.schedule.pricingOptions.charging.rates.push({ vehicleType: 'MOTO', dayPrice: NaN, nightPrice: NaN });
  const vehicles = [{ code: 'AUTO', name: 'Auto', enabled: true }, { code: 'MOTO', name: 'Moto', enabled: true }];
  assert.ok(validateTariffDraft(draft, vehicles).length > 0);
  assert.deepEqual(validateTariffDraft(tariffForVehicle(draft, 'AUTO'), [vehicles[0]]), []);
  assert.equal(draft.schedule.pricingOptions.charging.rates.length, 2);
});

test('valida cobertura nocturna, duplicados y valores vacíos; cero explícito es válido', () => {
  const vehicle = [{ code: 'AUTO', name: 'Auto', enabled: true }];
  const draft = make(); draft.brackets = [draft.brackets[1]];
  assert.ok(validateTariffDraft(draft, vehicle).some(message => message.includes('noche')));
  draft.brackets[0].ticketDayType = null; draft.brackets[0].price = 0;
  assert.deepEqual(validateTariffDraft(draft, vehicle), []);
  draft.brackets.push({ ...draft.brackets[0], id: 'duplicate' });
  assert.ok(validateTariffDraft(draft, vehicle).some(message => message.includes('repetida')));
  draft.brackets.pop(); draft.brackets[0].price = NaN;
  assert.ok(validateTariffDraft(draft, vehicle).length > 0);
});
