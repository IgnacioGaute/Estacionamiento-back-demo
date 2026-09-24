const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requestGemini } = require('../dist/assistant/gemini-request');
const success = (parts = [{ text: 'Listo' }]) => new Response(JSON.stringify({ candidates: [{ content: { parts }, finishReason: 'STOP' }] }));
async function run(mock, fn) {
  const previous = global.fetch;
  global.fetch = mock;
  try { await fn(); } finally { global.fetch = previous; }
}
const ask = () => requestGemini('fake-key', ['primary', 'backup'], () => ({ contents: [] }), Date.now() + 10000, () => {});

test('503 persistente usa respaldo tras dos intentos, sin repetir cuatro veces el mismo modelo', async () => {
  const urls = [];
  await run(async url => { urls.push(url); return url.includes('/primary:') ? new Response('', { status: 503, headers: { 'retry-after': '0' } }) : success(); }, async () => {
    assert.equal((await ask()).model, 'backup');
    assert.equal(urls.length, 3);
  });
});
test('corte al leer el cuerpo tambien se reintenta', async () => {
  let count = 0;
  await run(async () => ++count === 1 ? { ok: true, json: async () => { throw new Error('connection reset'); } } : success(), async () => {
    assert.equal((await ask()).parts[0].text, 'Listo');
    assert.equal(count, 2);
  });
});
test('firmas originales se conservan para las herramientas', async () => {
  const parts = [{ text: 'Consulta', thoughtSignature: 'signed-text' }, { functionCall: { name: 'active_vehicles', args: {} }, thoughtSignature: 'signed-call' }];
  await run(async () => success(parts), async () => assert.deepEqual((await ask()).parts, parts));
});
test('errores de clave y cuota no provocan tormentas de reintentos', async () => {
  for (const status of [401, 403, 429]) {
    let count = 0;
    await run(async () => { count++; return new Response('', { status }); }, async () => {
      await assert.rejects(ask(), error => error.getStatus() === (status === 429 ? 429 : 502));
      assert.equal(count, 1);
    });
  }
});
test('modelo inexistente pasa al respaldo y deadline vencido no consulta', async () => {
  let count = 0;
  await run(async () => ++count === 1 ? new Response('', { status: 404 }) : success(), async () => assert.equal((await ask()).model, 'backup'));
  await run(async () => { throw new Error('No debe consultar'); }, async () => {
    await assert.rejects(requestGemini('fake', ['primary'], () => ({}), Date.now() - 1, () => {}), error => error.getStatus() === 503);
  });
});
test('los operadores pueden usar ambos endpoints del asistente', () => {
  const { OPERATOR_ENDPOINTS } = require('../dist/tenancy/endpoint-policy');
  assert.ok(OPERATOR_ENDPOINTS.AssistantController.includes('chat'));
  assert.ok(OPERATOR_ENDPOINTS.AssistantController.includes('stream'));
});
