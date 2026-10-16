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
  await assert.rejects(shifts.addCashMovement(a.cashSessionId, second.id, { tipo: 'RETIRO', importe: 500, efectivoEsperado: 3000, motivo: 'Retiro' }, 'USER'), /Sólo el administrador/);
  await assert.rejects(shifts.addCashMovement(b.cashSessionId, second.id, { tipo: 'RETIRO', importe: 1000, efectivoEsperado: 8000, motivo: 'Entrega al encargado' }, 'USER'), /Sólo el administrador/);
  await shifts.addCashMovement(b.cashSessionId, user.id, { tipo: 'RETIRO', importe: 1000, efectivoEsperado: 8000, motivo: 'Entrega al encargado' }, 'ADMIN');
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

const book = () => require('../dist/turnos/turno-book');
const SessionMovement = load('turnos/entities/cash-session-movement.entity', 'CashSessionMovement');

test('sueldos individuales: importes distintos, usuario sin retiro y jornadas congeladas', async () => {
  await tickets.updateSchedule({ shiftsEnabled: true, multipleShiftsEnabled: true, sueldoAutomatico: true,
    sueldosPorUsuario: [{ usuarioId: user.id, importe: 10000 }, { usuarioId: second.id, importe: 20000 }] });
  await assert.rejects(tickets.updateSchedule({ sueldosPorUsuario: [{ usuarioId: '00000000-0000-4000-8000-000000000001', importe: 1 }] }), /usuarios habilitados/);
  const ownSettings = await tenantContext.run({ userId: second.id, role: 'USER' }, () => tickets.getSchedule());
  assert.deepEqual(ownSettings.sueldosPorUsuario, [{ usuarioId: second.id, importe: 20000 }]);
  const a = await openCash(user.id, (await principal()).efectivoDisponible);
  const b = await openCash(second.id, 0);
  const c = await openCash(third.id, 0);
  assert.deepEqual([a.sueldoPrevisto, b.sueldoPrevisto, c.sueldoPrevisto], [10000, 20000, 0]);
  await cash(user.id, 100000);
  await tickets.updateSchedule({ sueldosPorUsuario: [] });
  const balance = (await context()).efectivoDisponible;
  const closedA = await shifts.close(a.id, user.id, { cerrarCaja: false, efectivoEsperado: balance, sueldoEsperado: 10000 });
  const closedB = await shifts.close(b.id, second.id, { cerrarCaja: false, efectivoEsperado: balance - 10000, sueldoEsperado: 20000 });
  const closedC = await closeCash(third.id, 15000);
  assert.deepEqual([closedA.sueldoRetirado, closedB.sueldoRetirado, closedC.sueldoRetirado], [10000, 20000, 0]);
  assert.equal(closedC.alertaSueldo, null);
  assert.equal(await ds.getRepository(SessionMovement).count({ where: { turnoId: c.id, tipo: 'SUELDO' } }), 0);
  const next = await openCash(user.id, 15000);
  assert.equal(next.sueldoPrevisto, 0);
  await closeCash(user.id, 15000);
});

test('sueldos: migración conserva importes, limita usuarios por empresa/playa y no pisa cambios', async () => {
  const runner = ds.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    const m = runner.manager;
    const Empresa = load('tenancy/entities/empresa.entity', 'Empresa');
    const Playa = load('tenancy/entities/playa.entity', 'Playa');
    const UsuarioPlaya = load('tenancy/entities/usuario-playa.entity', 'UsuarioPlaya');
    const empresa = await m.getRepository(Empresa).save({ nombre: 'Sueldos' });
    const ajena = await m.getRepository(Empresa).save({ nombre: 'Ajena' });
    const playa = await m.getRepository(Playa).save({ nombre: 'Sueldos', empresaId: empresa.id });
    await m.getRepository(User).update(user.id, { empresaId: empresa.id });
    await m.getRepository(User).update(second.id, { empresaId: empresa.id });
    await m.getRepository(User).update(third.id, { empresaId: ajena.id });
    await m.getRepository(UsuarioPlaya).save({ usuarioId: second.id, playaId: playa.id });
    const settings = await m.getRepository(Schedule).save({ playaId: playa.id, dayStartHour: 8, dayEndHour: 20, graceMinutes: 5, sueldoAutomatico: true, sueldoPorTurno: 25000 });
    await runner.query('ALTER TABLE ticket_schedule_settings DROP COLUMN "sueldosPorUsuario"');
    const migration = new (load('database/migrations/1790000041000-sueldos-por-usuario', 'SueldosPorUsuario1790000041000'))();
    await migration.up(runner);
    const migrated = await m.getRepository(Schedule).findOneByOrFail({ id: settings.id });
    assert.deepEqual(migrated.sueldosPorUsuario.map(s => s.usuarioId).sort(), [user.id, second.id].sort());
    assert.ok(migrated.sueldosPorUsuario.every(s => s.importe === 25000));
    const scope = { userId: user.id, role: 'ADMIN', empresaId: empresa.id, playaId: playa.id };
    const { usuariosConSueldoConfigurable } = require('../dist/turnos/sueldos');
    const allowed = await tenantContext.run(scope, () => usuariosConSueldoConfigurable(m));
    assert.deepEqual(allowed.map(u => u.id).sort(), [user.id, second.id].sort());
    await m.getRepository(UsuarioPlaya).delete({ usuarioId: second.id, playaId: playa.id });
    const reassigned = await tenantContext.run(scope, () => usuariosConSueldoConfigurable(m));
    assert.deepEqual(reassigned.map(u => u.id), [user.id]);
    await m.getRepository(Schedule).update(settings.id, { sueldosPorUsuario: [] });
    await migration.up(runner);
    assert.deepEqual((await m.getRepository(Schedule).findOneByOrFail({ id: settings.id })).sueldosPorUsuario, []);
  } finally { await runner.rollbackTransaction(); await runner.release(); }
});

