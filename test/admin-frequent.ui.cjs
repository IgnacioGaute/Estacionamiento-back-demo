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
const output = path.resolve(__dirname, '../.tmp/admin-frequent-ui');
const write = (name, content) => fs.writeFileSync(path.join(output, name), content, 'utf8');

async function bundle() {
  fs.mkdirSync(output, { recursive: true });
  write('loader.cjs', `const ts = require(${JSON.stringify(require.resolve('typescript'))}); module.exports = function(source) { return ts.transpileModule(source, { fileName: this.resourcePath, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText; };`);
  // Los .css que importan los componentes no hacen falta: Tailwind se compila aparte, más abajo.
  write('css-vacio.cjs', `module.exports = function() { return ''; };`);
  write('navigation.tsx', `import React from 'react'; export const useRouter = () => ({refresh() {}}); export const useSearchParams = () => new URLSearchParams(window.location.search); export const usePathname = () => '/admin/tarifas'; export default function Link({children,...props}) {return <a {...props}>{children}</a>;}`);
  write('vehicles.ts', `export const useVehicleTypes = () => ({types: window.__vehicles, loading: false, error: ''});`);
  write('toast.ts', `export const toast = {success(message) { window.__toast = message; }, error(message) { window.__toast = message; }};`);
  write('actions.ts', `export async function getFrequentCustomersPageAction(filters) { window.__requests.push(filters); if (window.__fail) throw Error('fail'); return {data:window.__empty?[]:window.__customers,meta:{totalItems:window.__empty?0:30}}; } export async function getPlateHistoryAction() { return {data:[],meta:{totalItems:0}}; }`);
  write('tour.tsx', `export const PageTour = () => null;`);
  write('tenant.tsx', `export const useTenant = () => ({ cobroHabilitado: true });`);
  write('entry.tsx', `import React from 'react'; import {createRoot} from 'react-dom/client'; import {FrequentCustomersBody} from '@/app/(protected)/admin/frecuentes/components/frequent-customers-body'; window.__requests=[]; createRoot(document.getElementById('root')).render(<FrequentCustomersBody initialCustomers={window.__customers} initialTotal={30}/>);`);
  const compiler = webpack({
    mode: 'development', devtool: false, context: front,
    entry: path.join(output, 'entry.tsx'), output: { path: output, filename: 'bundle.js' },
    resolve: { extensions: ['.tsx','.ts','.js','.jsx'], modules:[path.join(front,'node_modules'),'node_modules'], alias:{
      'react$':frontRequire.resolve('react'), 'react-dom/client$':frontRequire.resolve('react-dom/client'),
      'next/link$':path.join(output,'navigation.tsx'), 'next/navigation$':path.join(output,'navigation.tsx'),
      '@/components/vehicle-type-options$':path.join(output,'vehicles.ts'),
      '@/actions/tickets/get-frequent-customers.action$':path.join(output,'actions.ts'),
      '@/actions/tickets/get-plate-history.action$':path.join(output,'actions.ts'),
      '@/components/page-tour$':path.join(output,'tour.tsx'),
      '@/components/tenant-provider$':path.join(output,'tenant.tsx'),
      '@/lib/toast$':path.join(output,'toast.ts'), '@':path.join(front,'src'),
    }},
    module: { rules: [{ test: /\.(tsx?|jsx)$/, exclude: /node_modules/, use: path.join(output, 'loader.cjs') }, { test: /\.css$/, use: path.join(output, 'css-vacio.cjs') }] },
  });

  await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
  const configModule = { exports: {} };
  const configSource = ts.transpileModule(fs.readFileSync(path.join(front, 'tailwind.config.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  new Function('require', 'module', 'exports', configSource)(frontRequire, configModule, configModule.exports);
  const config = configModule.exports.default;
  config.content = [path.join(front, 'src/**/*.{tsx,ts}').replaceAll('\\', '/')];
  const css = await frontRequire('postcss')([frontRequire('tailwindcss')(config)]).process(fs.readFileSync(path.join(front, 'src/app/globals.css'), 'utf8'), { from: undefined });
  return css.css;
}

test('frecuentes: filtros aplicados, paginación, permanencia, historial y móvil', {timeout:120000}, async()=>{
 const css=await bundle(); const browser=await puppeteer.launch({headless:true});
 try {
 const page=await browser.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.setViewport({width:1440,height:1000});
 await page.setContent('<html class="dark" style="--font-sans:Arial;--font-display:Arial;--font-mono:monospace"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><main id="root" class="container mx-auto px-4 py-6"></main></html>');
 await page.evaluate(()=>{ window.__vehicles=[{code:'AUTO',name:'Auto',enabled:true},{code:'MOTO',name:'Moto',enabled:true}]; window.__customers=[{licensePlateNormalized:'AA123BB',licensePlateOriginal:'AA 123 BB',lastNameCustomer:'García',phoneCustomer:'5492614000000',vehicleType:'AUTO',visits:9,firstVisit:'2026-08-01',lastVisit:'2026-09-27',avgDaysBetweenVisits:7.125,medianDurationMinutes:45,minDurationMinutes:10,maxDurationMinutes:125,mostCommonBracket:'Hasta 1 hora',totalSpent:18500},{licensePlateNormalized:'A123BCD',licensePlateOriginal:'A123BCD',lastNameCustomer:null,phoneCustomer:null,vehicleType:'MOTO',visits:3,firstVisit:'2026-09-01',lastVisit:'2026-09-25',avgDaysBetweenVisits:12,medianDurationMinutes:null,minDurationMinutes:null,maxDurationMinutes:null,mostCommonBracket:null,totalSpent:3000}]; });
 await page.addScriptTag({path:path.join(output,'bundle.js')});
 const click=async text=>{const b=await page.waitForFunction(text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text),{},text);await b.asElement().click();};
 await page.waitForSelector('tbody tr');
 // Filtros siempre a la vista, y en la fila la permanencia típica con su rango y la franja habitual.
 assert.ok(await page.$('form[data-tour="frecuentes-filtros"] input[aria-label="Mínimo de visitas"]'));
 const fila=await page.$eval('tbody tr',e=>e.textContent);assert.match(fila,/45 min/);assert.match(fila,/10 min a 2 h 05 min/);assert.match(fila,/Hasta 1 hora/);
 await click('Ver historial');await page.waitForSelector('[role="dialog"]');assert.match(await page.$eval('[role="dialog"]',e=>e.textContent),/AA 123 BB/);await page.keyboard.press('Escape');await page.waitForSelector('[role="dialog"]',{hidden:true});
 await page.click('input[aria-label="Mínimo de visitas"]',{clickCount:3});await page.keyboard.press('Backspace');await page.type('input[aria-label="Mínimo de visitas"]','5');
 await page.click('button[aria-label="Página siguiente"]');await page.waitForFunction(()=>window.__requests.length===1);assert.equal(await page.evaluate(()=>window.__requests[0].minVisits),2);assert.equal(await page.evaluate(()=>window.__requests[0].page),2);
 await click('Aplicar');await page.waitForFunction(()=>window.__requests.length===2);assert.equal(await page.evaluate(()=>window.__requests[1].minVisits),5);assert.equal(await page.evaluate(()=>window.__requests[1].page),1);
 await click('7 días');assert.equal(await page.evaluate(()=>window.__requests.length),2);
 await click('Aplicar');await page.waitForFunction(()=>window.__requests.length===3);assert.ok(await page.evaluate(()=>window.__requests[2].from && window.__requests[2].to));
 await page.evaluate(()=>window.__fail=true);await click('Aplicar');await page.waitForSelector('[role="alert"]');assert.equal(await page.$$eval('tbody tr',els=>els.length),2);
 await page.evaluate(()=>{window.__fail=false;window.__empty=true;});await click('Limpiar');await page.waitForFunction(()=>document.body.textContent.includes('No encontramos clientes'));
 assert.equal(await page.$eval('input[aria-label="Mínimo de visitas"]',e=>e.value),'2');
 await page.evaluate(()=>window.__empty=false);await click('Aplicar');await page.waitForSelector('tbody tr');
 await page.screenshot({path:path.join(output,'frecuentes-desktop.png'),fullPage:true});
 for(const width of [320,390,768,1024]) {await page.setViewport({width,height:850});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
 // En el celular la tabla pasa a tarjetas, con su propio acceso al historial.
 await page.setViewport({width:390,height:850});assert.equal(await page.$$eval('ul li',els=>els.filter(e=>e.offsetParent).length),2);
 await page.screenshot({path:path.join(output,'frecuentes-mobile.png'),fullPage:true});
 assert.deepEqual(errors,[]);
 } finally {await browser.close();}
});
