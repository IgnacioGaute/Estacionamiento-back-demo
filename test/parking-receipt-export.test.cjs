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