test('sueldo: protege el fondo, resta una sola vez y separa gastos del retiro final', async () => {
  await tickets.updateSchedule({ shiftsEnabled: true, sueldoAutomatico: true, sueldosPorUsuario: [{ usuarioId: user.id, importe: 25000 }, { usuarioId: second.id, importe: 25000 }] });
  const register = await principal();
  await shifts.saveCaja({ nombre: register.nombre, fondoObjetivo: 15000 }, register.id);
  const t = await openCash(user.id, 15000);
  await cash(user.id, 100000);
  const expense = await boxes.createOtherPayment({ description: 'Gasto', price: 10000, type: 'EGRESOS', paymentMethod: 'CASH' });
  assert.equal((await context()).efectivoDisponible, 105000);
  const closed = await shifts.close(t.id, user.id, { efectivoContado: 105000, efectivoEsperado: 105000, efectivoParaSiguiente: 15000, sueldoEsperado: 25000 });
  assert.equal(closed.sueldoRetirado, 25000);
  assert.equal(closed.diferencia, 0);
  assert.equal(closed.efectivoRetirado, 90000);
  const summary = await book().shiftSummary(ds.manager, closed);
  assert.equal(summary.gastosEfectivo, 10000);
  assert.equal(summary.retirosRecaudacion, 65000);
  assert.equal(summary.totalRetirado, 100000);
  // El fondo recibido se conserva: no se resta dos veces ni cuenta como retiro.
  assert.equal(t.fondoInicial + summary.efectivoCobrado, summary.totalRetirado + closed.efectivoParaSiguiente);
  assert.equal(await ds.getRepository(SessionMovement).count({ where: { turnoId: t.id, tipo: 'SUELDO' } }), 1);
  await assert.rejects(shifts.close(t.id, user.id, { efectivoContado: 105000, sueldoEsperado: 25000 }), /cerrado/);
  assert.equal((await principal()).efectivoDisponible, 15000);
});

test('sueldo insuficiente: no descuenta ni paga parcialmente y persiste la alerta', async () => {
  const t = await openCash(user.id, 15000);
  await cash(user.id, 8000);
  await assert.rejects(shifts.close(t.id, user.id, { efectivoContado: 23000, efectivoEsperado: 23000, efectivoParaSiguiente: 15000, sueldoEsperado: 25000 }), /sueldo actualizado/);
  const closed = await shifts.close(t.id, user.id, { efectivoContado: 23000, efectivoEsperado: 23000, efectivoParaSiguiente: 15000, sueldoEsperado: 0 });
  assert.equal(closed.sueldoRetirado, 0);
  assert.match(closed.alertaSueldo, /no alcanza/);
  assert.equal(await ds.getRepository(SessionMovement).count({ where: { turnoId: t.id } }), 0);
});

