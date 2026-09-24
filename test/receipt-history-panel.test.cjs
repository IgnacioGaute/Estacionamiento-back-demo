const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const front = path.resolve(__dirname, '../../estacionamiento-front-demo');
const frontRequire = createRequire(path.join(front, 'package.json'));
const ts = frontRequire('typescript');
const React = frontRequire('react');
const { renderToStaticMarkup } = frontRequire('react-dom/server');
const filename = path.join(front, 'src/app/(protected)/(user)/tickets/components/departure-history.tsx');
const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
const exportsObject = {};
const basic = tag => ({ children, ...props }) => React.createElement(tag, props, children);
vm.runInNewContext(output, { exports: exportsObject, require: name => {
  if (name === '@/components/ui/button') return { Button: basic('button') };
  if (name === '@/components/ui/input') return { Input: basic('input') };
  if (name === '@/components/animated-scroll-list') return { AnimatedScrollList: basic('div') };
  if (name === 'lucide-react') return { ReceiptText: basic('svg') };
  return frontRequire(name);
}, Date });
const render = props => renderToStaticMarkup(React.createElement(exportsObject.DepartureHistory, { registrations: [], dailyRegistrations: [], today: '2026-09-23', onReceipt() {}, ...props }));

test('historial inicia en hoy e incluye entradas activas y salidas, no otros días', () => {
  const html = render({ registrations: [
    { id: 'a', licensePlateOriginal: 'HOY123', entryDay: '2026-09-23' },
    { id: 'b', licensePlateOriginal: 'SAL123', entryDay: '2026-09-22', departureDay: '2026-09-23' },
    { id: 'c', licensePlateOriginal: 'AYER123', entryDay: '2026-09-22', departureDay: '2026-09-22' },
  ] });
  assert.match(html, /value="2026-09-23"/);
  assert.match(html, /Abrir comprobante de entrada de HOY123/);
  assert.doesNotMatch(html, /Abrir comprobante de salida de HOY123/);
  assert.match(html, /Abrir comprobante de salida de SAL123/);
  assert.doesNotMatch(html, /AYER123/);
});

test('abonos conservan fecha de entrada y convierten salida a Argentina', () => {
  const html = render({ dailyRegistrations: [
    { id: 'd', vehiclePlateCustomer: 'DIA123', dateNow: '2026-09-23', retired: false },
    { id: 'e', vehiclePlateCustomer: 'NOCHE123', dateNow: '2026-09-20', retired: true, retiredAt: '2026-09-24T01:00:00Z' },
  ] });
  assert.match(html, /Abrir comprobante de entrada de DIA123/);
  assert.match(html, /Abrir comprobante de salida de NOCHE123/);
});

test('fecha sin movimientos muestra estado vacío', () => {
  assert.match(render({ today: '2026-09-25' }), /No hay comprobantes para esta fecha y búsqueda/);
});
