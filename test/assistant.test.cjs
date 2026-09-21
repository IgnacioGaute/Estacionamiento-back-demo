// Run against compiled backend: node --test test/assistant.test.cjs
require('reflect-metadata');
require('tsconfig-paths').register({ baseUrl: require('node:path').resolve('dist'), paths: { 'src/*': ['*'] } });
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AssistantService } = require('../dist/assistant/assistant.service');
const { tenantContext } = require('../dist/tenancy/tenant-context');
const scope = { empresaId: 'company-a', playaId: 'beach-a', userId: 'user-a', role: 'USER' };
const service = (ds = {}, config = { get: () => undefined }) => new AssistantService(config, ds, {}, {});

test('tools reject missing tenant context and operator history access', async () => {
  await assert.rejects(service().query('active_vehicles', {}), e => e.getStatus() === 403);
  await tenantContext.run(scope, async () => {
    await assert.rejects(service().query('shift_history', {}), e => e.getStatus() === 403);
    await assert.rejects(service().query('execute_sql', {}), e => e.getStatus() === 403);
  });
});
test('ticket lookup pins the authenticated playa and never calculates unavailable records', async () => {
  let criteria;
  const s = service({ getRepository: () => ({ findOne: async q => { criteria = q; return null; } }) });
  const id = '00000000-0000-4000-8000-000000000001';
  await tenantContext.run(scope, async () => {
    await assert.rejects(s.query('ticket_amount', { id, playaId: 'beach-b' }), e => e.getStatus() === 403);
    assert.deepEqual(criteria.where, { id, playaId: 'beach-a' });
  });
});
test('missing key fails safely without contacting provider', async () => {
  await tenantContext.run(scope, () => assert.rejects(service().chat({ message: 'Ayuda' }), e => e.getStatus() === 503));
});
test('conversation ownership is enforced across users and playas', async () => {
  const oldFetch = global.fetch;
  const s = service({}, { get: key => key === 'GEMINI_API_KEY' ? 'test-key' : undefined });
  global.fetch = async () => ({ ok: true, json: async () => ({ candidates: [{ content: { role: 'model', parts: [{ text: 'Abrí Turno actual.' }] } }] }) });
  try {
    const result = await tenantContext.run(scope, () => s.chat({ message: 'Cómo cierro?' }));
    assert.equal(result.answer, 'Abrí Turno actual.');
    await tenantContext.run({ ...scope, userId: 'user-b' }, () => assert.rejects(s.chat({ message: 'Continuar', conversationId: result.conversationId }), e => e.getStatus() === 403));
    await tenantContext.run({ ...scope, playaId: 'beach-b' }, () => assert.rejects(s.chat({ message: 'Continuar', conversationId: result.conversationId }), e => e.getStatus() === 403));
  } finally { global.fetch = oldFetch; }
});
