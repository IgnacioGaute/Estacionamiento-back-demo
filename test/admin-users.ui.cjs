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
const output = path.resolve(__dirname, '../.tmp/admin-users-ui');
const write = (name, content) => fs.writeFileSync(path.join(output, name), content, 'utf8');

async function bundle() {
  fs.mkdirSync(output, { recursive: true });
  write('loader.cjs', `const ts = require(${JSON.stringify(require.resolve('typescript'))}); module.exports = function(source) { return ts.transpileModule(source, { fileName: this.resourcePath, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText; };`);
  // Los .css que importan los componentes no hacen falta: Tailwind se compila aparte, más abajo.
  write('css-vacio.cjs', `module.exports = function() { return ''; };`);
  write('navigation.tsx', `export const useRouter = () => ({refresh() { window.__refreshes = (window.__refreshes || 0) + 1; }}); export const usePathname = () => '/admin/users'; export const useSearchParams = () => new URLSearchParams();`);
  write('session.tsx', `export const useSession = () => ({status: 'authenticated', data: {user: {id: 'yo', role: 'ADMIN'}}}); export const signOut = () => {};`);
  write('tenant.tsx', `export const useTenant = () => ({playaId: 'p1', context: {empresa: {id: 'e'}, playas: [{id: 'p1', nombre: 'Centro'}, {id: 'p2', nombre: 'Terminal'}]}, cobroHabilitado: true});`);
  write('toast.ts', `export const toast = {success(m) { window.__toast = m; }, error(m) { window.__toast = m; }};`);
  write('actions.ts', `
    export async function updateUserAction(id, values) { window.__updates.push({id, values}); return window.__updateError ? {error: {code: 'ULTIMO_ADMIN', message: 'La empresa tiene que tener al menos un administrador.'}} : {success: true}; }
    export async function updatePassword() { return {success: true}; }
    export async function getUserByUsername() { return null; }
    export async function deleteUserAction() { return {success: true}; }
    export async function registerAction(input) { window.__creates.push(input.values); return {success: 'Usuario creado en tu empresa.'}; }
    export async function operatorPlayaAction() { return {playas: [{id: 'p1', nombre: 'Centro'}, {id: 'p2', nombre: 'Terminal'}], playaId: 'p1'}; }`);
  write('entry.tsx', `import React from 'react'; import {createRoot} from 'react-dom/client'; import {UsersBody} from '@/app/(protected)/admin/users/components/users-body'; import {CreateUserDialog} from '@/app/(protected)/admin/users/components/create-user-dialog'; window.__updates=[]; window.__creates=[]; createRoot(document.getElementById('root')).render(<div className="flex flex-col gap-5"><CreateUserDialog/><UsersBody data={window.__users} assignments={window.__assignments}/></div>);`);
  const actions = path.join(output, 'actions.ts');
  const compiler = webpack({
    mode: 'development', devtool: false, context: front,
    entry: path.join(output, 'entry.tsx'), output: { path: output, filename: 'bundle.js' },
    resolve: { extensions: ['.tsx','.ts','.js','.jsx'], modules:[path.join(front,'node_modules'),'node_modules'], alias:{
      'react$':frontRequire.resolve('react'), 'react-dom/client$':frontRequire.resolve('react-dom/client'),
      'next/navigation$':path.join(output,'navigation.tsx'), 'next-auth/react$':path.join(output,'session.tsx'),
      '@/components/tenant-provider$':path.join(output,'tenant.tsx'), '@/lib/toast$':path.join(output,'toast.ts'),
      '@/actions/users/update-user.action$':actions, '@/actions/users/update-password.action$':actions,
      '@/actions/users/find-user.action$':actions, '@/actions/users/delete-user.action$':actions,
      '@/actions/auth/register.action$':actions, '@/actions/tenancy/context.action$':actions,
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

const usuario = (id, firstName, lastName, role) => ({ id, firstName, lastName, role, username: firstName.toLowerCase(), email: `${firstName.toLowerCase()}@example.test`, createdAt: '', updatedAt: '' });

test('usuarios: resumen, filtros, rol al crear y al editar (con playa al pasar a operador)', { timeout: 120000 }, async () => {
  const css = await bundle(); const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.setViewport({ width: 1440, height: 1000 });
    await page.setContent('<html class="dark" style="--font-sans:Arial;--font-display:Arial;--font-mono:monospace"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + css + '</style><main id="root" class="container mx-auto px-4 py-6"></main></html>');
    await page.evaluate((users) => { window.__users = users; window.__assignments = { op1: { id: 'p1', nombre: 'Centro' }, op2: null }; },
      [usuario('yo', 'Ana', 'Dueña', 'ADMIN'), usuario('ad2', 'Bruno', 'Socio', 'ADMIN'), usuario('op1', 'Carla', 'Caja', 'USER'), usuario('op2', 'Dario', 'Noche', 'USER')]);
    await page.addScriptTag({ path: path.join(output, 'bundle.js') });
    const click = async (text, root = 'body') => { const b = await page.waitForFunction((text, root) => [...document.querySelector(root).querySelectorAll('button')].find(b => b.textContent.trim() === text && b.offsetParent), {}, text, root); await b.asElement().click(); };
    const filas = () => page.$$eval('tbody tr', els => els.map(e => e.textContent));
    await page.waitForSelector('tbody tr', { timeout: 10000 }).catch((e) => { throw new Error(errors.join('\n') || e.message); });

    // Resumen: 4 usuarios, 2 administradores, 2 operadores, 1 sin playa.
    const tarjetas = await page.$$eval('section[aria-label="Resumen"] > div', els => els.map(e => e.textContent));
    assert.match(tarjetas[0], /Usuarios4/); assert.match(tarjetas[1], /Admins2/); assert.match(tarjetas[2], /Operadores2/); assert.match(tarjetas[3], /Sin playa1/);
    await click('Operadores2');
    assert.deepEqual((await filas()).length, 2);
    await click('Todos4');
    await page.type('input[aria-label="Buscar usuario"]', 'bruno');
    assert.equal((await filas()).length, 1);
    await page.click('input[aria-label="Buscar usuario"]', { clickCount: 3 }); await page.keyboard.press('Backspace');
    await page.screenshot({ path: path.join(output, 'usuarios-desktop.png'), fullPage: true });

    // Alta: elige administrador.
    await click('Nuevo usuario');
    await page.waitForSelector('[role="dialog"] input[name="rol-nuevo"]');
    await page.click('[role="dialog"] input[name="rol-nuevo"][value="ADMIN"] + *');
    await page.type('[role="dialog"] input[name="firstName"]', 'Elena'); await page.type('[role="dialog"] input[name="lastName"]', 'Nueva');
    await page.type('[role="dialog"] input[name="username"]', 'elena'); await page.type('[role="dialog"] input[name="email"]', 'elena@example.test');
    await page.type('[role="dialog"] input[name="password"]', 'password123'); await page.type('[role="dialog"] input[name="confirmPassword"]', 'password123');
    await click('Crear usuario', '[role="dialog"]');
    await page.waitForFunction(() => window.__creates.length === 1);
    assert.equal(await page.evaluate(() => window.__creates[0].role), 'ADMIN');
    await page.waitForSelector('[role="dialog"]', { hidden: true });

    // Edición de otro administrador: pasa a operador y elige la playa Terminal.
    const abrirEdicion = async (nombre) => {
      await page.click(`tbody button[aria-label^="Editar a ${nombre}"]`);
      await page.waitForSelector('[role="dialog"]');
    };
    await abrirEdicion('Bruno');
    assert.equal(await page.$('[role="dialog"] input[name="playa-rol-ad2"]'), null);
    await page.click('[role="dialog"] input[name="rol-ad2"][value="USER"] + *');
    await page.waitForSelector('[role="dialog"] input[name="playa-rol-ad2"]');
    assert.match(await page.$eval('[role="dialog"]', e => e.textContent), /Al guardar se cierra su sesión/);
    await page.click('[role="dialog"] input[name="playa-rol-ad2"][value="p2"] + *');
    await page.screenshot({ path: path.join(output, 'usuarios-editar-rol.png') });
    await click('Actualizar perfil', '[role="dialog"]');
    await page.waitForFunction(() => window.__updates.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__updates[0]), { id: 'ad2', values: { username: 'bruno', firstName: 'Bruno', lastName: 'Socio', role: 'USER', playaId: 'p2' } });
    await page.waitForSelector('[role="dialog"]', { hidden: true });

    // Error del backend: se muestra y el diálogo queda abierto.
    await page.evaluate(() => { window.__updateError = true; });
    await abrirEdicion('Bruno');
    await page.click('[role="dialog"] input[name="rol-ad2"][value="USER"] + *');
    await click('Actualizar perfil', '[role="dialog"]');
    await page.waitForFunction(() => window.__updates.length === 2);
    assert.match(await page.evaluate(() => window.__toast), /al menos un administrador/);
    assert.ok(await page.$('[role="dialog"]'));
    await page.keyboard.press('Escape'); await page.waitForSelector('[role="dialog"]', { hidden: true });
    await page.evaluate(() => { window.__updateError = false; });

    // Sin cambiar el rol no viaja rol ni playa; la cuenta propia no muestra el selector.
    await abrirEdicion('Carla');
    await click('Actualizar perfil', '[role="dialog"]');
    await page.waitForFunction(() => window.__updates.length === 3);
    assert.deepEqual(Object.keys(await page.evaluate(() => window.__updates[2].values)).sort(), ['firstName', 'lastName', 'username']);
    await page.keyboard.press('Escape'); await page.waitForSelector('[role="dialog"]', { hidden: true });
    await abrirEdicion('Ana');
    assert.equal(await page.$('[role="dialog"] input[name="rol-yo"]'), null);
    await page.keyboard.press('Escape'); await page.waitForSelector('[role="dialog"]', { hidden: true });

    for (const width of [320, 390, 768, 1024]) { await page.setViewport({ width, height: 850 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'desborde en ' + width); }
    await page.setViewport({ width: 390, height: 850 });
    assert.equal(await page.$$eval('ul li', els => els.filter(e => e.offsetParent).length), 4);
    await page.screenshot({ path: path.join(output, 'usuarios-mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
