// Prueba manual: pnpm build; node --env-file=.env scripts/gemini-smoke.cjs
// Envía únicamente una consulta y datos ficticios. No accede a la base de datos.
require('reflect-metadata');
require('tsconfig-paths').register({ baseUrl: require('node:path').resolve('dist'), paths: { 'src/*': ['*'] } });
const { AssistantService } = require('../dist/assistant/assistant.service');
const { tenantContext } = require('../dist/tenancy/tenant-context');
async function main() {
  if (!process.env.GEMINI_API_KEY) throw new Error('MissingKey');
  const service = new AssistantService({ get: name => process.env[name] }, {}, {}, {});
  service.query = async name => {
    if (name !== 'active_vehicles') throw new Error('UnexpectedTool');
    return { scope: 'Datos ficticios de prueba: estadías por hora', total: 3, rows: [], limited: true };
  };
  const started = Date.now();
  const result = await tenantContext.run({ empresaId: 'smoke-company', playaId: 'smoke-playa', userId: 'smoke-user', role: 'USER' }, () => service.chat({ message: 'Consultá cuántos vehículos por hora hay activos ahora en esta playa.' }));
  console.log(JSON.stringify({ success: !!result.answer, consulted: result.consulted, reportsThree: /3|tres/i.test(result.answer), ms: Date.now() - started }));
  if (!result.consulted.includes('active_vehicles')) process.exitCode = 1;
}
main().catch(error => { console.log(JSON.stringify({ success: false, error: error.name, status: error.getStatus?.() })); process.exitCode = 1; });
