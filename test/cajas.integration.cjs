// Ejecutar después de pnpm build. PostgreSQL efímero: nunca lee .env ni usa la base del proyecto.
const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
require('reflect-metadata');
require('tsconfig-paths').register({ baseUrl: path.resolve('dist'), paths: { 'src/*': ['*'] } });
const { DataSource } = require('typeorm');
const dayjs = require('dayjs');
const load = (p, name) => require('../dist/' + p)[name];
const Ticket = load('tickets/entities/ticket.entity', 'Ticket');
const TicketPrice = load('tickets/entities/ticket-price.entity', 'TicketPrice');
const Bracket = load('tickets/entities/ticket-price-bracket.entity', 'TicketPriceBracket');
const Registration = load('tickets/entities/ticket-registration.entity', 'TicketRegistration');
const RegistrationDay = load('tickets/entities/ticket-registration-for-day.entity', 'TicketRegistrationForDay');
const Schedule = load('tickets/entities/ticket-schedule-settings.entity', 'TicketScheduleSettings');
const Movimiento = load('movimientos/entities/movimiento.entity', 'Movimiento');
const Turno = load('turnos/entities/turno.entity', 'Turno');
const Box = load('box-lists/entities/box-list.entity', 'BoxList');
const Other = load('box-lists/entities/other-payment.entity', 'OtherPayment');
const User = load('users/entities/user.entity', 'User');
const TicketsService = load('tickets/tickets.service', 'TicketsService');
const TurnosService = load('turnos/turnos.service', 'TurnosService');
const MovimientosService = load('movimientos/movimientos.service', 'MovimientosService');
const BoxListsService = load('box-lists/box-lists.service', 'BoxListsService');
const ScannerService = load('scanner/scanner.service', 'ScannerService');
const { tenantContext } = require('../dist/tenancy/tenant-context');
function test(name, options, fn) {
  if (typeof options === 'function') { fn = options; options = {}; }
  return nodeTest(name, options, (...args) => tenantContext.run({ userId: user.id, role: 'ADMIN' }, () => fn(...args)));
}
let ds, root, pgStarted = false, tickets, movements, shifts, boxes, user, scanner;
let counter = 0;
const bin = process.env.PG_TEST_BIN || 'C:/Program Files/PostgreSQL/18/bin';
const pg = (name, args) => {
  // PostgreSQL hereda stdout en Windows; un pipe mantendría spawnSync esperando aunque pg_ctl termine.
  const output = fs.openSync(path.join(root, 'commands.log'), 'a');
  try { return execFileSync(path.join(bin, name + (process.platform === 'win32' ? '.exe' : '')), args, { windowsHide: true, stdio: ['ignore', output, output], timeout: 30000 }); }
  finally { fs.closeSync(output); }
};
const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-pg-test-'));
  pg('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--locale=C']);
  const port = await freePort();
  pgStarted = true;
  pg('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'postgres.log'), '-o', '-h 127.0.0.1 -p ' + port + ' -F', '-w', 'start']);
  pgStarted = true;
  ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: 'postgres', entities: [path.resolve('dist/**/*.entity.js')], migrations: [load('database/migrations/1790000000000-flexible-vehicle-types', 'FlexibleVehicleTypes1790000000000')], migrationsRun: true, synchronize: true });
  await ds.initialize();
  const repo = entity => ds.getRepository(entity);
  shifts = new TurnosService(repo(Turno), repo(Movimiento), ds);
  movements = new MovimientosService(repo(Movimiento), shifts);
  boxes = new BoxListsService(repo(Box), repo(Other), ds);
  tickets = new TicketsService(repo(Ticket), repo(TicketPrice), repo(Bracket), repo(Registration), repo(RegistrationDay), repo(Schedule), boxes, { emitNewRegistration() {} }, movements, ds);
  scanner = new ScannerService(tickets, { getBarcodeReceipt: async () => null }, ds);
  user = await repo(User).save(repo(User).create({ username: 'test', firstName: 'Test', lastName: 'Operator', email: 'test@example.test', role: 'ADMIN' }));
  await tickets.updateSchedule({ dayStartHour: 8, dayEndHour: 20, graceMinutes: 5, pricingDayTypeBasis: 'ENTRY', barcodeTicketsEnabled: true, shiftsEnabled: true, multipleShiftsEnabled: false });
  await tickets.createPriceBracket({ vehicleType: 'AUTO', label: 'Hora', uptoMinutes: 60, price: 1000 });
  await tickets.createPriceBracket({ vehicleType: 'AUTO', label: 'Extra', price: 1000, recurringUnitMinutes: 60, recurringPriceMode: 'FIXED' });
});

