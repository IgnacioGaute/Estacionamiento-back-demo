// PostgreSQL efímero: nunca lee .env ni utiliza la base del proyecto.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
require('reflect-metadata');
require('tsconfig-paths').register({ baseUrl: path.resolve('dist'), paths: { 'src/*': ['*'] } });
const { DataSource } = require('typeorm');
const { ValidationPipe } = require('@nestjs/common');
const load = (file, name) => require('../dist/' + file)[name];
const Ticket = load('tickets/entities/ticket.entity', 'Ticket');
const Price = load('tickets/entities/ticket-price.entity', 'TicketPrice');
const Bracket = load('tickets/entities/ticket-price-bracket.entity', 'TicketPriceBracket');
const Registration = load('tickets/entities/ticket-registration.entity', 'TicketRegistration');
const RegistrationDay = load('tickets/entities/ticket-registration-for-day.entity', 'TicketRegistrationForDay');
const Schedule = load('tickets/entities/ticket-schedule-settings.entity', 'TicketScheduleSettings');
const Vehicle = load('tickets/entities/vehicle-type.entity', 'VehicleTypeEntity');
const Empresa = load('tenancy/entities/empresa.entity', 'Empresa');
const Playa = load('tenancy/entities/playa.entity', 'Playa');
const User = load('users/entities/user.entity', 'User');
const { tenantContext, installTenantConnections } = require('../dist/tenancy/tenant-context');
const TicketsService = load('tickets/tickets.service', 'TicketsService');
const TariffPlanService = load('tickets/tariff-plan.service', 'TariffPlanService');
const { defaultPricingOptions } = require('../dist/tickets/pricing/pricing.types');
const { calculateStayPrice } = require('../dist/tickets/pricing/stay-pricing');
let ds, root, pgStarted = false, tickets, plans, a, b;
const bin = process.env.PG_TEST_BIN || 'C:/Program Files/PostgreSQL/18/bin';
const pg = (name, args) => {
  const output = fs.openSync(path.join(root, 'commands.log'), 'a');
  try { return execFileSync(path.join(bin, name + (process.platform === 'win32' ? '.exe' : '')), args, { windowsHide: true, stdio: ['ignore', output, output], timeout: 30000 }); }
  finally { fs.closeSync(output); }
};
const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const scoped = (scope, callback) => tenantContext.run(scope, callback);
const copy = value => structuredClone(value);
const requestFor = plan => ({ expectedRevision: plan.revision, schedule: copy(plan.schedule), brackets: copy(plan.brackets) });
const bracket = (price = 1000, extra = {}) => ({ vehicleType: 'AUTO', ticketDayType: null, label: 'Hora', uptoMinutes: 60, price, recurringUnitMinutes: null, recurringPriceMode: 'FIXED', ...extra });
const entryAt = '2026-09-26T19:00:00-03:00';
const simulate = (plan, extra = {}) => plans.simulate({ vehicleType: 'AUTO', entryAt, elapsedMinutes: 30, ...(plan ? { plan } : {}), ...extra });

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tariff-plan-pg-test-'));
  pg('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--locale=C']);
  const port = await freePort();
  pgStarted = true;
  pg('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'postgres.log'), '-o', '-h 127.0.0.1 -p ' + port + ' -F', '-w', 'start']);
  ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: 'postgres', entities: [path.resolve('dist/**/*.entity.js')], synchronize: true });
  await ds.initialize();
  const runner = ds.createQueryRunner();
  try { await new (load('database/migrations/1790000001000-tenant-isolation', 'TenantIsolation1790000001000'))().up(runner); }
  finally { await runner.release(); }
  installTenantConnections(ds);
  const repo = entity => ds.getRepository(entity);
  tickets = new TicketsService(repo(Ticket), repo(Price), repo(Bracket), repo(Registration), repo(RegistrationDay), repo(Schedule), {}, { emitNewRegistration() {} }, {}, ds);
  plans = new TariffPlanService(ds, tickets);
  for (const name of ['A', 'B']) {
    const empresa = await repo(Empresa).save({ nombre: name });
    const playa = await repo(Playa).save({ nombre: name, empresaId: empresa.id });
    const user = await repo(User).save({ username: name, email: name + '@example.test', firstName: name, lastName: 'Admin', role: 'ADMIN', empresaId: empresa.id });
    const scope = { empresaId: empresa.id, playaId: playa.id, userId: user.id, role: 'ADMIN' };
    if (name === 'A') a = scope; else b = scope;
    await scoped(scope, async () => {
      await tickets.createVehicleType({ code: 'AUTO', name: 'Auto' });
      await tickets.createPriceBracket(bracket(name === 'A' ? 1000 : 9000));
    });
  }
});

