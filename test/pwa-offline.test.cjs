const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const puppeteer = require('puppeteer');
const publicDir = path.resolve(__dirname, '../../estacionamiento-front-demo/public');

test('PWA: recarga offline, copia cifrada, bloqueo y ausencia de caché privada', async () => {
  let disconnected = false;
  const server = http.createServer((req, res) => {
    if (disconnected) { res.writeHead(503); res.end('unavailable'); return; }
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.join(publicDir, pathname);
    if (['/sw.js', '/offline-vault.js', '/offline.js', '/offline.html', '/offline.css', '/icon-192.png', '/icon-512.png'].includes(pathname)) {
      res.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.html') ? 'text/html' : pathname.endsWith('.css') ? 'text/css' : 'image/png');
      res.end(fs.readFileSync(file)); return;
    }
    if (pathname === '/api/private') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ secret: 'do-not-cache' })); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Online</title><p>private-online-content</p><script>navigator.serviceWorker.register("/sw.js")</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(origin + '/tickets');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    await page.evaluate(async () => {
      await fetch('/api/private');
      const vault = await import('/offline-vault.js');
      await vault.saveSnapshot({ version: 1, capturedAt: new Date().toISOString(), expiresAt: Date.now() + 86400000, parking: 'Playa de prueba', vehicles: [{ identification: 'ABC123', type: 'AUTO', entry: '2026-09-24 12:00', period: 'Por hora' }], prices: [] }, 'frase-local-segura-123');
    });
    const cached = await page.evaluate(async () => {
      const result = [];
      for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) result.push(new URL(request.url).pathname);
      return result;
    });
    assert.ok(cached.includes('/offline.html'));
    assert.ok(!cached.includes('/tickets'));
    assert.ok(!cached.includes('/api/private'));
    const stored = await page.evaluate(async () => {
      const db = await new Promise(resolve => { const req = indexedDB.open('parking-offline-consultation-v1'); req.onsuccess = () => resolve(req.result); });
      const record = await new Promise(resolve => { const req = db.transaction('vault').objectStore('vault').get('current'); req.onsuccess = () => resolve(req.result); });
      db.close();
      return { keys: Object.keys(record), plaintext: new TextDecoder().decode(record.encrypted) };
    });
    assert.deepEqual(stored.keys.sort(), ['encrypted', 'iv', 'salt']);
    assert.ok(!stored.plaintext.includes('ABC123'));
    disconnected = true;
    await page.setOfflineMode(true);
    await page.goto(origin + '/tickets', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#unlock');
    await page.type('#password', 'frase-equivocada');
    await page.click('#unlock button');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('no coincide'));
    await page.type('#password', 'frase-local-segura-123');
    await page.click('#unlock button');
    await page.waitForFunction(() => !document.querySelector('#snapshot').hidden);
    assert.match(await page.$eval('#rows', el => el.textContent), /ABC123/);
    for (const width of [320, 390, 768]) {
      await page.setViewport({ width, height: 740 });
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
      assert.ok(fits, `No horizontal overflow at ${width}`);
    }
    await page.click('#lock');
    assert.equal(await page.$eval('#rows', el => el.textContent), '');
    await page.evaluate(async () => {
      const vault = await import('/offline-vault.js');
      await vault.saveSnapshot({ version: 1, expiresAt: Date.now() - 1 }, 'frase-local-segura-123');
    });
    await page.type('#password', 'frase-local-segura-123');
    await page.click('#unlock button');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('venció'));
    await page.evaluate(async () => (await import('/offline-vault.js')).clearSnapshot());
    await page.type('#password', 'frase-local-segura-123');
    await page.click('#unlock button');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('No hay una copia'));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
