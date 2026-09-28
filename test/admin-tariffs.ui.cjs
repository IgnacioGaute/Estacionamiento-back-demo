// Componentes reales del frontend, API simulada y motor real de precios; sin .env ni base de datos.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const puppeteer = require('puppeteer');
const ts = require('typescript');
const front = path.resolve(__dirname, '../../estacionamiento-front-demo');
const frontRequire = createRequire(path.join(front, 'package.json'));
const webpackModule = frontRequire('next/dist/compiled/webpack/webpack');
webpackModule.init();
const { webpack } = webpackModule;
const { calculateStayPrice } = require('../dist/tickets/pricing/stay-pricing');
const { defaultPricingOptions } = require('../dist/tickets/pricing/pricing.types');
const output = path.resolve(__dirname, '../.tmp/admin-tariffs-ui');
const write = (name, content) => fs.writeFileSync(path.join(output, name), content, 'utf8');

async function bundle() {
  fs.mkdirSync(output, { recursive: true });
  write('loader.cjs', `const ts = require(${JSON.stringify(require.resolve('typescript'))}); module.exports = function(source) { return ts.transpileModule(source, { fileName: this.resourcePath, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText; };`);
  write('navigation.tsx', `import React from 'react'; export const useRouter = () => ({refresh() {}}); export const useSearchParams = () => new URLSearchParams(window.location.search); export const usePathname = () => '/admin/tarifas'; export default function Link({children,...props}) {return <a {...props}>{children}</a>;}`);
  write('vehicles.ts', `export const useVehicleTypes = () => ({types: window.__vehicles, loading: false, error: ''});`);
  write('toast.ts', `export const toast = {success(message) { window.__toast = message; }, error(message) { window.__toast = message; }};`);
  // Los pases conservan sus componentes anteriores; esta prueba cubre el nuevo editor Por tiempo.
  write('passes.tsx', `import React from 'react'; export const TicketsPriceTable = ({data}) => <div data-pass-rows>{data.map(row => <p key={row.id}>{row.vehicleType ?? "Sin vehículo"}: {row.ticketTimeType} {row.ticketTimePrice}</p>)}</div>; export const UpdateTicketPriceDialog = () => <button>Editar</button>; export const DeleteTicketPriceDialog = () => <button>Eliminar</button>; export const ticketPriceColumns = []; export const CreateTicketPriceDialog = ({defaultVehicleType}) => <button data-create-vehicle={defaultVehicleType}>Nueva tarifa de pase</button>;`);
  write('actions.ts', `
    export async function getTariffPlanAction() { return {plan: structuredClone(window.__plan)}; }
    export async function saveTariffPlanAction(revision, draft) {
      window.__saves.push({revision, draft: structuredClone(draft)});
      if (window.__conflict) {
        window.__conflict = false;
        window.__plan = structuredClone(window.__plan);
        window.__plan.revision = 'other-admin';
        window.__plan.schedule.pricingOptions.charging.rates[0].dayPrice = 3100;
        return {error: 'Las tarifas cambiaron', conflict: true};
      }
      window.__plan = {...structuredClone(draft), revision: 'saved-' + window.__saves.length};
      return {plan: structuredClone(window.__plan)};
    }
    export async function simulateTariffPlanAction(vehicle, entry, minutes, draft) {
      return window.__simulate(draft ?? window.__plan, vehicle, entry, minutes);
    }
  `);
  write('entry.tsx', `import React from 'react'; import { createRoot } from 'react-dom/client'; import { TariffsBody } from '@/app/(protected)/admin/tarifas/tariffs-body'; const root=createRoot(document.getElementById('root')); let key=0; window.mount = (plan, vehicles, passPrices = []) => { window.__plan=plan; window.__vehicles=vehicles; window.__saves=[]; root.render(<TariffsBody key={++key} initialPlan={plan} passPrices={passPrices} />); };`);
  const compiler = webpack({
    mode: 'development', devtool: false, context: front,
    entry: path.join(output, 'entry.tsx'), output: { path: output, filename: 'bundle.js' },
    resolve: { extensions: ['.tsx', '.ts', '.js', '.jsx'], modules: [path.join(front, 'node_modules'), 'node_modules'], alias: {
      'react$': frontRequire.resolve('react'), 'react-dom/client$': frontRequire.resolve('react-dom/client'),
      'next/link$': path.join(output, 'navigation.tsx'), 'next/navigation$': path.join(output, 'navigation.tsx'),
      '@/components/vehicle-type-options$': path.join(output, 'vehicles.ts'),
      '@/actions/tickets/tariff-plan.action$': path.join(output, 'actions.ts'),
      '@/lib/toast$': path.join(output, 'toast.ts'),
      '@': path.join(front, 'src'),
    } },
    module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(output, 'loader.cjs') }] },
    plugins: [new webpack.NormalModuleReplacementPlugin(/ticket-price\/(tickets-price-table|ticket-price-columns|create-ticket-price-dialog|update-ticket-price-dialog|delete-ticket-price-dialog)$/, path.join(output, 'passes.tsx'))],
  });
  await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
  const configModule = { exports: {} };
  const configSource = ts.transpileModule(fs.readFileSync(path.join(front, 'tailwind.config.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('require', 'module', 'exports', configSource)(frontRequire, configModule, configModule.exports);
  const config = configModule.exports.default;
  config.content = [path.join(front, 'src/**/*.{tsx,ts}').replaceAll('\\', '/')];
  const css = await frontRequire('postcss')([frontRequire('tailwindcss')(config)]).process(fs.readFileSync(path.join(front, 'src/app/globals.css'), 'utf8'), { from: undefined });
  return css.css;
}

const vehicles = [{ code: 'AUTO', name: 'Auto', enabled: true }];
function plan() {
  const options = defaultPricingOptions();
  options.charging = { enabled: true, mode: 'STARTED', unitMinutes: 60, rates: [{ vehicleType: 'AUTO', dayPrice: 2000, nightPrice: 2000 }] };
  return { revision: 'initial', schedule: { dayStartHour: 8, dayEndHour: 20, graceMinutes: 10, pricingDayTypeBasis: 'EXIT', pricingOptions: options }, brackets: [] };
}

test('tarifas: editar, comparar, aplicar, conflicto, borrador y ancho móvil', { timeout: 120000 }, async () => {
  const css = await bundle();
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const nativeDialogs = [];
    page.on('dialog', dialog => { nativeDialogs.push(dialog.message()); return dialog.dismiss(); });
    await page.exposeFunction('__simulate', (draft, vehicle, entry, minutes) => {
      try { return { result: calculateStayPrice({ version: 1, capturedAt: entry, ...draft }, vehicle, new Date(entry), new Date(Date.parse(entry) + minutes * 60000)) }; }
      catch (error) { return { error: error.message }; }
    });
    await page.setViewport({ width: 1280, height: 900 });
    await page.setContent(`<html class="dark" style="--font-sans:Arial;--font-display:Arial;--font-mono:monospace"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><main id="root" class="container mx-auto space-y-6 px-4 py-6"></main></html>`);
    await page.addScriptTag({ path: path.join(output, 'bundle.js') });
    const mount = async (data = plan(), types = vehicles, prices = []) => {
      await page.evaluate((p, v, prices) => window.mount(p, v, prices), data, types, prices);
      await page.waitForSelector('button[role="tab"]');
    };
    const click = async label => {
      const button = await page.waitForFunction(text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && b.getBoundingClientRect().height > 0), {}, label);
      await button.asElement().click();
    };
    const select = async (name, label) => {
      await page.click('[role="combobox"][aria-label="' + name + '"]');
      const option = await page.waitForFunction(text => [...document.querySelectorAll('[role="option"]')].find(o => o.textContent.startsWith(text)), {}, label);
      await option.asElement().click();
      await page.waitForSelector('[role="listbox"]', { hidden: true });
    };
    const fill = async (selector, value) => {
      await page.click(selector, { clickCount: 3 });
      await page.keyboard.press('Backspace');
      await page.type(selector, value);
    };
    const overflow = async () => {
      const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(dimensions.scroll <= dimensions.width + 1, JSON.stringify(dimensions));
    };
    await mount();
    await click('Editar tarifas');
    assert.equal(await page.evaluate(() => window.__saves.length), 0);
    await fill('input[aria-label="Auto: precio todo el día"]', '2500');
    await click('Comparar ejemplo');
    await page.waitForSelector('[aria-live="polite"]');
    let comparison = await page.$eval('[aria-live="polite"]', e => e.textContent);
    assert.match(comparison, /4\.000/);
    assert.match(comparison, /5\.000/);
    await click('Día / semana / mes');
    await click('Por tiempo· Borrador');
    assert.equal(await page.$eval('input[aria-label="Auto: precio todo el día"]', e => e.value), '2500');
    await overflow();
    for (const width of [320, 390, 768]) {
      await page.setViewport({ width, height: 850 });
      await overflow();
    }
    await page.setViewport({ width: 390, height: 850 });
    await page.screenshot({ path: path.join(output, 'tarifas-mobile.png'), fullPage: true });
    await page.setViewport({ width: 1280, height: 900 });
    await page.screenshot({ path: path.join(output, 'tarifas-desktop.png'), fullPage: true });
    await click('Aplicar a los próximos ingresos');
    await page.waitForFunction(() => window.__saves.length === 1 && !document.getElementById('tariff-draft-heading'));
    assert.equal(await page.evaluate(() => window.__saves[0].draft.schedule.pricingOptions.charging.rates[0].nightPrice), 2500);

    // Un conflicto conserva valores editados y obliga a revisar antes de reintentar.
    await click('Editar tarifas');
    await fill('input[aria-label="Auto: precio todo el día"]', '2800');
    await page.evaluate(() => { window.__conflict = true; });
    await click('Aplicar a los próximos ingresos');
    await page.waitForFunction(() => document.body.textContent.includes('cambiaron mientras editabas'));
    assert.equal(await page.$eval('input[aria-label="Auto: precio todo el día"]', e => e.value), '2800');
    await click('Revisé la versión vigente: conservar mi borrador');
    await click('Aplicar a los próximos ingresos');
    await page.waitForFunction(() => !document.getElementById('tariff-draft-heading'));

    // Playa nueva: sin precios reales hasta aplicar; cambiar de modalidad no pierde la lista.
    const empty = plan(); empty.schedule.pricingOptions.charging.enabled = true; empty.schedule.pricingOptions.charging.rates = [];
    await mount(empty);
    await click('Configurar mis tarifas');
    assert.equal(await page.$eval('input[value="CUSTOM"]', e => e.checked), true);
    await page.click('input[value="STARTED"]');
    await fill('input[aria-label="Auto: precio todo el día"]', '2000');
    await click('Comparar ejemplo');
    await page.waitForSelector('[aria-live="polite"]');
    assert.match(await page.$eval('[aria-live="polite"]', e => e.textContent), /4\.000/);
    assert.equal(await page.evaluate(() => window.__saves.length), 0);
    await click('Descartar cambios');
    await page.waitForSelector('[role="dialog"]');
    await click('Descartar borrador');
    await page.waitForSelector('[role="dialog"]', { hidden: true });

    // Legacy SPLIT y precios nocturnos se conservan al abrir/cancelar.
    const legacy = plan(); legacy.schedule.pricingOptions.crossing = { enabled: true, mode: 'SPLIT' };
    await mount(legacy);
    await click('Editar tarifas');
    assert.match(await page.$eval('[role="combobox"][aria-label="Precio al cambiar de horario"]', e => e.textContent), /Separar el tiempo/);
    await click('Cancelar');
    assert.deepEqual(await page.evaluate(() => window.__plan), legacy);

    // Las modalidades retiradas no se ofrecen y nunca se convierten sin elegir una nueva.
    for (const mode of ['PROPORTIONAL', 'COMPLETED']) {
      const old = plan(); old.schedule.pricingOptions.charging.mode = mode;
      await mount(old);
      await click('Editar tarifas');
      assert.deepEqual(await page.$$eval('input[name="tariff-method"]', nodes => nodes.map(n => n.value)), ['CUSTOM', 'STARTED']);
      assert.equal(await page.$('input[aria-label="Auto: precio todo el día"]'), null);
      assert.ok(await page.evaluate(() => document.body.textContent.includes('Elegí una de las dos opciones')));
      await page.click('input[value="STARTED"]');
      await page.waitForSelector('input[aria-label="Auto: precio todo el día"]');
      assert.deepEqual(await page.evaluate(() => window.__plan), old);
      await click('Descartar cambios'); await click('Descartar borrador');
      await page.waitForSelector('[role="dialog"]', { hidden: true });
    }

    // Lista: unidades, adicional y cambios de horario sin confirmaciones nativas.
    const list = plan(); list.schedule.pricingOptions.charging.enabled = false; list.schedule.pricingOptions.charging.rates = [];
    const row = (id, minutes, price, day = null) => ({ id, vehicleType: 'AUTO', ticketDayType: day, label: 'Hasta ' + minutes + ' min', uptoMinutes: minutes, price, recurringUnitMinutes: null, recurringPriceMode: 'FIXED' });
    list.brackets = [row('half',30,1200), row('hour',60,2000), row('day',60,2300,'DAY'), row('night',60,3000,'NIGHT')];
    await mount(list);
    await click('Editar tarifas');
    assert.equal(await page.$eval('input[value="CUSTOM"]', e => e.checked), true);
    assert.equal(await page.$eval('input[aria-label="Auto: duración 2"]', e => e.value), '1');
    await select('Auto: duración 2: unidad', 'minutos');
    assert.equal(await page.$eval('input[aria-label="Auto: duración 2"]', e => e.value), '60');
    assert.equal(await page.evaluate(() => window.__saves.length), 0);
    // El selector muestra opciones diseñadas, se cierra sin cambios y permite teclado.
    await page.click('[role="combobox"][aria-label="Auto: duración 1: horario"]');
    await page.waitForSelector('[role="listbox"]');
    await page.waitForFunction(() => { const menu = document.querySelector('[role="listbox"]'); return menu && getComputedStyle(menu).opacity === '1' && menu.getAnimations().every(animation => animation.playState === 'finished'); });
    await page.screenshot({ path: path.join(output, 'tarifas-selector-horario.png') });
    await page.keyboard.press('Escape');
    await page.waitForSelector('[role="listbox"]', { hidden: true });
    assert.equal(await page.$eval('[role="combobox"][aria-label="Auto: duración 1: horario"]', e => e.title), 'Todo el día');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[role="listbox"]');
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'option' && document.activeElement.textContent.startsWith('Todo el día'));
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => document.activeElement?.textContent.startsWith('Sólo de día'));
    await page.keyboard.press('Enter');
    await page.waitForSelector('[role="listbox"]', { hidden: true });
    assert.equal(await page.$eval('[role="combobox"][aria-label="Auto: duración 1: horario"]', e => e.title), 'Sólo de día');
    await select('Auto: duración 1: horario', 'Todo el día');
    await page.setViewport({ width: 320, height: 750 });
    await page.click('[role="combobox"][aria-label="Auto: duración 1: horario"]');
    await page.waitForSelector('[role="listbox"]');
    await page.waitForFunction(() => { const r=document.querySelector('[role="listbox"]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; });
    await page.waitForFunction(() => { const menu = document.querySelector('[role="listbox"]'); return menu && getComputedStyle(menu).opacity === '1' && menu.getAnimations().every(animation => animation.playState === 'finished'); });
    await page.screenshot({ path: path.join(output, 'tarifas-selector-mobile.png') });
    await page.keyboard.press('Escape');
    await page.waitForSelector('[role="listbox"]', { hidden: true });
    await page.setViewport({ width: 1280, height: 900 });
    await page.click('#tariff-night');
    await page.waitForSelector('[role="dialog"]');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Mantener precios de noche');
    await page.screenshot({ path: path.join(output, 'tarifas-confirmacion.png') });
    await page.setViewport({ width: 320, height: 750 });
    await overflow();
    await page.waitForFunction(() => { const r = document.querySelector('[role="dialog"]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; });
    await page.screenshot({ path: path.join(output, 'tarifas-confirmacion-mobile.png') });
    await click('Mantener precios de noche');
    await page.waitForSelector('[role="dialog"]', { hidden: true });
    assert.equal(await page.$$eval('[data-tariff-duration]', rows => rows.length), 4);
    assert.equal(await page.$eval('#tariff-night', e => e.getAttribute('aria-checked')), 'true');
    await page.click('#tariff-night');
    await page.waitForSelector('[role="dialog"]');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[role="dialog"]', { hidden: true });
    assert.equal(await page.$$eval('[data-tariff-duration]', rows => rows.length), 4);
    await page.click('#tariff-night');
    await click('Usar precios de día');
    await page.waitForSelector('[role="dialog"]', { hidden: true });
    assert.equal(await page.$$eval('[data-tariff-duration]', rows => rows.length), 2);
    assert.equal(await page.$eval('input[aria-label="Auto: precio 2"]', e => e.value), '2300');
    assert.deepEqual(await page.evaluate(() => window.__plan), list);
    await click('Agregar duración');
    await fill('input[aria-label="Auto: precio 3"]', '4200');
    await click('Definir cobro posterior');
    await fill('input[aria-label="Auto: precio posterior 1"]', '1800');
    await select('Auto: período adicional 1: unidad', 'minutos');
    await fill('input[aria-label="Auto: período adicional 1"]', '30');
    await click('Comparar ejemplo');
    await page.waitForSelector('[aria-live="polite"]');
    await page.setViewport({ width: 1280, height: 1000 });
    await page.screenshot({ path: path.join(output, 'tarifas-lista-desktop.png'), fullPage: true });
    await (await page.$('[data-tariff-price-list]')).screenshot({ path: path.join(output, 'tarifas-lista-detalle.png') });
    for (const width of [320, 390, 768, 1024, 1280]) {
      await page.setViewport({ width, height: 850 }); await overflow();
      const fields = await page.evaluate(() => [...document.querySelectorAll('[data-tariff-duration] input')].map(input => ({ label: input.getAttribute('aria-label'), width: input.getBoundingClientRect().width })));
      assert.ok(fields.every(field => field.width > 70), JSON.stringify({ width, fields }));
    }
    await page.setViewport({ width: 390, height: 850 });
    await page.screenshot({ path: path.join(output, 'tarifas-lista-mobile.png'), fullPage: true });
    await (await page.$('[data-tariff-price-list]')).screenshot({ path: path.join(output, 'tarifas-lista-detalle-mobile.png') });
    await click('Aplicar a los próximos ingresos');
    await page.waitForFunction(() => window.__saves.length === 1 && !document.getElementById('tariff-draft-heading'));
    const saved = await page.evaluate(() => window.__saves[0].draft);
    assert.equal(saved.schedule.pricingOptions.charging.enabled, false);
    assert.deepEqual(saved.brackets.filter(r => r.uptoMinutes !== null).map(r => r.uptoMinutes), [30, 60, 120]);
    assert.equal(saved.brackets.find(r => r.uptoMinutes === null).recurringUnitMinutes, 30);
    assert.equal(saved.brackets.find(r => r.uptoMinutes === null).recurringPriceMode, 'FIXED');

    // El orden no depende del alta; una copia queda pegada a su origen y no reutiliza su id.
    const unordered = plan(); unordered.schedule.pricingOptions.charging.enabled = false; unordered.schedule.pricingOptions.charging.rates = [];
    unordered.brackets = [row('two-days',2880,28000), row('two-hours',120,4000,'DAY'), row('thirty',30,1000), row('one-day',1440,15000), row('one-hour',60,2000)];
    await mount(unordered); await click('Editar tarifas');
    const durationsInView = () => page.$$eval('[data-tariff-duration]', rows => rows.map(row => {
      const input = row.querySelector('input');
      const unit = row.querySelector('[role="combobox"][aria-label$=": unidad"]').title;
      return Number(input.value) * ({ minutos: 1, horas: 60, días: 1440 })[unit];
    }));
    assert.deepEqual(await durationsInView(), [30,60,120,1440,2880]);
    const copy = await page.waitForFunction(() => [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Copiar Hasta 120 min de Auto' && b.getBoundingClientRect().height > 0));
    await copy.asElement().click();
    await page.waitForFunction(() => document.querySelectorAll('[data-tariff-duration]').length === 6);
    assert.deepEqual(await durationsInView(), [30,60,120,120,1440,2880]);
    assert.equal(await page.$eval('input[aria-label="Auto: precio 4"]', e => e.value), '4000');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Auto: duración 4: horario');
    await select('Auto: duración 4: horario', 'Sólo de noche');
    await fill('input[aria-label="Auto: precio 4"]', '5000');
    // Reordenar al terminar de escribir conserva la fila y su precio, incluida una fila sin id.
    await select('Auto: duración 4: unidad', 'minutos');
    await fill('input[aria-label="Auto: duración 4"]', '45');
    await page.keyboard.press('Enter');
    assert.deepEqual(await durationsInView(), [30,45,60,120,1440,2880]);
    assert.equal(await page.$eval('input[aria-label="Auto: precio 2"]', e => e.value), '5000');
    await fill('input[aria-label="Auto: duración 2"]', '120');
    await page.keyboard.press('Enter');
    assert.deepEqual(await durationsInView(), [30,60,120,120,1440,2880]);
    for (const width of [320,768,1280]) { await page.setViewport({ width, height: 900 }); await overflow(); }
    await (await page.$('[data-tariff-price-list]')).screenshot({ path: path.join(output, 'tarifas-copiar-orden.png') });
    await click('Aplicar a los próximos ingresos');
    await page.waitForFunction(() => window.__saves.length === 1 && !document.getElementById('tariff-draft-heading'));
    const copiedPlan = await page.evaluate(() => window.__saves[0].draft);
    const source = copiedPlan.brackets.find(r => r.id === 'two-hours');
    const copied = copiedPlan.brackets.find(r => r.uptoMinutes === 120 && r.ticketDayType === 'NIGHT');
    assert.equal(source.price, 4000);
    assert.equal(copied.price, 5000);
    assert.equal(copied.id, undefined);
    assert.equal(copiedPlan.brackets.length, 6);
    await click('Editar tarifas');
    assert.deepEqual(await durationsInView(), [30,60,120,120,1440,2880]);
    await click('Cancelar');

    // Cada vehículo puede tener un adicional de día y un total fijo de noche independientes.
    const splitEndings = plan(); splitEndings.schedule.pricingOptions.charging.enabled = false; splitEndings.schedule.pricingOptions.charging.rates = [];
    splitEndings.brackets = [row('auto-base',60,2000), { ...row('moto-base',60,1000), vehicleType: 'MOTO' }];
    await mount(splitEndings, [...vehicles, { code: 'MOTO', name: 'Moto', enabled: true }]);
    await click('Editar tarifas');
    const clickForVehicle = async (vehicle, label) => {
      const button = await page.waitForFunction((vehicle, label) => {
        const section = [...document.querySelectorAll('[data-tariff-price-list]')].find(e => e.querySelector('h4').textContent === vehicle);
        return [...section.querySelectorAll('button')].find(e => e.textContent.trim() === label);
      }, {}, vehicle, label);
      await button.asElement().click();
    };
    await clickForVehicle('Auto', 'Agregar cobro de día');
    assert.equal(await page.$eval('#tariff-night', e => e.getAttribute('aria-checked')), 'true');
    await fill('input[aria-label="Auto: precio posterior 1"]', '500');
    await select('Auto: período adicional 1: unidad', 'minutos');
    await fill('input[aria-label="Auto: período adicional 1"]', '30');
    await clickForVehicle('Auto', 'Agregar cobro de noche');
    await select('Auto: cobro posterior 2', 'Cobrar un total fijo');
    await fill('input[aria-label="Auto: precio posterior 2"]', '6000');
    // Crear noche primero no cambia el orden final ni pierde su importe al agregar día.
    await clickForVehicle('Moto', 'Agregar cobro de noche');
    await select('Moto: cobro posterior 1', 'Cobrar un total fijo');
    await fill('input[aria-label="Moto: precio posterior 1"]', '3000');
    await clickForVehicle('Moto', 'Agregar cobro de día');
    await fill('input[aria-label="Moto: precio posterior 1"]', '250');
    assert.equal(await page.$eval('input[aria-label="Moto: precio posterior 2"]', e => e.value), '3000');
    assert.equal(await page.$$eval('[data-tariff-ending]', rows => rows.length), 4);
    assert.equal(await page.$$eval('button', buttons => buttons.filter(b => b.textContent.includes('Agregar cobro de')).length), 0);
    await page.click('[role="combobox"][aria-label="Auto: regla posterior 1: horario"]');
    assert.equal(await page.$$eval('[role="option"]', opts => opts.some(o => o.textContent.startsWith('Sólo de noche'))), false);
    await page.keyboard.press('Escape'); await page.waitForSelector('[role="listbox"]', { hidden: true });
    for (const width of [320,768,1280]) { await page.setViewport({ width, height: 900 }); await overflow(); }
    await page.screenshot({ path: path.join(output, 'tarifas-cobro-dia-noche.png'), fullPage: true });
    await click('Aplicar a los próximos ingresos');
    await page.waitForFunction(() => window.__saves.length === 1 && !document.getElementById('tariff-draft-heading'));
    const endingsPlan = await page.evaluate(() => window.__saves[0].draft);
    assert.equal(endingsPlan.brackets.filter(r => r.uptoMinutes === null).length, 4);
    const charge = (vehicle, hour) => {
      const entry = new Date('2026-09-28T' + hour + ':00:00-03:00');
      return calculateStayPrice({ version: 1, capturedAt: entry.toISOString(), ...endingsPlan }, vehicle, entry, new Date(entry.getTime() + 120 * 60000)).price;
    };
    assert.equal(charge('AUTO', '10'), 3000);
    assert.equal(charge('AUTO', '22'), 6000);
    assert.equal(charge('MOTO', '10'), 1250);
    assert.equal(charge('MOTO', '22'), 3000);
    await click('Editar tarifas');
    assert.equal(await page.$$eval('[data-tariff-ending]', rows => rows.length), 4);
    await click('Cancelar');

    // Resumen: tabs de vehículo y sol/luna muestran sólo los precios efectivos de ese horario.
    const summaryPlan = plan(); summaryPlan.schedule.pricingOptions.charging.enabled = false; summaryPlan.schedule.pricingOptions.charging.rates = [];
    summaryPlan.brackets = [row('s-half',30,1000), row('s-hour',60,2000), row('s-day',60,2300,'DAY'), row('s-night',60,3000,'NIGHT'),
      { ...row('s-extra',null,500), recurringUnitMinutes:60 }, { ...row('s-night-extra',null,700,'NIGHT'), recurringUnitMinutes:30 },
      { ...row('s-moto',60,800), vehicleType:'MOTO' }, { ...row('s-moto-night',60,900,'NIGHT'), vehicleType:'MOTO' }];
    await mount(summaryPlan, [...vehicles, {code:'MOTO',name:'Moto',enabled:true}, {code:'CAMIONETA',name:'Camioneta / utilitario',enabled:true}]);
    const summaryText = () => page.$eval('[data-tariff-summary] [role="tabpanel"]', e => e.textContent);
    assert.match(await summaryText(), /2\.300/); assert.doesNotMatch(await summaryText(), /3\.000|2\.000/);
    assert.match(await summaryText(), /1\.000/); assert.match(await summaryText(), /500/);
    assert.equal(await page.$$eval('[data-tariff-summary] tbody tr', rows => rows.length), 3);
    const theme = await page.$eval('html', e => e.className);
    await page.click('[data-tariff-summary] [role="switch"]');
    assert.match(await summaryText(), /3\.000/); assert.match(await summaryText(), /700/);
    assert.doesNotMatch(await summaryText(), /2\.300|500/);
    assert.equal(await page.$eval('html', e => e.className), theme);
    await page.click('[data-tariff-summary] [role="tablist"] button:nth-child(2)');
    assert.match(await summaryText(), /Moto/); assert.match(await summaryText(), /900/); assert.doesNotMatch(await summaryText(), /3\.000/);
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.$eval('[data-tariff-summary] [role="tab"][aria-selected="true"]', e => e.textContent), 'Auto');
    await page.keyboard.press('End');
    assert.match(await summaryText(), /No hay precios/);
    await page.keyboard.press('Home');
    assert.match(await summaryText(), /3\.000/);
    assert.equal(await page.evaluate(() => window.__saves.length), 0);
    for (const width of [320,390,768,1280]) { await page.setViewport({width,height:900}); await overflow(); }
    await page.$eval('[data-tariff-summary]', e => e.scrollIntoView());
    await page.screenshot({ path:path.join(output,'tarifas-tabs-noche.png') });
    await page.click('[data-tariff-summary] [role="switch"]');
    await page.waitForFunction(() => { const icon = document.querySelector('[data-tariff-summary] [role="switch"] .lucide-sun'); return icon && getComputedStyle(icon.parentElement).opacity === '1'; });
    await page.screenshot({ path:path.join(output,'tarifas-tabs-dia.png') });
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
    await page.setViewport({width:390,height:850});
    await page.click('[data-tariff-summary] [role="switch"]');
    assert.match(await summaryText(), /3\.000/);
    await overflow();
    await page.$eval('[data-tariff-summary]', e => e.scrollIntoView());
    await page.waitForFunction(() => { const icon = document.querySelector('[data-tariff-summary] [role="switch"] .lucide-moon'); return icon && getComputedStyle(icon.parentElement).opacity === '1'; });
    await page.screenshot({ path:path.join(output,'tarifas-tabs-mobile.png') });
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'no-preference'}]);

    // Pases: filtrar por vehículo, conservar precios antiguos y precargar el alta.
    await mount(plan(), [...vehicles, {code:'MOTO',name:'Moto',enabled:true}, {code:'CAMIONETA',name:'Camioneta',enabled:true}], [
      {id:'am',vehicleType:'AUTO',ticketTimeType:'MES',ticketTimePrice:30000},
      {id:'ad',vehicleType:'AUTO',ticketTimeType:'DIA',ticketTimePrice:2000},
      {id:'ms',vehicleType:'MOTO',ticketTimeType:'SEMANA',ticketTimePrice:5000},
      {id:'old',vehicleType:'CAMION',ticketTimeType:'DIA',ticketTimePrice:8000},
      {id:'none',vehicleType:null,ticketTimeType:'MES',ticketTimePrice:40000},
    ]);
    await click('Día / semana / mes');
    const passesText = () => page.$eval('[data-pass-rows]', e => e.textContent);
    assert.match(await passesText(), /Día.*2\.000.*Mes.*30\.000/);
    assert.equal(await page.$eval('[data-create-vehicle]', e => e.dataset.createVehicle), 'AUTO');
    await page.click('[data-tariff-passes] [role="tablist"] button:nth-child(2)');
    assert.match(await passesText(), /Semana.*5\.000/);
    assert.equal(await page.$eval('[data-create-vehicle]', e => e.dataset.createVehicle), 'MOTO');
    await page.keyboard.press('ArrowRight');
    assert.match(await passesText(), /Todavía no hay pases/);
    assert.equal(await page.$eval('[data-create-vehicle]', e => e.dataset.createVehicle), 'CAMIONETA');
    await page.keyboard.press('ArrowRight');
    assert.match(await passesText(), /Día.*8\.000/);
    assert.equal(await page.$('[data-create-vehicle]'), null);
    await page.keyboard.press('End');
    assert.match(await passesText(), /Mes.*40\.000/);
    await page.keyboard.press('Home');
    for (const width of [320,390,768,1280]) { await page.setViewport({width,height:900}); await overflow(); }
    assert.equal(await page.evaluate(() => window.__saves.length), 0);
    await page.click('[data-tariff-passes] button[aria-label="Acciones de pase Día de Auto"]');
    await page.waitForSelector('[role="menu"]');
    assert.match(await page.$eval('[role="menu"]', e => e.textContent), /EditarEliminar/);
    await page.keyboard.press('Escape');
    await page.setViewport({width:390,height:850});
    await overflow();
    await page.$eval('[data-tariff-passes]', e => e.scrollIntoView());
    await page.screenshot({path:path.join(output,'tarifas-pases-neutral.png')});
    assert.deepEqual(nativeDialogs, []);
    assert.deepEqual(errors, []);
    console.log('Capturas y bundle aislado:', output);
  } finally { await browser.close(); }
});