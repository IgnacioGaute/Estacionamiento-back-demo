const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const postcss = require('../../estacionamiento-front-demo/node_modules/postcss');
const tailwind = require('../../estacionamiento-front-demo/node_modules/tailwindcss');

test('comprobante mobile: dialogo, cuerpo, QR y botones no desbordan', async () => {
  const front = path.resolve(__dirname, '../../estacionamiento-front-demo');
  const dialog = fs.readFileSync(path.join(front, 'src/components/ui/dialog.tsx'), 'utf8');
  const receipt = fs.readFileSync(path.join(front, 'src/components/parking-receipt-delivery.tsx'), 'utf8');
  const outerClass = dialog.match(/"(fixed left-\[50%\][^"]+)"/)[1];
  const bodyClass = dialog.match(/data-dialog-body className="([^"]+)"/)[1];
  const receiptClass = receipt.match(/<DialogContent className="([^"]+)"/)[1];
  const qrClass = receipt.match(/marginSize=\{4\} className="([^"]+)"/)[1];
  const html = `<div role="dialog" class="${outerClass} ${receiptClass}"><div class="h-[6px] w-full"></div><div data-dialog-body class="${bodyClass}"><h2>Entregar comprobante</h2><article><h1>${'NombreLargo'.repeat(12)}</h1>${'<p>Datos del comprobante de estacionamiento</p>'.repeat(20)}</article><div class="min-w-0 space-y-2 text-center"><svg width="224" height="224" viewBox="0 0 224 224" class="${qrClass}"><rect width="224" height="224" fill="white"/></svg></div><a class="inline-flex items-center justify-center whitespace-nowrap" href="#">Enviar por WhatsApp a +5491112345678</a></div></div>`;
  const css = (await postcss([tailwind({ content: [{ raw: html, extension: 'html' }], corePlugins: { preflight: true } })]).process('@tailwind base; @tailwind utilities;', { from: undefined })).css;
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const width of [320, 375, 390, 430]) {
      await page.setViewport({ width, height: 640, isMobile: true });
      await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style>${html}`);
      const metrics = await page.evaluate(() => {
        const dialog = document.querySelector('[role=dialog]');
        const body = document.querySelector('[data-dialog-body]');
        const bounds = dialog.getBoundingClientRect();
        return { viewport: innerWidth, left: bounds.left, right: bounds.right, bodyWidth: body.clientWidth, scrollWidth: body.scrollWidth, height: body.clientHeight, scrollHeight: body.scrollHeight };
      });
      assert.ok(metrics.left >= 0 && metrics.right <= metrics.viewport, JSON.stringify(metrics));
      assert.ok(metrics.scrollWidth <= metrics.bodyWidth + 1, JSON.stringify(metrics));
      assert.ok(metrics.scrollHeight > metrics.height, 'El contenido largo debe desplazarse verticalmente');
    }
  } finally { await browser.close(); }
});
