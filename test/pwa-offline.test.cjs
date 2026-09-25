const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const puppeteer = require('puppeteer');
const publicDir = path.resolve(__dirname, '../../estacionamiento-front-demo/public');

test('PWA operativa: entradas, salidas, persistencia offline, cifrado y reintento de sincronización', async () => {
  let disconnected = false, loseReply = true;
  const applied = new Map();
  const server = http.createServer(async (req, res) => {
    if (disconnected) { res.writeHead(503); res.end('unavailable'); return; }
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/api/offline/sync') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const op = JSON.parse(raw); applied.set(op.id, op);
      if (loseReply) { loseReply = false; res.destroy(); return; }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ status: 'SYNCED', operationId: op.id })); return;
    }
    if (pathname === '/sw.js' || /^\/offline[-.][a-z.\-]+$/.test(pathname) || ['/icon-192.png', '/icon-512.png'].includes(pathname)) {
      const file = path.join(publicDir, pathname);
      if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.html') ? 'text/html' : pathname.endsWith('.css') ? 'text/css' : 'image/png');
      res.end(fs.readFileSync(file)); return;
    }
    if (pathname === '/api/private') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ secret: 'do-not-cache' })); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Online</title><p>private-online-content</p><script>navigator.serviceWorker.register("/sw.js")</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(origin + '/tickets');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    await page.evaluate(async () => {
      await fetch('/api/private');
      const vault = await import('/offline-vault.js');
      const capturedAt = new Date().toISOString();
      await vault.saveOperations({ version: 2, sessionId: crypto.randomUUID(), deviceId: crypto.randomUUID(), capturedAt, expiresAt: Date.now() + 86400000, vehicles: [], pending: [], types: [{ code: 'AUTO', name: 'Auto' }], pricing: { version: 1, capturedAt, schedule: { dayStartHour: 8, dayEndHour: 20, graceMinutes: 0, pricingDayTypeBasis: 'ENTRY' }, brackets: [{ id: 'one', vehicleType: 'AUTO', ticketDayType: null, label: 'Hasta una hora', uptoMinutes: null, price: 1000, recurringUnitMinutes: null }] } }, 'frase-local-segura-123');
    });
    const cached = await page.evaluate(async () => { const paths = []; for (const name of await caches.keys()) for (const r of await (await caches.open(name)).keys()) paths.push(new URL(r.url).pathname); return paths; });
    assert.ok(cached.includes('/offline.html')); assert.ok(!cached.includes('/tickets')); assert.ok(!cached.includes('/api/private'));
    disconnected = true; await page.setOfflineMode(true);
    await page.goto(origin + '/tickets', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#unlock');
    await page.type('#password', 'incorrecta'); await page.click('#unlock button');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('no coincide'));
    await page.type('#password', 'frase-local-segura-123'); await page.click('#unlock button');
    await page.waitForFunction(() => !document.querySelector('#workspace').hidden);
    await page.type('#plate', 'ABC123'); await page.click('#entry button');
    await page.waitForFunction(() => document.querySelector('#pending').textContent.startsWith('1 '));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.type('#password', 'frase-local-segura-123'); await page.click('#unlock button');
    await page.waitForFunction(() => document.querySelector('#rows').textContent.includes('ABC123'));
    await page.waitForFunction(() => !document.querySelector('#rows button').disabled);
    await page.click('#rows button');
    await page.waitForFunction(() => !document.querySelector('#exit').hidden).catch(async e => { throw new Error(e.message + ': ' + await page.$eval('#status', el => el.textContent)); });
    await page.click('#confirm-exit');
    await page.waitForFunction(() => document.querySelector('#pending').textContent.startsWith('2 '));
    assert.doesNotMatch(await page.$eval('#rows', el => el.textContent), /ABC123/);
    const stored = await page.evaluate(async () => {
      const db = await new Promise(resolve => { const r = indexedDB.open('parking-offline-consultation-v1'); r.onsuccess = () => resolve(r.result); });
      const record = await new Promise(resolve => { const r = db.transaction('vault').objectStore('vault').get('operations'); r.onsuccess = () => resolve(r.result); }); db.close();
      return new TextDecoder().decode(record.encrypted);
    });
    assert.ok(!stored.includes('ABC123'));
    for (const width of [320, 390, 768]) { await page.setViewport({ width, height: 740 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); }
    disconnected = false; await page.setOfflineMode(false);
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('No se borró'));
    await page.click('#sync');
    await page.waitForFunction(() => document.querySelector('#pending').textContent.startsWith('0 '));
    assert.equal(applied.size, 2);
    const ops = [...applied.values()]; assert.deepEqual(ops.map(o => o.kind), ['ENTRY', 'EXIT']); assert.equal(ops[0].registrationId, ops[1].registrationId);
    assert.equal(ops[1].expectedPrice, 1000);
    const parity = await page.evaluate(async () => {
      const { state } = await (await import('/offline-vault.js')).openOperations('frase-local-segura-123');
      const engine = await import('/offline-stay-pricing.js');
      const entry = '2026-09-24T22:30:00Z';
      const cases = [0, 1, 59, 60, 61, 120, 1440].map(minutes => ({ entry, exit: new Date(Date.parse(entry) + minutes * 60000).toISOString() }));
      return { pricing: state.pricing, cases: cases.map(c => ({ ...c, result: engine.calculateStayPrice(state.pricing, 'AUTO', new Date(c.entry), new Date(c.exit)) })) };
    });
    const backendEngine = require('../dist/tickets/pricing/stay-pricing').calculateStayPrice;
    for (const c of parity.cases) assert.deepEqual(c.result, JSON.parse(JSON.stringify(backendEngine(parity.pricing, 'AUTO', new Date(c.entry), new Date(c.exit)))));
    const race = await page.evaluate(async () => {
      const vault = await import('/offline-vault.js'); const opened = await vault.openOperations('frase-local-segura-123');
      await vault.saveOperations(opened.state, 'frase-local-segura-123', opened.revision);
      try { await vault.saveOperations(opened.state, 'frase-local-segura-123', opened.revision); return false; } catch { return true; }
    });
    assert.equal(race, true);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
