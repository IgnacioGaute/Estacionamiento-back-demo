// Componentes reales del frontend con acciones simuladas; sin .env ni base de datos.
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
const output = path.resolve(__dirname, '../.tmp/avisos-ui');
const write = (name, content) => fs.writeFileSync(path.join(output, name), content, 'utf8');

async function bundle() {
  fs.mkdirSync(output, { recursive: true });
  write('loader.cjs', `const ts = require(${JSON.stringify(require.resolve('typescript'))}); module.exports = function(source) { return ts.transpileModule(source, { fileName: this.resourcePath, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText; };`);
  // Los .css que importan los componentes no hacen falta: Tailwind se compila aparte, más abajo.
  write('css-vacio.cjs', `module.exports = function() { return ''; };`);
  write('navigation.tsx', `export const useRouter = () => ({refresh() {}}); export const usePathname = () => '/notes'; export const useSearchParams = () => new URLSearchParams();`);
  write('session.tsx', `export const useSession = () => ({status: 'authenticated', data: {user: {id: 'yo', role: 'USER'}}});`);
  write('tenant.tsx', `export const useTenant = () => ({playaId: 'p1', context: {empresa: {id: 'e'}, playas: []}, cobroHabilitado: true});`);
  write('toast.ts', `export const toast = {success(m) { window.__toast = m; }, error(m) { window.__toast = m; }};`);
  write('actions.ts', `
    export async function listNotesAction(page, search, filtros) { window.__pedidos.push({page, search, ...filtros}); return window.__lista; }
    export async function readNoteAction(id) { window.__leidos.push(id); }
    export async function readAllNotesAction() { window.__todo = true; }
    export async function updateNoteAction() { return {}; }
    export async function deleteNoteAction() { return {success: 'Aviso eliminado'}; }`);
  write('entry.tsx', `import React from 'react'; import {createRoot} from 'react-dom/client'; import {AvisosBody} from '@/app/(protected)/(user)/notes/components/avisos-body'; window.__pedidos=[]; window.__leidos=[]; createRoot(document.getElementById('root')).render(<AvisosBody inicial={window.__lista}/>);`);
  const actions = path.join(output, 'actions.ts');
  const compiler = webpack({
    mode: 'development', devtool: false, context: front,
    entry: path.join(output, 'entry.tsx'), output: { path: output, filename: 'bundle.js' },
    resolve: { extensions: ['.tsx','.ts','.js','.jsx'], modules:[path.join(front,'node_modules'),'node_modules'], alias:{
      'react$':frontRequire.resolve('react'), 'react-dom/client$':frontRequire.resolve('react-dom/client'),
      'next/navigation$':path.join(output,'navigation.tsx'), 'next-auth/react$':path.join(output,'session.tsx'),
      '@/components/tenant-provider$':path.join(output,'tenant.tsx'), '@/lib/toast$':path.join(output,'toast.ts'),
      '@/actions/notes/list-notes.action$':actions, '@/actions/notes/note-read.action$':actions,
      '@/actions/notes/update-note.action$':actions, '@/actions/notes/delete-note.action$':actions,
      '@':path.join(front,'src'),
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

// Hoy en Buenos Aires, para que el grupo «Hoy» salga igual en cualquier zona horaria.
const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const hora = (h) => new Date(`${hoy}T${h}:00-03:00`).toISOString();
const franco = { id: 'franco', firstName: 'Franco', lastName: 'Pizarro' };
const lista = {
  data: [
    { id: 'n1', sourceKey: 'movimiento:1', sourceType: 'TICKET', origin: 'Descuento de vehículo', context: 'GXI548 · $ 3.500', description: 'Se cobra la tarifa anterior (Hasta 2 horas): demoró en pagar', user: franco, date: hoy, createdAt: hora('14:50') },
    { id: 'n2', sourceKey: 'cierre:2', sourceType: 'TURNO', origin: 'Cierre de turno', context: 'Caja principal · Tarde', description: 'Faltaron $ 200 en el arqueo, lo revisamos mañana con el encargado de la noche.', user: franco, date: hoy, createdAt: hora('14:14') },
    { id: 'n3', description: 'El portón de la salida quedó trabado: abrir con la llave del tablero.', user: { id: 'yo', firstName: 'Ana', lastName: 'Dueña' }, date: hoy, createdAt: hora('11:54') },
    { id: 'n4', sourceKey: 'movimiento:4', sourceType: 'TICKET', origin: 'Descuento de vehículo', context: 'AE522SH · $ 3.500', description: 'Se cobra la tarifa anterior (Hasta 1 hora): demoró en pagar', user: franco, date: '2026-10-19', createdAt: '2026-10-19T14:33:00.000Z' },
    { id: 'n5', sourceKey: 'cliente:5', sourceType: 'RENTER', origin: 'Comentario de inquilino', context: 'Pérez Juan', description: 'Llamar antes de renovar el abono.', user: null, date: '2026-10-17', createdAt: '2026-10-17T12:00:00.000Z' },
  ],
  meta: { totalItems: 24, totalPages: 2, itemsPerPage: 20, currentPage: 1, sortBy: [] }, links: {},
  pendientes: ['n1', 'n2'], conteos: { todos: 24, sinLeer: 2, leidos: 22 }, resumen: { total: 24, sinLeer: 2, hoy: 3 },
  autores: [{ id: 'yo', nombre: 'Ana Dueña' }, { id: 'franco', nombre: 'Franco Pizarro' }],
};

test('avisos: grupos, lectura tocando el aviso, filtros y móvil', { timeout: 120000 }, async () => {
  const css = await bundle(); const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.setViewport({ width: 1440, height: 1000 });
    await page.setContent('<html class="dark" style="--font-sans:Arial;--font-display:Arial;--font-mono:monospace"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + css + '</style><main id="root" class="container mx-auto max-w-7xl px-4 py-6"></main></html>');
    await page.evaluate((l) => { window.__lista = l; }, lista);
    await page.addScriptTag({ path: path.join(output, 'bundle.js') });
    await page.waitForSelector('article', { timeout: 10000 }).catch((e) => { throw new Error(errors.join('\n') || e.message); });

    const grupos = await page.$$eval('section[aria-label="Avisos"] h3', els => els.map(e => e.textContent));
    assert.deepEqual(grupos.slice(0, 2), ['Sin leer', 'Hoy']);
    assert.equal(await page.$$eval('article[data-pendiente]', els => els.length), 2);
    await page.screenshot({ path: path.join(output, 'avisos-desktop.png'), fullPage: true });

    // Tocar el texto del aviso (no un botón) lo marca como leído.
    await page.evaluate(() => [...document.querySelectorAll('article p')].find(p => p.textContent.startsWith('Faltaron')).click());
    await page.waitForFunction(() => window.__leidos.includes('n2'));
    assert.equal(await page.$$eval('article[data-pendiente]', els => els.length), 1);
    assert.match(await page.$eval('section[aria-label="Resumen"]', e => e.textContent), /Sin leer1/);
    // Editar un aviso propio no marca nada.
    await page.click('article button[aria-label="Editar aviso"]');
    await page.waitForSelector('[role="dialog"]'); await page.keyboard.press('Escape'); await page.waitForSelector('[role="dialog"]', { hidden: true });
    assert.deepEqual(await page.evaluate(() => window.__leidos), ['n2']);

    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.startsWith('Sin leer')).click());
    await page.waitForFunction(() => window.__pedidos.some(p => p.estado === 'SIN_LEER'));

    for (const width of [320, 390, 768, 1024]) { await page.setViewport({ width, height: 850 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'desborde en ' + width); }
    await page.setViewport({ width: 390, height: 850 });
    await page.screenshot({ path: path.join(output, 'avisos-mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