after(async () => {
  if (ds?.isInitialized) await ds.destroy();
  if (pgStarted && fs.existsSync(path.join(root, 'data', 'postmaster.pid'))) pg('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'immediate', '-w', 'stop']);
  if (root) {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('tickets-pg-test-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

async function age(registration, minutes = 30) {
  const entry = dayjs().tz('America/Argentina/Buenos_Aires').subtract(minutes, 'minute');
  await ds.getRepository(Registration).update(registration.id, { entryDay: entry.format('YYYY-MM-DD'), entryTime: entry.format('HH:mm:ss') });
  return registration;
}
async function openPlate() { return age(await tickets.createRegistrationByPlate({ vehicleType: 'AUTO', licensePlate: 'TEST' + (++counter) })); }
async function payload(id, extra = {}) {
  const summary = await tickets.getCloseSummary(id);
  return { closeType: 'PAYMENT', metodo: 'CASH', expectedPrice: summary.previewBracket.price, expectedCollected: summary.totalCollectedSoFar, ...extra };
}
async function totalBox() { return Number((await ds.getRepository(Box).createQueryBuilder('b').select('COALESCE(SUM(b.totalPrice),0)', 'sum').getRawOne()).sum); }


const Session = load('turnos/entities/cash-session.entity', 'CashSession');
const Register = load('turnos/entities/cash-register.entity', 'CashRegister');
const CashEntry = load('turnos/entities/cash-entry.entity', 'CashEntry');
let second, third;
async function context(id = user.id) { return shifts.getCashContext(id); }
async function principal() { return (await context()).cajas.find(c => c.principal); }
async function openCash(id, received, caja) {
  caja ??= await principal();
  return shifts.open(id, { cajaId: caja.id, fondoInicial: caja.session ? 0 : received, cambioAgregado: caja.session ? 0 : Math.max(0, received - caja.efectivoDisponible), sesionActivaId: caja.session?.id, sesionAnteriorId: caja.pending?.id, turnoAnteriorId: caja.legacyPending?.id });
}
async function closeCash(id, retained = 0) {
  const ctx = await context(id);
  return shifts.close(ctx.active.id, id, { cerrarCaja: true, efectivoEsperado: ctx.efectivoDisponible, efectivoContado: ctx.efectivoDisponible, efectivoParaSiguiente: retained });
}
async function cash(id, amount) { await ds.transaction(m => boxes.applyTicketPayment('2026-10-05', amount, m, undefined, id)); }

test('una caja: el fondo sigue al último cierre aunque cambie el usuario', async () => {
  second = await ds.getRepository(User).save({ username: 'second', firstName: 'Second', lastName: 'Operator', email: 'second@test.local', role: 'USER' });
  third = await ds.getRepository(User).save({ username: 'third', firstName: 'Third', lastName: 'Operator', email: 'third@test.local', role: 'USER' });
  const a = await openCash(user.id, 20000);
  assert.equal(a.nombre, 'Test Operator');
  await assert.rejects(openCash(second.id, 0), /turno abierto/);
  await closeCash(user.id, 20000);
  const b = await openCash(second.id, 20000);
  await cash(second.id, 20000);
  await closeCash(second.id, 40000);
  const back = await openCash(user.id, 40000);
  assert.equal(back.fondoRecibido, 40000);
  assert.equal((await context()).efectivoDisponible, 40000);
  assert.equal(await totalBox(), 20000);
  await closeCash(user.id, 40000);
  assert.notEqual(a.id, back.id);
  assert.notEqual(b.usuarioApertura.id, user.id);
});

test('apertura: admite menos efectivo con motivo y conserva el cierre anterior', async () => {
  const caja = await principal();
  await assert.rejects(shifts.open(user.id, { cajaId: caja.id, fondoInicial: 39000, sesionAnteriorId: caja.pending.id }), /diferencia/);
  await shifts.open(user.id, { cajaId: caja.id, fondoInicial: 39000, sesionAnteriorId: caja.pending.id, motivoApertura: 'Al recibir faltaban 1000' });
  const session = (await principal()).session;
  assert.equal(session.diferenciaApertura, 1000);
  assert.equal(session.fondoInicial, 39000);
  assert.equal((await ds.getRepository(Session).findOneBy({ id: caja.pending.id })).efectivoParaSiguiente, 40000);
  await closeCash(user.id);
});

test('configuración: no cambia el modo mientras haya turnos abiertos', async () => {
  await openCash(user.id, 0);
  await assert.rejects(tickets.updateSchedule({ multipleShiftsEnabled: true }), /Cerrá todos/);
  await closeCash(user.id);
  await tickets.updateSchedule({ multipleShiftsEnabled: true });
  assert.equal((await context()).multipleShiftsEnabled, true);
});

test('misma caja: dos usuarios, fondo único, operaciones propias y arqueo del último', async () => {
  const a = await openCash(user.id, 2000);
  const caja = await principal();
  await assert.rejects(shifts.open(second.id, { cajaId: caja.id, fondoInicial: 2000, sesionActivaId: caja.session.id }), /No lo cargues/);
  const results = await Promise.allSettled([1,2].map(() => openCash(second.id, 0, caja)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const b = results.find(r => r.status === 'fulfilled').value;
  assert.equal(b.fondoInicial, 0);
  assert.equal(b.cashSessionId, a.cashSessionId);
  await Promise.all([cash(user.id, 5000), cash(second.id, 7000)]);
  const current = await context();
  assert.equal(current.cajas[0].efectivoDisponible, 14000);
  assert.equal(current.active.efectivoOperado, 5000);
  assert.equal((await context(second.id)).active.efectivoOperado, 7000);
  await assert.rejects(shifts.close(a.id, third.id, { cerrarCaja: false }, 'USER'), /responsable/);
  await assert.rejects(shifts.close(a.id, third.id, { cerrarCaja: false }, 'ADMIN'), /por qué/);
  const individual = await shifts.close(a.id, user.id, { cerrarCaja: false });
  assert.equal(individual.cierreCaja, false);
  assert.equal(individual.efectivoContado, null);
  assert.equal((await principal()).session.estado, 'ABIERTO');
  await assert.rejects(shifts.close(b.id, second.id, { cerrarCaja: false }), /último operador/);
  await closeCash(second.id, 2000);
  assert.equal((await principal()).efectivoDisponible, 2000);
});

test('cajas separadas: los cobros y retiros quedan en su caja y no duplican ventas', async () => {
  const lateral = await shifts.saveCaja({ nombre: 'Entrada lateral' });
  const a = await openCash(user.id, 2000);
  const b = await openCash(second.id, 3000, (await context()).cajas.find(c => c.id === lateral.id));
  await Promise.all([cash(user.id, 1000), cash(second.id, 5000)]);
  assert.equal((await context(user.id)).efectivoDisponible, 3000);
  assert.equal((await context(second.id)).efectivoDisponible, 8000);
  const before = await totalBox();
  await assert.rejects(shifts.addCashMovement(a.cashSessionId, second.id, { tipo: 'RETIRO', importe: 500, efectivoEsperado: 3000, motivo: 'Retiro' }, 'USER'), /Sólo podés/);
  await shifts.addCashMovement(b.cashSessionId, second.id, { tipo: 'RETIRO', importe: 1000, efectivoEsperado: 8000, motivo: 'Entrega al encargado' }, 'USER');
  assert.equal((await context(second.id)).efectivoDisponible, 7000);
  await shifts.addCashMovement(b.cashSessionId, user.id, { tipo: 'APORTE', importe: 500, efectivoEsperado: 7000, motivo: 'Cambio extra' }, 'ADMIN');
  assert.equal((await context(second.id)).efectivoDisponible, 7500);
  assert.equal(await totalBox(), before);
  await assert.rejects(shifts.addCashMovement(b.cashSessionId, user.id, { tipo: 'RETIRO', importe: 50, efectivoEsperado: 7000, motivo: 'Desactualizado' }, 'ADMIN'), /cambió/);
  await assert.rejects(shifts.saveCaja({ nombre: 'Entrada lateral', activa: false }, lateral.id), /Cerrá la caja/);
  const physical = (await context()).cajas.filter(c => c.session).reduce((total,c) => total+c.efectivoDisponible,0);
  assert.equal(physical, 10500);
  await closeCash(user.id);
  await closeCash(second.id);
  await shifts.saveCaja({ nombre: 'Entrada lateral', activa: false }, lateral.id);
});

test('operadores: ven su turno sin acceso a los cierres administrativos', async () => {
  await openCash(user.id, 0);
  await tenantContext.run({ userId: user.id, role: 'USER' }, async () => {
    const ctx = await shifts.getCashContext();
    assert.equal(ctx.active.usuarioApertura.id, user.id);
    assert.deepEqual(ctx.openTurnos, []);
  });
  await closeCash(user.id);
  await tickets.updateSchedule({ shiftsEnabled: false });
  assert.equal((await tickets.getSchedule()).multipleShiftsEnabled, false);
  await assert.rejects(tickets.updateSchedule({ multipleShiftsEnabled: true }), /Activá Turnos/);
});

test('migración: agrega tablas y modo sin recalcular cierres, y puede repetirse', async () => {
  const migration = new (load('database/migrations/1790000028000-cajas-compartidas', 'CajasCompartidas1790000028000'))();
  const before = await ds.getRepository(Turno).find({ where: { estado: 'CERRADO' } });
  const runner = ds.createQueryRunner();
  try { await migration.up(runner); await migration.up(runner); } finally { await runner.release(); }
  const after = await ds.getRepository(Turno).find({ where: { estado: 'CERRADO' } });
  assert.deepEqual(after, before);
});