test('medianoche: corta una vez, conserva caja y jornada y no retira sueldo', async () => {
  const t = await openCash(user.id, 15000);
  const today = dayjs().tz('America/Argentina/Buenos_Aires').startOf('day');
  const yesterday = today.subtract(1, 'day');
  const opened = yesterday.add(20, 'hour').toDate();
  await ds.getRepository(Turno).update(t.id, { fechaApertura: opened, fechaOperativa: yesterday.format('YYYY-MM-DD') });
  await ds.getRepository(Session).update(t.cashSessionId, { fechaApertura: opened });
  await Promise.all([ds.transaction(m => book().rolloverShifts(m)), ds.transaction(m => book().rolloverShifts(m))]);
  const old = await ds.getRepository(Turno).findOneBy({ id: t.id });
  const next = (await context()).active;
  assert.equal(old.fechaCierre.toISOString(), today.toDate().toISOString());
  assert.equal(old.cierreAutomatico, true);
  assert.equal(old.efectivoContado, null);
  assert.equal(old.sueldoRetirado, 0);
  assert.equal(next.continuacionDeId, t.id);
  assert.equal(next.jornadaId, t.id);
  assert.equal(next.cashSessionId, t.cashSessionId);
  assert.equal(next.fondoInicial, 0);
  assert.equal(next.efectivoDisponible, 15000);
  assert.equal(await ds.getRepository(Turno).count({ where: { continuacionDeId: t.id } }), 1);
  // El historial ubica el corte en el día que terminó, no en la planilla nueva.
  const history = await shifts.findAll({ desde: yesterday.format('YYYY-MM-DD'), hasta: yesterday.format('YYYY-MM-DD'), fechaPor: 'CIERRE', estado: 'CERRADO' });
  assert.ok(history.data.some(r => r.id === t.id));
  const previousSegment = await ds.transaction(m => book().offlineShift(m, t.id, user.id, yesterday.add(23, 'hour').toDate()));
  assert.equal(previousSegment.id, t.id);
  const currentSegment = await ds.transaction(m => book().offlineShift(m, t.id, user.id, new Date()));
  assert.equal(currentSegment.id, next.id);
  await cash(user.id, 40000);
  const closed = await shifts.close(next.id, user.id, { efectivoContado: 55000, efectivoEsperado: 55000, efectivoParaSiguiente: 15000, sueldoEsperado: 25000 });
  assert.equal(closed.sueldoRetirado, 25000);
  await assert.rejects(ds.transaction(m => book().offlineShift(m, t.id, user.id, opened)), /jornada ya terminó/);
});

test('resumen: lo devuelto en efectivo de un anticipo se descuenta de lo cobrado, no es un retiro', async () => {
  await tickets.updateSchedule({ sueldoAutomatico: false });
  const t = await openCash(user.id, 15000);
  const a = await openPlate();
  await tickets.addAdvancePayment(a.id, { advancePaidAmount: 3000, metodo: 'CASH' }, user.id);
  // Cuesta 1000: sobran 2000 del anticipo y se devuelven en efectivo al salir.
  await tickets.closeRegistrationByPlate(a.id, { closeType: 'NO_CHARGE', expectedPrice: 1000, expectedCollected: 3000, refundMetodo: 'CASH' }, user.id);
  // Se deja el mismo fondo para el siguiente: lo único retirado es la recaudación neta del turno.
  const closed = await shifts.close(t.id, user.id, { efectivoContado: 16000, efectivoEsperado: 16000, efectivoParaSiguiente: 15000 });
  const r = await book().shiftSummary(ds.manager, closed);
  assert.equal(r.efectivoCobrado, 1000);
  assert.equal(r.devolucionesEfectivo, 0);
  assert.equal(r.efectivoNeto, 1000);
  assert.equal(r.totalRetirado, 1000, 'la devolución no figura como retiro');
  assert.equal(t.fondoInicial + r.efectivoCobrado, r.totalRetirado + closed.efectivoParaSiguiente);
});

test('pago híbrido al salir: efectivo y transferencia, y solo el efectivo suma a la caja', async () => {
  await tickets.updateSchedule({ sueldoAutomatico: false });
  const t = await openCash(user.id, 15000);
  const a = await openPlate();
  try {
    const base = { closeType: 'PAYMENT', expectedPrice: 1000, expectedCollected: 0 };
    await assert.rejects(tickets.closeRegistrationByPlate(a.id, { ...base, pagos: [{ metodo: 'CASH', importe: 400 }, { metodo: 'TRANSFER', importe: 500 }] }, user.id), /tienen que sumar/);
    await assert.rejects(tickets.closeRegistrationByPlate(a.id, { ...base, pagos: [{ metodo: 'CASH', importe: 400 }, { metodo: 'CASH', importe: 600 }] }, user.id), /una sola vez/);
    await tickets.closeRegistrationByPlate(a.id, { ...base, pagos: [{ metodo: 'CASH', importe: 400 }, { metodo: 'TRANSFER', importe: 600 }] }, user.id);
    const movs = await ds.getRepository(Movimiento).find({ where: { ticketRegistration: { id: a.id } } });
    assert.deepEqual(movs.map(m => [m.tipo, m.metodo, m.monto]).sort(), [['SALDO', 'CASH', 400], ['SALDO', 'TRANSFER', 600]]);
    const r = await book().shiftSummary(ds.manager, t);
    assert.equal(r.efectivoCobrado, 400);
    assert.equal(r.transferencias, 600);
  } finally {
    await closeCash(user.id, 15000);
  }
});

