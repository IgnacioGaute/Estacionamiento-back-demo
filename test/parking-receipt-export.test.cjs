// Prueba de exportación en navegador real, sin servidor ni base de datos.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const puppeteer = require('puppeteer');
const { PDFDocument } = require('../../estacionamiento-comprobantes-demo/node_modules/pdf-lib');

test('exporta entrada y salida a PNG y PDF sin recortar textos largos', async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ path: require.resolve('../../estacionamiento-comprobantes-demo/node_modules/pdf-lib/dist/pdf-lib.min.js') });
    const source = fs.readFileSync(path.resolve(__dirname, '../../estacionamiento-comprobantes-demo/src/utils/parking-receipt-export.ts'), 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    await page.addScriptTag({ content: 'var exports = {}; var require = () => window.PDFLib;' + js });
    const results = await page.evaluate(async () => {
      const results = [];
      for (const kind of ['ENTRY', 'EXIT']) {
        const receipt = { kind, parkingName: 'Playa Colón con nombre largo '.repeat(4), address: 'Colón 4356', plate: 'A232NTM', vehicleType: 'AUTO', entryDay: '2026-09-23', entryTime: '11:18:00', departureDay: '2026-09-23', departureTime: '11:20:00', total: 1000, collected: 1000 };
        const png = await exports.receiptImage(receipt);
        const bitmap = await createImageBitmap(png);
        const pdf = await exports.receiptPdf(png);
        results.push({ width: bitmap.width, height: bitmap.height, pngBytes: png.size, pdf: Array.from(new Uint8Array(await pdf.arrayBuffer())), name: exports.receiptFileName(receipt) });
      }
      return results;
    });
    for (const result of results) {
      const pdf = await PDFDocument.load(Uint8Array.from(result.pdf));
      assert.equal(pdf.getPageCount(), 1);
      assert.equal(result.width, 720);
      assert.ok(result.pngBytes > 1000);
      assert.ok(Math.abs(pdf.getPage(0).getHeight() - result.height * 288 / 720) < 0.01);
      assert.match(result.name, /^comprobante-(entrada|salida)-A232NTM-2026-09-23$/);
    }
    assert.ok(results[1].height > results[0].height);
  } finally { await browser.close(); }
});

test('exporta el recibo de pago de un inquilino, también anulado', async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ path: require.resolve('../../estacionamiento-comprobantes-demo/node_modules/pdf-lib/dist/pdf-lib.min.js') });
    const source = fs.readFileSync(path.resolve(__dirname, '../../estacionamiento-comprobantes-demo/src/utils/parking-receipt-export.ts'), 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    await page.addScriptTag({ content: 'var exports = {}; var require = () => window.PDFLib;' + js });
    const results = await page.evaluate(async () => {
      const results = [];
      for (const anulado of [false, true]) {
        const receipt = {
          kind: 'PAGO', parkingName: 'Playa Colón', address: 'Colón 4356', numero: '000123', fecha: '2026-09-28',
          cliente: 'Gómez María de los Ángeles con un apellido compuesto larguísimo',
          total: 45000, medios: [{ medio: 'Efectivo', importe: 20000 }, { medio: 'MercadoPago', importe: 25000 }],
          aplicado: [
            { concepto: 'Abono de agosto 2026', importe: 30000, queda: 0 },
            { concepto: 'Abono de septiembre 2026 con un concepto que no entra en una sola línea', importe: 15000, queda: 15000 },
          ],
          aFavor: 0, saldo: 15000, anulado,
        };
        const png = await exports.receiptImage(receipt);
        const bitmap = await createImageBitmap(png);
        const pdf = await exports.receiptPdf(png);
        results.push({ width: bitmap.width, height: bitmap.height, pngBytes: png.size, pdf: Array.from(new Uint8Array(await pdf.arrayBuffer())), name: exports.receiptFileName(receipt) });
      }
      return results;
    });
    for (const result of results) {
      const pdf = await PDFDocument.load(Uint8Array.from(result.pdf));
      assert.equal(pdf.getPageCount(), 1);
      assert.equal(result.width, 720);
      assert.ok(result.pngBytes > 1000);
      assert.equal(result.name, 'recibo-pago-000123-2026-09-28');
    }
    // El anulado lleva el sello: tiene que ocupar más alto que el mismo recibo sin anular.
    assert.ok(results[1].height > results[0].height);
  } finally { await browser.close(); }
});