after(async () => {
  if (ds?.isInitialized) await ds.destroy();
  if (pgStarted && fs.existsSync(path.join(root, 'data', 'postmaster.pid'))) pg('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'immediate', '-w', 'stop']);
  if (root) {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('tariff-plan-pg-test-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('el simulador utiliza horarios y franjas del borrador sin guardar nada', async () => scoped(a, async () => {
  const current = await plans.getPlan();
  const draft = requestFor(current);
  draft.schedule.dayEndHour = 18;
  draft.schedule.pricingDayTypeBasis = 'ENTRY';
  draft.brackets = [bracket(2100, { ticketDayType: 'DAY' }), bracket(3400, { ticketDayType: 'NIGHT' })];
  assert.equal((await simulate()).price, 1000);
  assert.equal((await simulate(draft)).price, 3400);
  assert.deepEqual(await plans.getPlan(), current);
  assert.equal(await ds.getRepository(Registration).count(), 0);
}));

test('se puede simular un vehículo terminado pero aplicar exige precios de todos los activos', async () => scoped(a, async () => {
  await tickets.createVehicleType({ code: 'MOTO', name: 'Moto' });
  const current = await plans.getPlan();
  const draft = requestFor(current);
  draft.schedule.pricingOptions.charging = { enabled: true, mode: 'STARTED', unitMinutes: 60, rates: [{ vehicleType: 'AUTO', dayPrice: 2000, nightPrice: 2500 }] };
  assert.equal((await simulate(draft)).price, 2000);
  await assert.rejects(plans.updatePlan(draft), error => error.getResponse().code === 'TARIFF_PLAN_INCOMPLETE');
  assert.deepEqual(await plans.getPlan(), current);
  await tickets.updateVehicleType('MOTO', { enabled: false });
}));

test('aplicar conserva ids, snapshots antiguos, modo DERIVED y opciones ajenas a las tarifas', async () => scoped(a, async () => {
  await tickets.updateSchedule({ barcodeTicketsEnabled: true, shiftsEnabled: true, receiptDelivery: { whatsapp: true, qr: true, print: false, paperWidth: 58 } });
  const first = (await plans.getPlan()).brackets[0];
  await tickets.updatePriceBracket(first.id, { recurringPriceMode: 'DERIVED' });
  const registration = await tickets.createRegistrationByPlate({ vehicleType: 'AUTO', licensePlate: 'OLD001' });
  // Comparar JSONB persistido: las fechas internas se serializan como texto.
  const snapshot = copy((await ds.getRepository(Registration).findOneBy({ id: registration.id })).pricingSnapshot);
  const current = await plans.getPlan();
  const draft = requestFor(current);
  delete draft.brackets[0].id;
  delete draft.brackets[0].recurringPriceMode;
  draft.brackets[0].price = 2700;
  draft.schedule.dayEndHour = 18;
  draft.schedule.pricingOptions.stay = { ...draft.schedule.pricingOptions.stay, enabled: true, freeMinutes: 600 };
  const saved = await plans.updatePlan(draft);
  assert.equal(saved.brackets[0].id, first.id);
  assert.equal(saved.brackets[0].recurringPriceMode, 'DERIVED');
  assert.equal(saved.schedule.pricingOptions.stay.enabled, false);
  const settings = await tickets.getSchedule();
  assert.equal(settings.barcodeTicketsEnabled, true);
  assert.equal(settings.shiftsEnabled, true);
  assert.deepEqual(settings.receiptDelivery, { whatsapp: true, qr: true, print: false, paperWidth: 58 });
  assert.deepEqual((await ds.getRepository(Registration).findOneBy({ id: registration.id })).pricingSnapshot, snapshot);
  assert.equal(calculateStayPrice(snapshot, 'AUTO', new Date(entryAt), new Date(new Date(entryAt).getTime() + 30 * 60000)).price, 1000);
  const next = await tickets.createRegistrationByPlate({ vehicleType: 'AUTO', licensePlate: 'NEW001' });
  assert.equal(next.pricingSnapshot.schedule.dayEndHour, 18);
  assert.equal(next.pricingSnapshot.brackets[0].price, 2700);
}));

test('una revisión vieja o dos guardados simultáneos nunca pisan cambios', async () => scoped(a, async () => {
  const current = await plans.getPlan();
  const first = requestFor(current), second = requestFor(current);
  first.brackets[0].price = 3000;
  second.brackets[0].price = 4000;
  const results = await Promise.allSettled([plans.updatePlan(first), plans.updatePlan(second)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.getResponse().code, 'TARIFF_PLAN_CHANGED');
  const after = await plans.getPlan();
  await tickets.updateSchedule({ graceMinutes: after.schedule.graceMinutes + 1 });
  await assert.rejects(plans.updatePlan(requestFor(after)), error => error.getResponse().code === 'TARIFF_PLAN_CHANGED');
}));

test('un fallo de persistencia revierte franjas y horario en la misma transacción', async () => scoped(a, async () => {
  const current = await plans.getPlan();
  const draft = requestFor(current);
  draft.brackets[0].price += 111;
  draft.brackets.push(bracket(777, { uptoMinutes: 180, label: 'Tres horas' }));
  draft.schedule.graceMinutes = 77;
  // Un CHECK temporal fuerza un error luego de escribir las franjas, al guardar el horario.
  await tenantContext.run(undefined, () => ds.query('ALTER TABLE ticket_schedule_settings ADD CONSTRAINT test_tariff_rollback CHECK ("graceMinutes" <> 77)'));
  try { await assert.rejects(plans.updatePlan(draft), /test_tariff_rollback/); }
  finally { await tenantContext.run(undefined, () => ds.query('ALTER TABLE ticket_schedule_settings DROP CONSTRAINT test_tariff_rollback')); }
  assert.deepEqual(await plans.getPlan(), current);
}));

test('los ingresos esperan un guardado atómico y nunca congelan horario y precios mezclados', { timeout: 15000 }, async () => scoped(a, async () => {
  const current = await plans.getPlan();
  const draft = requestFor(current);
  draft.schedule.graceMinutes = 19;
  draft.brackets[0].price = 6800;
  let unblock, announce;
  const paused = new Promise(resolve => { announce = resolve; });
  const resume = new Promise(resolve => { unblock = resolve; });
  const originalRead = plans.read.bind(plans);
  let reads = 0;
  plans.read = async manager => {
    const result = await originalRead(manager);
    if (++reads === 1) { announce(); await resume; }
    return result;
  };
  const saving = plans.updatePlan(draft);
  await paused;
  const opening = tickets.createRegistrationByPlate({ vehicleType: 'AUTO', licensePlate: 'ATOMIC01' });
  try {
    let acquired = false;
    await ds.transaction(async manager => { [{ acquired }] = await manager.query('SELECT pg_try_advisory_xact_lock_shared(718903) AS acquired'); });
    assert.equal(acquired, false);
  } finally {
    unblock();
    plans.read = originalRead;
  }
  await saving;
  const registration = await opening;
  assert.equal(registration.pricingSnapshot.schedule.graceMinutes, 19);
  assert.equal(registration.pricingSnapshot.brackets[0].price, 6800);
}));

test('RLS aísla planes y rechaza ids de franjas pertenecientes a otra playa', async () => {
  const other = await scoped(b, () => plans.getPlan());
  await scoped(a, async () => {
    const current = await plans.getPlan();
    assert.equal(current.brackets.length, 1);
    assert.notEqual(current.brackets[0].id, other.brackets[0].id);
    const draft = requestFor(current);
    draft.brackets[0].id = other.brackets[0].id;
    await assert.rejects(plans.updatePlan(draft), /ya no existe/);
    assert.deepEqual(await plans.getPlan(), current);
  });
  assert.deepEqual(await scoped(b, () => plans.getPlan()), other);
  assert.equal(await scoped(b, () => simulate().then(result => result.price)), 9000);
});

test('validación rechaza duplicados y precios inválidos sin aceptar flags o datos de otras playas', async () => scoped(a, async () => {
  const current = await plans.getPlan();
  const duplicate = requestFor(current);
  duplicate.brackets.push({ ...duplicate.brackets[0], id: undefined });
  await assert.rejects(plans.updatePlan(duplicate), error => error.getResponse().code === 'DUPLICATE_PRICE_BRACKET');
  const unknown = requestFor(current);
  unknown.brackets.push(bracket(100, { vehicleType: 'UNKNOWN' }));
  await assert.rejects(plans.updatePlan(unknown), /no existe/);
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const metatype = load('tickets/dto/tariff-plan.dto', 'UpdateTariffPlanDto');
  for (const mutate of [
    draft => { draft.schedule.barcodeTicketsEnabled = false; },
    draft => { draft.schedule.receiptDelivery = {}; },
    draft => { draft.brackets[0].playaId = b.playaId; },
    draft => { draft.brackets[0].price = -1; },
    draft => { draft.schedule.dayStartHour = 24; },
    draft => { draft.brackets[0].price = 2147483648; },
  ]) {
    const draft = requestFor(current); mutate(draft);
    await assert.rejects(pipe.transform(draft, { type: 'body', metatype }), error => error.getStatus() === 400);
  }
  assert.deepEqual(await plans.getPlan(), current);
}));

test('las rutas estáticas nuevas quedan antes de :id y son sólo para administradores', () => {
  const controller = load('tickets/tickets.controller', 'TicketsController');
  const names = Object.getOwnPropertyNames(controller.prototype);
  const allowed = load('tenancy/endpoint-policy', 'OPERATOR_ENDPOINTS').TicketsController;
  for (const handler of ['getTariffPlan', 'updateTariffPlan', 'simulateTariffPlan']) {
    assert.ok(names.indexOf(handler) < names.indexOf('update'));
    assert.ok(!allowed.includes(handler));
    assert.match(Reflect.getMetadata('path', controller.prototype[handler]), /^tariff-plan/);
  }
});