test('al cerrar el turno se repasan las entradas que registró su operador y siguen abiertas', async () => {
  await tickets.updateSchedule({ sueldoAutomatico: false });
  const anterior = await openPlate(); // Entró antes de abrir el turno: no es de este turno.
  const t = await openCash(user.id, 15000);
  // Como en el mostrador: la entrada guarda quién la registró.
  const abierta = await tickets.createRegistrationByPlate({ vehicleType: 'AUTO', licensePlate: 'TURNO' + (++counter) }, user.id);
  const cerrada = await tickets.createRegistrationByPlate({ vehicleType: 'AUTO', licensePlate: 'TURNO' + (++counter) }, user.id);
  try {
    await tickets.closeRegistrationByPlate(cerrada.id, await payload(cerrada.id), user.id);
    const lista = await shifts.estadiasAbiertas(t.id, user.id, 'ADMIN');
    const ids = lista.map(e => e.id);    assert.ok(ids.includes(abierta.id), 'la que sigue abierta aparece');
    // Como texto, como en las entidades: un Date crudo rompía el cálculo de la hora en la pantalla.
    const fila = lista.find(e => e.id === abierta.id);
    assert.match(fila.entryDay, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(fila.entryTime, /^\d{2}:\d{2}:\d{2}$/);
    assert.ok(!ids.includes(cerrada.id), 'la que ya salió no');
    assert.ok(!ids.includes(anterior.id), 'la de antes de abrir el turno no');
    await assert.rejects(shifts.estadiasAbiertas(t.id, second.id, 'USER'), /responsable del turno/);
    // Quien cierra la caja ve todas las de la playa, también las de antes de su turno y de otros.
    const todas = await shifts.estadiasAbiertas(t.id, user.id, 'ADMIN', true);
    assert.ok(todas.some(e => e.id === anterior.id), 'la de antes del turno aparece al cerrar la caja');
    assert.ok(todas.some(e => e.id === abierta.id && e.operador === 'Test Operator'), 'con quién la registró');
  } finally {
    // Se deja la caja como la esperan las pruebas siguientes: sin estadías ni turno abiertos.
    await tickets.closeRegistrationByPlate(abierta.id, await payload(abierta.id), user.id);
    await tickets.closeRegistrationByPlate(anterior.id, await payload(anterior.id), user.id);
    const efectivo = (await shifts.getCashContext(user.id)).active.efectivoDisponible;
    await shifts.close(t.id, user.id, { efectivoContado: efectivo, efectivoEsperado: efectivo, efectivoParaSiguiente: 15000 });
  }
});

test('resumen: digitales sin efectivo, salida sin cobro y ocupación al cerrar', async () => {
  await tickets.updateSchedule({ sueldoAutomatico: false });
  const t = await openCash(user.id, 15000);
  const a = await openPlate();
  const b = await openPlate();
  await movements.create({ ticketRegistrationId: a.id, monto: 1000, metodo: 'TRANSFER', tipo: 'ANTICIPO', referencia: 'Transferencia MercadoPago prueba', usuarioId: user.id });
  await tickets.closeRegistrationByPlate(a.id, { closeType: 'NO_CHARGE', expectedPrice: 1000, expectedCollected: 1000 }, user.id);
  await ds.transaction(m => book().recordDigital(m, 2000, 'MERCADOPAGO', 'QR abono', user.id));
  await ds.transaction(m => book().recordDigital(m, 3000, 'TRANSFER', 'Transferencia', user.id));
  const closed = await shifts.close(t.id, user.id, { efectivoContado: 15000, efectivoEsperado: 15000, efectivoParaSiguiente: 15000 });
  const r = await book().shiftSummary(ds.manager, closed);
  assert.equal(r.efectivoCobrado, 0);
  assert.equal(r.mercadoPagoAlias, 1000);
  assert.equal(r.mercadoPagoQr, 2000);
  assert.equal(r.transferencias, 3000);
  assert.equal(r.salidas, 1);
  assert.equal(r.vehiculosFin, 1);
  const handover = (await principal()).traspaso;
  assert.equal(handover.operador, 'Test Operator');
  assert.equal(handover.vehiculosDejados, 1);
  assert.equal(handover.vehiculosActivos, 1);
  assert.equal(new Date(handover.fechaCierre).getTime(), closed.fechaCierre.getTime());
  const box = await boxes.findBoxByDate(dayjs().tz('America/Argentina/Buenos_Aires').format('YYYY-MM-DD'));
  assert.ok(box.turnosDelDia.some(row => row.turnoId === t.id && row.turno.resumen.transferencias === 3000));
});

test('migración diaria: repetible y conserva cierres existentes', async () => {
  const migration = new (load('database/migrations/1790000036000-turnos-diarios', 'TurnosDiarios1790000036000'))();
  const before = await ds.getRepository(Turno).find({ order: { id: 'ASC' } });
  const runner = ds.createQueryRunner();
  try { await migration.up(runner); await migration.up(runner); } finally { await runner.release(); }
  assert.deepEqual(await ds.getRepository(Turno).find({ order: { id: 'ASC' } }), before);
});


test('caja compartida: el primer sueldo reduce el saldo y el segundo no consume el fondo', async () => {
  await tickets.updateSchedule({ multipleShiftsEnabled: true, sueldoAutomatico: true, sueldosPorUsuario: [{ usuarioId: user.id, importe: 25000 }, { usuarioId: second.id, importe: 25000 }] });
  const a = await openCash(user.id, 15000);
  const b = await openCash(second.id, 0);
  await cash(user.id, 25000);
  await shifts.close(a.id, user.id, { cerrarCaja: false, efectivoEsperado: 40000, sueldoEsperado: 25000 });
  assert.equal((await context(second.id)).efectivoDisponible, 15000);
  const closed = await shifts.close(b.id, second.id, { cerrarCaja: true, efectivoContado: 15000, efectivoEsperado: 15000, efectivoParaSiguiente: 15000, sueldoEsperado: 0 });
  assert.equal(closed.sueldoRetirado, 0);
  assert.match(closed.alertaSueldo, /no alcanza/);
  assert.equal(closed.diferencia, 0);
  await tickets.updateSchedule({ sueldoAutomatico: false });
});

test('corrección de varios conserva el gasto neto y no fabrica ingresos', async () => {
  const t = await openCash(user.id, 15000);
  const expense = await boxes.createOtherPayment({ description: 'Gasto corregido', price: 1000, type: 'EGRESOS', paymentMethod: 'CASH' });
  await boxes.updateOtherPayment(expense.id, { price: 400 });
  const r = await book().shiftSummary(ds.manager, t);
  assert.equal(r.gastosEfectivo, 400);
  assert.equal(r.ingresosVarios, 0);
  assert.equal((await context()).efectivoDisponible, 14600);
  await closeCash(user.id, 14600);
});

test('acreditación tardía: conserva el turno que inició el pago aunque haya otro abierto', async () => {
  const previous = await openCash(user.id, 15000);
  // Una fecha dentro de este turno, sin superponer artificialmente los anteriores.
  const paymentTime = new Date();
  await closeCash(user.id, 15000);
  const current = await openCash(user.id, 15000);
  await book().externalPayment.run({ userId: user.id, at: paymentTime, medio: 'ALIAS' }, () => ds.transaction(m => book().recordDigital(m, 3000, 'TRANSFER', 'Alias confirmado tarde', user.id)));
  assert.equal((await book().shiftSummary(ds.manager, previous)).mercadoPagoAlias, 3000);
  assert.equal((await book().shiftSummary(ds.manager, current)).mercadoPagoAlias, 0);
  await closeCash(user.id, 15000);
});


test('sin conexión: completa el corte con la fecha real y conserva el arqueo posterior', async () => {
  const t = await openCash(user.id, 15000);
  const today = dayjs().tz('America/Argentina/Buenos_Aires').startOf('day');
  const yesterday = today.subtract(1, 'day');
  await ds.getRepository(Turno).update(t.id, { fechaApertura: yesterday.add(20, 'hour').toDate(), fechaOperativa: yesterday.format('YYYY-MM-DD') });
  const r = await ds.getRepository(Registration).save({ description: 'Offline previo al corte', vehicleType: 'AUTO', price: 0,
    entryDay: yesterday.format('YYYY-MM-DD'), entryTime: '21:00:00' });
  const next = (await context()).active;
  const before = await ds.getRepository(Turno).findOneBy({ id: t.id });
  const at = yesterday.add(23, 'hour').toDate();
  await ds.transaction(async m => {
    const segment = await book().offlineShift(m, t.id, user.id, at);
    await boxes.applyTicketPayment(yesterday.format('YYYY-MM-DD'), 1000, m, segment.id, user.id, 'COBRO', at);
    await movements.create({ ticketRegistrationId: r.id, usuarioId: user.id, monto: 1000, metodo: 'CASH', tipo: 'SALDO' }, m, segment.id, at);
    await m.getRepository(Registration).update(r.id, { departureDay: yesterday.format('YYYY-MM-DD'), departureTime: '23:00:00', exitTurnoId: segment.id });
    await book().refreshAutomaticCuts(m, at);
  });
  const old = await ds.getRepository(Turno).findOneBy({ id: t.id });
  assert.equal(old.saldoAlCorte, 16000);
  assert.equal(old.vehiculosFin, before.vehiculosFin - 1);
  assert.equal(old.salidasRegistradas, 1);
  const successor = await ds.getRepository(Turno).findOneBy({ id: next.id });
  assert.equal(successor.vehiculosInicio, old.vehiculosFin);
  assert.equal(successor.saldoAlCorte, 16000);
  assert.equal((await book().shiftSummary(ds.manager, old)).salidas, 1);
  const closed = await closeCash(user.id, 15000);
  const frozen = await ds.getRepository(Turno).findOneBy({ id: closed.id });
  await ds.transaction(m => book().refreshAutomaticCuts(m, at));
  assert.deepEqual(await ds.getRepository(Turno).findOneBy({ id: closed.id }), frozen);
});

test('abono digital: al eliminarlo registra la reversión en el turno', async () => {
  const t = await openCash(user.id, 15000);
  await ds.getRepository(TicketPrice).save({ ticketTimeType: 'DIA', vehicleType: 'AUTO', ticketTimePrice: 2000 });
  const pass = await tickets.createRegistrationForDay({ ticketTimeType: 'DIA', vehicleType: 'AUTO', days: 1, paid: true, paymentMetodo: 'TRANSFER' }, user.id);
  assert.equal((await book().shiftSummary(ds.manager, t)).transferencias, 2000);
  await tickets.removeRegistrationForDay(pass.id);
  assert.equal((await book().shiftSummary(ds.manager, t)).transferencias, 0);
  await closeCash(user.id, 15000);
});


test('varios: un gasto cargado por quien no tiene turno queda en el turno abierto de la caja', async () => {
  // El operador trabaja; el administrador (este contexto, sin turno propio) carga un gasto desde Caja.
  const t = await openCash(second.id, 15000);
  try {
    const gasto = await boxes.createOtherPayment({ description: 'Gasto del admin', price: 1000, type: 'EGRESOS', paymentMethod: 'CASH' });
    const filas = await ds.query(`SELECT amount, categoria FROM cash_entries WHERE "turnoId" = $1 AND categoria = 'GASTO'`, [t.id]);
    assert.deepEqual(filas.map(f => [Number(f.amount), f.categoria]), [[-1000, 'GASTO']], 'el gasto queda en el turno del operador');
    assert.equal((await context(second.id)).active.efectivoDisponible, 14000, 'y su arqueo lo descuenta');
    await boxes.updateOtherPayment(gasto.id, { price: 500 });
    assert.equal((await context(second.id)).active.efectivoDisponible, 14500);
    await boxes.removeOtherPayment(gasto.id);
    assert.equal((await context(second.id)).active.efectivoDisponible, 15000);
  } finally {
    await closeCash(second.id, 15000);
  }
});

test('varios: elimina gastos sin inventar cobros y conserva las transferencias netas', async () => {
  const t = await openCash(user.id, 15000);
  const expense = await boxes.createOtherPayment({ description: 'Gasto eliminado', price: 1000, type: 'EGRESOS', paymentMethod: 'CASH' });
  await boxes.removeOtherPayment(expense.id);
  let r = await book().shiftSummary(ds.manager, t);
  assert.equal(r.gastosEfectivo, 0);
  assert.equal(r.efectivoCobrado, 0);
  const income = await boxes.createOtherPayment({ description: 'Ingreso digital', price: 3000, type: 'INGRESOS', paymentMethod: 'TRANSFER' });
  assert.equal((await book().shiftSummary(ds.manager, t)).transferencias, 3000);
  await boxes.updateOtherPayment(income.id, { price: 2000 });
  assert.equal((await book().shiftSummary(ds.manager, t)).transferencias, 2000);
  await boxes.removeOtherPayment(income.id);
  assert.equal((await book().shiftSummary(ds.manager, t)).transferencias, 0);
  assert.equal((await context()).efectivoDisponible, 15000);
  const pass = await tickets.createRegistrationForDay({ ticketTimeType: 'DIA', vehicleType: 'AUTO', days: 1, paid: false }, user.id);
  await ds.transaction(m => tickets.acreditarTransferenciaAbonoEn(m, pass.id, pass.price, 'Alias original', user.id, false));
  assert.equal((await book().shiftSummary(ds.manager, t)).mercadoPagoAlias, pass.price);
  await tickets.removeRegistrationForDay(pass.id);
  r = await book().shiftSummary(ds.manager, t);
  assert.equal(r.mercadoPagoAlias, 0);
  assert.equal(r.transferencias, 0);
  await closeCash(user.id, 15000);
});


test('migración correctiva: completa una versión diaria registrada sin perder turnos', async () => {
  const before = await ds.getRepository(Turno).find({ order: { id: 'ASC' } });
  const runner = ds.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    // Simula la versión inicial ya registrada: no tenía este campo ni las referencias.
    await runner.query('ALTER TABLE turnos DROP COLUMN "salidasRegistradas"');
    await runner.query('ALTER TABLE turno_payments DROP CONSTRAINT "daily_turno_payments_turnoId"');
    const migration = new (load('database/migrations/1790000037000-completar-turnos-diarios', 'CompletarTurnosDiarios1790000037000'))();
    await migration.up(runner);
    await migration.up(runner);
    const after = await runner.manager.getRepository(Turno).find({ order: { id: 'ASC' } });
    assert.deepEqual(after.map(t => ({ ...t, salidasRegistradas: null })), before.map(t => ({ ...t, salidasRegistradas: null })));
    const [reference] = await runner.query("SELECT COUNT(*)::int AS total FROM pg_constraint WHERE conname='daily_turno_payments_turnoId'");
    assert.equal(reference.total, 1);
  } finally { await runner.rollbackTransaction(); await runner.release(); }
});

test('planilla: filtra por día argentino y ordena abiertos y últimos cierres primero', async () => {
  const runner = ds.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    const repo = runner.manager.getRepository(Turno);
    const save = (nombre, apertura, cierre, fechaOperativa = null) => repo.save(repo.create({
      nombre, fondoInicial: 0, cashVersion: 1, fechaOperativa,
      fechaApertura: new Date(apertura), fechaCierre: cierre ? new Date(cierre) : null,
      estado: cierre ? 'CERRADO' : 'ABIERTO',
    }));
    const previous = await save('Anterior', '2021-07-18T02:59:59Z', '2021-07-18T12:00:00Z');
    const midnight = await save('Inicio del día', '2021-07-18T03:00:00Z', '2021-07-18T10:00:00Z');
    const lastManual = await save('Último cierre manual', '2021-07-18T11:00:00Z', '2021-07-18T14:00:00Z', '2021-07-18');
    const laterOpening = await save('Abrió después, cerró antes', '2021-07-18T12:00:00Z', '2021-07-18T13:00:00Z', '2021-07-18');
    const cut = await save('Corte de medianoche', '2021-07-19T02:00:00Z', '2021-07-19T03:00:00Z', '2021-07-18');
    const open = await save('Abierto del día', '2021-07-18T15:00:00Z', null, '2021-07-18');
    const next = await save('Día siguiente', '2021-07-19T03:00:00Z', '2021-07-19T04:00:00Z', '2021-07-19');
    const oldOpen = await save('Abierto de otra fecha', '2021-07-17T15:00:00Z', null);
    // La fecha operativa es la referencia del tramo, incluso si su apertura es distinta.
    const otherDay = await save('Otra fecha operativa', '2021-07-18T16:00:00Z', '2021-07-18T17:00:00Z', '2021-07-17');
    const selected = await boxes.findBoxByDate('2021-07-18', runner.manager);
    assert.deepEqual(selected.turnosDelDia.map(t => t.turnoId), [open.id, cut.id, lastManual.id, laterOpening.id, midnight.id]);
    assert.ok(!selected.turnosDelDia.some(t => [previous.id, next.id, oldOpen.id, otherDay.id].includes(t.turnoId)));
    const following = await boxes.findBoxByDate('2021-07-19', runner.manager);
    assert.deepEqual(following.turnosDelDia.map(t => t.turnoId), [next.id]);
    const onlyLegacy = await save('Histórico sin movimientos', '2021-07-15T15:00:00Z', '2021-07-15T16:00:00Z');
    const legacyDay = await boxes.findBoxByDate('2021-07-15', runner.manager);
    assert.equal(legacyDay.totalPrice, 0);
    assert.deepEqual(legacyDay.turnosDelDia.map(t => t.turnoId), [onlyLegacy.id]);

    // Aun compartiendo día, los turnos modernos e históricos quedan limitados al dueño.
    await repo.update([open.id, midnight.id], { usuarioAperturaId: second.id });
    await repo.update([cut.id, lastManual.id], { usuarioAperturaId: third.id });
    await runner.manager.getRepository(CashEntry).save({ boxId: selected.id, turnoId: null, amount: 100, description: 'Sin turno' });
    const own = await tenantContext.run({ userId: second.id, role: 'USER' }, () => boxes.findBoxByDate('2021-07-18', runner.manager));
    assert.deepEqual(own.turnosDelDia.map(t => t.turnoId), [open.id, midnight.id]);
    const other = await tenantContext.run({ userId: third.id, role: 'USER' }, () => boxes.findBoxByDate('2021-07-18', runner.manager));
    assert.deepEqual(other.turnosDelDia.map(t => t.turnoId), [cut.id, lastManual.id]);
    const empty = await tenantContext.run({ userId: user.id, role: 'USER' }, () => boxes.findBoxByDate('2021-07-18', runner.manager));
    assert.deepEqual(empty.turnosDelDia, []);
    const admin = await boxes.findBoxByDate('2021-07-18', runner.manager);
    assert.deepEqual(admin.turnosDelDia.map(t => t.turnoId), [open.id, cut.id, lastManual.id, laterOpening.id, midnight.id, null]);
  } finally { await runner.rollbackTransaction(); await runner.release(); }
});


test('avisos: cierre coincidente admite una nota y la migración recupera notas anteriores una sola vez', async () => {
  const Note = load('notes/entities/note.entity', 'Note');
  await tickets.updateSchedule({ sueldoAutomatico: false });
  const t = await openCash(user.id, (await principal()).efectivoDisponible);
  const ctx = await context();
  const closed = await shifts.close(t.id, user.id, { efectivoContado: ctx.efectivoDisponible, efectivoEsperado: ctx.efectivoDisponible, efectivoParaSiguiente: ctx.efectivoDisponible, observaciones: 'Revisar el vehículo azul en el próximo turno' });
  const note = await ds.getRepository(Note).findOne({ where: { sourceKey: `cierre:${closed.id}` }, relations: ['user'] });
  assert.equal(note.description, closed.observaciones);
  assert.equal(note.user.id, user.id);
  assert.equal(note.origin, 'Cierre de turno');
  const historical = await ds.getRepository(Turno).save({ nombre: 'Histórico', usuarioApertura: user, usuarioCierre: user, fondoInicial: 0, estado: 'CERRADO', fechaCierre: new Date('2026-10-01T10:00:00Z'), observaciones: 'Se perdió plata' });
  const Structural = load('database/migrations/1790000039000-avisos-automaticos', 'AvisosAutomaticos1790000039000');
  const Backfill = load('database/migrations/1790000040000-avisos-notas-existentes', 'AvisosNotasExistentes1790000040000');
  const runner = ds.createQueryRunner();
  try {
    await new Structural().up(runner); await new Backfill().up(runner); await new Backfill().up(runner);
  } finally { await runner.release(); }
  assert.equal(await ds.getRepository(Note).count({ where: { sourceKey: `cierre:${historical.id}` } }), 1);
  const recovered = await ds.getRepository(Note).findOneBy({ sourceKey: `cierre:${historical.id}` });
  assert.equal(recovered.description, 'Se perdió plata');
  assert.equal(recovered.date, '2026-10-01');
  assert.equal(await ds.getRepository(Note).count({ where: { sourceKey: `cierre:${closed.id}` } }), 1);
});

test('avisos: rollback, savepoint e idempotencia anuncian solamente notas confirmadas', async () => {
  const Note = load('notes/entities/note.entity', 'Note');
  const { publishAutomaticNote, installAutomaticNoteNotifications } = require('../dist/notes/automatic-note');
  const events = [];
  installAutomaticNoteNotifications(ds, async e => { events.push(e); });
  const id = require('node:crypto').randomUUID();
  const input = { sourceKey: `prueba:${id}`, origin: 'Cierre de turno', sourceType: 'TURNO', sourceId: id, usuarioId: user.id, description: 'No debe publicarse antes de confirmar' };
  await assert.rejects(ds.transaction(async m => { await publishAutomaticNote(m, input); assert.equal(events.length, 0); throw new Error('cancelado'); }), /cancelado/);
  assert.equal(await ds.getRepository(Note).count({ where: { sourceKey: input.sourceKey } }), 0);
  assert.equal(events.length, 0);
  await ds.transaction(async m => {
    await publishAutomaticNote(m, input);
    await assert.rejects(m.transaction(async nested => { await publishAutomaticNote(nested, { ...input, sourceKey: input.sourceKey + ':fallido' }); throw new Error('savepoint'); }), /savepoint/);
    assert.equal(events.length, 0);
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.length, 1);
  await ds.transaction(m => publishAutomaticNote(m, input));
  assert.equal(events.length, 1);
  assert.equal(await ds.getRepository(Note).count({ where: { sourceKey: input.sourceKey } }), 1);
  const NotesService = load('notes/notes.service', 'NotesService');
  const service = new NotesService(ds.getRepository(Note), ds.getRepository(User), { sendNotification: async () => {} });
  await assert.rejects(service.update(events[0].noteId, { description: 'Modificación separada' }), /operación original/);
  await assert.rejects(service.remove(events[0].noteId), /operación original/);
  await service.markRead(events[0].noteId, user.id);
  assert.ok(!(await service.unread(user.id)).includes(events[0].noteId));
});


test('avisos: pendientes primero en toda la paginación, luego recientes, y leer actualiza el orden', async () => {
  const Note = load('notes/entities/note.entity', 'Note');
  const NotesService = load('notes/notes.service', 'NotesService');
  const service = new NotesService(ds.getRepository(Note), ds.getRepository(User), { sendNotification: async () => {} });
  const repo = ds.getRepository(Note);
  const marker = 'OrdenAvisosTask';
  const author = await ds.getRepository(User).save({ username: 'avisos-order', email: 'avisos-order@example.test', firstName: 'Otra', lastName: 'Persona', role: 'USER' });
  const older = await repo.save({ description: marker + ' pendiente anterior', user: author, createdAt: new Date('2026-01-01T10:00:00Z') });
  const newer = await repo.save({ description: marker + ' pendiente más reciente', user: author, createdAt: new Date('2026-01-02T10:00:00Z') });
  const read = await repo.save({ description: marker + ' ya leído más reciente', user: author, readBy: [user.id], createdAt: new Date('2026-10-05T10:00:00Z') });
  const own = await repo.save({ description: marker + ' propio reciente', user, createdAt: new Date('2026-10-04T10:00:00Z') });
  const query = { page: 1, limit: 2, search: marker, path: 'http://example.test/notes' };
  const first = await service.findAll(query, user.id);
  assert.deepEqual(first.data.map(n => n.id), [newer.id, older.id]);
  assert.equal(first.meta.totalItems, 4);
  assert.ok(first.data.every(n => !Object.hasOwn(n, 'readBy') && !Object.hasOwn(n, 'unread_order')));
  assert.deepEqual((await service.findAll({ ...query, page: 2 }, user.id)).data.map(n => n.id), [read.id, own.id]);
  await service.markRead(newer.id, user.id);
  assert.deepEqual((await service.findAll(query, user.id)).data.map(n => n.id), [older.id, read.id]);
  await service.markRead(older.id, user.id);
  assert.deepEqual((await service.findAll(query, user.id)).data.map(n => n.id), [read.id, own.id]);
});
