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
  // Estas pruebas cubren otras reglas con estadías de pocos minutos: sin cobro dentro de la
  // tolerancia (activo por defecto) se prueba aparte (stay-pricing.spec y tickets.integration).
  await ds.query('ALTER TABLE ticket_schedule_settings ALTER COLUMN "sinCobroEnTolerancia" SET DEFAULT false');
  await ds.query('UPDATE ticket_schedule_settings SET "sinCobroEnTolerancia" = false');
  const repo = entity => ds.getRepository(entity);
  shifts = new TurnosService(repo(Turno), repo(Movimiento), ds);
  movements = new MovimientosService(repo(Movimiento), shifts);
  boxes = new BoxListsService(repo(Box), repo(Other), ds);
  tickets = new TicketsService(repo(Ticket), repo(TicketPrice), repo(Bracket), repo(Registration), repo(RegistrationDay), repo(Schedule), boxes, { emitNewRegistration() {} }, movements, ds);
  require('./mostrador.cjs').comoMostrador({ tickets, shifts });
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
  return shifts.open(id, { cajaId: caja.id, fondoInicial: caja.session ? 0 : received, cambioAgregado: caja.session ? 0 : Math.max(0, received - caja.efectivoDisponible), sesionActivaId: caja.session?.id, sesionAnteriorId: caja.pending?.id, turnoAnteriorId: caja.legacyPending?.id,
    // Sumarse a una caja abierta pide contarla: acá coincide con lo esperado.
    conteoRelevo: caja.session ? caja.efectivoDisponible : undefined });
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
  // El cierre recuerda con qué fondo se abrió la caja: el que se sumó tiene fondo 0 en su turno,
  // pero la caja que cuenta arrancó con 2000.
  assert.deepEqual([current.active.fondoCaja, current.active.abrioLaCaja], [2000, true]);
  const delSegundo = (await context(second.id)).active;
  assert.deepEqual([delSegundo.fondoInicial, delSegundo.fondoCaja, delSegundo.abrioLaCaja], [0, 2000, false]);
  // La conciliación no viaja en el contexto (se pide cada minuto, antes de contar): se pide aparte.
  assert.equal(current.active.conciliacion, undefined);
  const detalle = await shifts.conciliacion(a.id, user.id, 'USER');
  assert.equal(detalle.fondoInicial, 2000);
  assert.equal(detalle.ingresos, 12000);
  assert.equal(detalle.esperado, current.active.efectivoDisponible);
  await assert.rejects(shifts.conciliacion(a.id, second.id, 'USER'), /responsable/);
  assert.deepEqual(detalle.conteos.map(k => [k.momento, k.contado, k.diferencia]), [['INGRESO', 2000, 0]]);
  assert.equal((await context(second.id)).active.efectivoOperado, 7000);
  await assert.rejects(shifts.close(a.id, third.id, { cerrarCaja: false }, 'USER'), /responsable/);
  await assert.rejects(shifts.close(a.id, third.id, { cerrarCaja: false }, 'ADMIN'), /por qué/);
  // Deja la caja y el otro sigue: cuenta el cajón. Con diferencia, motivo.
  await assert.rejects(shifts.close(a.id, user.id, { cerrarCaja: false }), /Contá el efectivo/);
  await assert.rejects(shifts.close(a.id, user.id, { cerrarCaja: false, conteoRelevo: 13000 }), (e) => e.response?.code === 'MOTIVO_CONTEO_RELEVO_REQUERIDO');
  const individual = await shifts.close(a.id, user.id, { cerrarCaja: false, conteoRelevo: 13000, motivoConteoRelevo: 'Error en un vuelto' });
  const relevos = (await shifts.conciliacion(b.id, second.id, 'USER')).conteos;
  assert.deepEqual(relevos.map(k => [k.momento, k.contado, k.esperado, k.diferencia, k.motivo]), [['INGRESO', 2000, 2000, 0, null], ['SALIDA', 13000, 14000, 1000, 'Error en un vuelto']]);
  // El conteo no mueve dinero: lo esperado sigue igual.
  assert.equal((await principal()).efectivoDisponible, 14000);
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
  const detalle = await shifts.conciliacion((await context(second.id)).active.id, second.id, 'USER');
  assert.equal(detalle.fondoInicial, 3000);
  assert.equal(detalle.ingresos, 5500);
  assert.equal(detalle.egresos, 1000);
  assert.equal(detalle.esperado, 7500);
  assert.equal(detalle.movimientos.length, 3, 'no mezcla movimientos de otra caja');
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
  const closedA = await shifts.close(a.id, user.id, { cerrarCaja: false, efectivoEsperado: balance, sueldoEsperado: 10000, conteoRelevo: balance });
  const closedB = await shifts.close(b.id, second.id, { cerrarCaja: false, efectivoEsperado: balance - 10000, sueldoEsperado: 20000, conteoRelevo: balance - 10000 });
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

test('con arqueo el sueldo se compara con lo que deja el operador, no con el fondo configurado', async () => {
  // Sueldo 25.000 y fondo 15.000. Contó 35.000 y deja 10.000: sobran 25.000, justo el sueldo.
  // Con la regla anterior (35.000 − fondo 15.000 = 20.000) el sueldo «no alcanzaba».
  const t = await openCash(user.id, 15000);
  assert.equal(t.sueldoPrevisto, 25000);
  await cash(user.id, 20000);
  await assert.rejects(shifts.close(t.id, user.id, { efectivoContado: 35000, efectivoEsperado: 35000, efectivoParaSiguiente: 10000, sueldoEsperado: 0 }), /sueldo actualizado/);
  const closed = await shifts.close(t.id, user.id, { efectivoContado: 35000, efectivoEsperado: 35000, efectivoParaSiguiente: 10000, sueldoEsperado: 25000 });
  assert.equal(closed.sueldoRetirado, 25000);
  assert.equal(closed.efectivoParaSiguiente, 10000);
  assert.equal(closed.alertaSueldo, null);
  assert.equal(await ds.getRepository(SessionMovement).count({ where: { turnoId: t.id, tipo: 'SUELDO' } }), 1);
});

test('sueldo opcional: si alcanza, el operador puede no retirarlo y el efectivo queda para el retiro', async () => {
  const t = await openCash(user.id, 15000);
  await cash(user.id, 90000);
  // Sin elegir, sigue siendo obligatorio informar el sueldo que alcanza.
  await assert.rejects(shifts.close(t.id, user.id, { efectivoContado: 105000, efectivoEsperado: 105000, efectivoParaSiguiente: 15000, sueldoEsperado: 0 }), /sueldo actualizado/);
  await assert.rejects(shifts.close(t.id, user.id, { efectivoContado: 105000, efectivoEsperado: 105000, efectivoParaSiguiente: 15000, sueldoEsperado: 25000, sinSueldo: true }), /sueldo actualizado/);
  const closed = await shifts.close(t.id, user.id, { efectivoContado: 105000, efectivoEsperado: 105000, efectivoParaSiguiente: 15000, sueldoEsperado: 0, sinSueldo: true });
  assert.equal(closed.sueldoRetirado, 0);
  assert.equal(closed.efectivoRetirado, 90000);
  assert.match(closed.alertaSueldo, /eligió no retirarlo/);
  assert.equal(await ds.getRepository(SessionMovement).count({ where: { turnoId: t.id, tipo: 'SUELDO' } }), 0);
});

test('fondo protegido apagado (0): el sueldo no reserva efectivo para un fondo', async () => {
  const register = await principal();
  await shifts.saveCaja({ nombre: register.nombre, fondoObjetivo: 0 }, register.id);
  try {
    const t = await openCash(user.id, 15000);
    await cash(user.id, 10000);
    const activo = (await context()).active;
    assert.equal(activo.fondoObjetivo, 0);
    // Con fondo de $15.000 no alcanzaría (25.000 − 15.000 < 25.000); sin fondo protegido, sí.
    assert.equal(activo.sueldoSugerido, 25000);
    const closed = await shifts.close(t.id, user.id, { efectivoContado: 25000, efectivoEsperado: 25000, efectivoParaSiguiente: 0, sueldoEsperado: 25000 });
    assert.equal(closed.sueldoRetirado, 25000);
    assert.equal(closed.alertaSueldo, null);
  } finally {
    await shifts.saveCaja({ nombre: register.nombre, fondoObjetivo: 15000 }, register.id);
  }
});

test('super admin: no abre turnos de caja (su efectivo no se mezcla con la playa)', async () => {
  const root = await ds.getRepository(User).save({ username: 'root-turno', email: 'root-turno@example.test', firstName: 'Root', lastName: 'Turno', role: 'SUPER_ADMIN' });
  const caja = await principal();
  await assert.rejects(shifts.open(root.id, { cajaId: caja.id, fondoInicial: 0 }, 'SUPER_ADMIN'), (e) => e.response?.code === 'SUPER_ADMIN_SIN_TURNO');
  assert.equal(await ds.getRepository(Turno).count({ where: { usuarioApertura: { id: root.id } } }), 0);
});

test('arqueo: guarda el primer conteo, marca estadías para revisar y avisa la patente que acaba de salir', async () => {
  const t = await openCash(user.id, 15000);
  // MLT748 (12/11/2026): salió sin cobro con un descuento total y en el mismo minuto se cargó y
  // cobró otra estadía de la misma patente.
  const primera = await age(await tickets.createRegistrationByPlate({ vehicleType: 'AUTO', licensePlate: 'MLT748' }), 9);
  const precio = (await tickets.getCloseSummary(primera.id)).previewBracket.price;
  await tickets.discountRegistration(primera.id, { monto: precio, total: true, motivo: 'Poco tiempo', expectedPrice: precio, expectedCollected: 0 }, user.id);
  await tickets.closeRegistrationByPlate(primera.id, await payload(primera.id, { closeType: 'NO_CHARGE', metodo: undefined }), user.id);
  const estado = await tickets.getPlateStatus('mlt 748');
  assert.equal(estado.hourly.length, 0);
  assert.deepEqual([estado.salidaReciente.id, estado.salidaReciente.cobrado, estado.salidaReciente.motivoDescuento], [primera.id, 0, 'Poco tiempo']);
  assert.equal((await tickets.getPlateStatus('OTRA999')).salidaReciente, null);
  const segunda = await age(await tickets.createRegistrationByPlate({ vehicleType: 'AUTO', licensePlate: 'MLT748' }), 1);
  await tickets.closeRegistrationByPlate(segunda.id, await payload(segunda.id), user.id);
  const detalle = await shifts.conciliacion(t.id, user.id, 'USER');
  // Las dos salidas pueden caer en el mismo segundo: se compara sin depender del orden.
  const marcas = detalle.paraRevisar.filter(x => x.patente === 'MLT748').map(x => [x.id === primera.id ? 'primera' : 'segunda', x.motivo]).sort();
  assert.deepEqual(marcas, [['primera', 'DESCUENTO_TOTAL'], ['segunda', 'COBRO_SIN_TIEMPO'], ['segunda', 'REINGRESO']]);
  // El operador cargó 500 menos, vio lo esperado y corrigió: queda el primer conteo.
  const esperado = (await context()).efectivoDisponible;
  const closed = await shifts.close(t.id, user.id, { efectivoContado: esperado, efectivoEsperado: esperado, efectivoParaSiguiente: 15000, sueldoEsperado: 0, primerConteo: esperado - 500 });
  assert.equal(closed.primerConteo, esperado - 500);
  assert.equal((await ds.getRepository(Session).findOneByOrFail({ id: t.cashSessionId })).primerConteo, esperado - 500);
  const [nota] = await ds.query(`SELECT description FROM notes WHERE "sourceKey" = $1`, ['cierre:' + t.id]);
  assert.match(nota.description, /Primer conteo: \$\d+; se corrigió a \$\d+ después de ver lo esperado\./);
});

test('arqueo por billetes: obligatorio, total recalculado por el servidor, primer conteo conservado y caja compartida', async () => {
  const previa = await tickets.getSchedule();
  await tickets.updateSchedule({ multipleShiftsEnabled: true, sueldoAutomatico: false });
  const { billetes } = require('./mostrador.cjs');
  const codigo = (code) => (e) => e.response?.code === code;
  try {
    const a = await openCash(user.id, 15000);
    const b = await openCash(second.id, 0);
    assert.equal(b.cashSessionId, a.cashSessionId);
    await cash(user.id, 3500);
    await cash(second.id, 1500);
    // Quien deja la caja compartida no hace el arqueo final: cuenta el relevo, sin billetes.
    const esperadoRelevo = (await context(user.id)).active.efectivoDisponible;
    await assert.rejects(shifts.close(a.id, user.id, { cerrarCaja: false, conteoRelevo: esperadoRelevo, desglose: billetes(esperadoRelevo) }), /Hay otros operadores/);
    const parcial = await shifts.close(a.id, user.id, { cerrarCaja: false, conteoRelevo: esperadoRelevo });
    assert.deepEqual([parcial.efectivoContado, parcial.conteoDesglose], [null, null]);

    // El último cuenta todo el cajón (fondo incluido, una sola vez) por billetes.
    const esperado = (await context(second.id)).active.efectivoDisponible;
    assert.equal(esperado, 15000 + 3500 + 1500);
    const cierre = { cerrarCaja: true, efectivoEsperado: esperado, efectivoParaSiguiente: 0 };
    // Escribir solo el total no alcanza.
    await assert.rejects(shifts.close(b.id, second.id, { ...cierre, efectivoContado: esperado, desglose: null }), codigo('CONTEO_BILLETES_REQUERIDO'));
    // El total de la pantalla tiene que coincidir con los billetes; el servidor no elige uno.
    await assert.rejects(shifts.close(b.id, second.id, { ...cierre, efectivoContado: esperado, desglose: billetes(esperado - 1000) }), codigo('CONTEO_NO_COINCIDE'));
    await assert.rejects(shifts.close(b.id, second.id, { ...cierre, desglose: [{ denominacion: 300, cantidad: 1 }] }), codigo('CONTEO_BILLETES_INVALIDO'));
    await assert.rejects(shifts.close(b.id, second.id, { ...cierre, desglose: [{ denominacion: 1000, cantidad: -2 }] }), codigo('CONTEO_BILLETES_INVALIDO'));
    // Contó $1.000 menos, vio lo esperado y volvió a contar: quedan los dos conteos y la corrección.
    const primero = [{ denominacion: 10000, cantidad: 1 }, { denominacion: 2000, cantidad: 4 }, { denominacion: 1000, cantidad: 1 }];
    const final = [{ denominacion: 10000, cantidad: 1 }, { denominacion: 2000, cantidad: 4 }, { denominacion: 1000, cantidad: 2 }];
    const cerrado = await shifts.close(b.id, second.id, { ...cierre, desglose: final, primerConteoDesglose: primero });
    assert.deepEqual([cerrado.efectivoContado, cerrado.primerConteo, cerrado.diferencia, cerrado.efectivoRetirado], [20000, 19000, 0, 20000]);
    assert.deepEqual(cerrado.conteoDesglose, [{ denominacion: 10000, cantidad: 1 }, { denominacion: 2000, cantidad: 4 }, { denominacion: 1000, cantidad: 2 }]);
    assert.deepEqual(cerrado.primerConteoDesglose, primero);
    const sesion = await ds.getRepository(Session).findOneByOrFail({ id: a.cashSessionId });
    assert.deepEqual([sesion.efectivoContado, sesion.primerConteo, sesion.conteoDesglose, sesion.primerConteoDesglose], [20000, 19000, cerrado.conteoDesglose, primero]);
    const [nota] = await ds.query(`SELECT description FROM notes WHERE "sourceKey" = $1`, ['cierre:' + b.id]);
    assert.match(nota.description, /Primer conteo: \$19000; se corrigió a \$20000 después de ver lo esperado\. Billetes corregidos: \$1\.000: de 1 a 2\./);
    // Los conteos no mueven dinero: queda lo que se deja para el siguiente turno.
    assert.equal((await principal()).efectivoDisponible, 0);

    // «No hay efectivo»: un desglose vacío es un conteo de $0.
    const c = await openCash(user.id, 0);
    const vacio = await shifts.close(c.id, user.id, { cerrarCaja: true, efectivoEsperado: 0, efectivoParaSiguiente: 0, desglose: [] });
    assert.deepEqual([vacio.efectivoContado, vacio.conteoDesglose, vacio.diferencia], [0, [], 0]);
  } finally {
    await tickets.updateSchedule({ multipleShiftsEnabled: previa.multipleShiftsEnabled, sueldoAutomatico: previa.sueldoAutomatico });
  }
});

test('historial de cobros en efectivo: muestra lo declarado recibido y el vuelto, y los anteriores quedan sin dato', async () => {
  const previa = await tickets.getSchedule();
  await tickets.updateSchedule({ sueldoAutomatico: false });
  const t = await openCash(user.id, 15000);
  try {
    const conVuelto = await age(await tickets.createRegistrationByPlate({ vehicleType: 'AUTO', licensePlate: 'VTO' + (++counter) }));
    await tickets.closeRegistrationByPlate(conVuelto.id, await payload(conVuelto.id, { efectivoRecibido: 10000 }), user.id);
    const anterior = await age(await tickets.createRegistrationByPlate({ vehicleType: 'AUTO', licensePlate: 'ANT' + (++counter) }));
    await tickets.closeRegistrationByPlate(anterior.id, await payload(anterior.id), user.id);
    // Un cobro guardado antes de este dato.
    await ds.query(`UPDATE movimientos SET "efectivoRecibido" = NULL, vuelto = NULL WHERE "ticketRegistrationId" = $1`, [anterior.id]);
    const detalle = await shifts.cobrosEfectivo(t.id);
    const fila = (patente) => detalle.cobros.find(c => c.identificacion === patente);
    const precio = (await ds.getRepository(Registration).findOneByOrFail({ id: conVuelto.id })).price;
    assert.deepEqual([fila(conVuelto.licensePlateOriginal).importe, fila(conVuelto.licensePlateOriginal).recibido, fila(conVuelto.licensePlateOriginal).vuelto], [precio, 10000, 10000 - precio]);
    assert.deepEqual([fila(anterior.licensePlateOriginal).recibido, fila(anterior.licensePlateOriginal).vuelto], [null, null]);
    // Lo declarado no suma: el total sigue siendo lo que entró a la caja.
    assert.equal(detalle.total, detalle.cobros.reduce((s, c) => s + c.importe, 0));
  } finally {
    await closeCash(user.id, 15000);
    await tickets.updateSchedule({ sueldoAutomatico: previa.sueldoAutomatico });
  }
});

test('auditoría: anticipos, descuentos, devoluciones, pagos mixtos, «Se fue antes», entrada olvidada, abonos y gastos cierran exacto', async () => {
  // Faltantes de caja sin explicar (11/2026): se comprueba que cada peso en efectivo que registra
  // una operación llega a la caja, y que cada estadía queda saldada. Dos fuentes independientes:
  // el libro de movimientos de las estadías y los cash_entries de la caja.
  const t = await openCash(user.id, 15000);
  const fondo = (await context()).efectivoDisponible;
  const precioDe = async (id) => (await tickets.getCloseSummary(id)).previewBracket.price;
  const cerrar = (id, extra) => payload(id, extra).then(dto => tickets.closeRegistrationByPlate(id, dto, user.id));
  const ids = [];
  const nueva = async (minutos, patente) => { const r = await age(await tickets.createRegistrationByPlate({ vehicleType: 'AUTO', licensePlate: patente }), minutos); ids.push(r.id); return r; };

  // Anticipo en efectivo, se reduce (devolución en efectivo) y al salir sobra: se devuelve el resto.
  const a = await nueva(30, 'AUD001');
  await tickets.addAdvancePayment(a.id, { advancePaidAmount: 3000, metodo: 'CASH' }, user.id);
  await tickets.addAdvancePayment(a.id, { advancePaidAmount: 2000, metodo: 'CASH', adjustmentReason: 'Se cobró de más' }, user.id);
  await cerrar(a.id, { closeType: 'NO_CHARGE', metodo: undefined, refundMetodo: 'CASH' });
  // Descuento parcial y cobro mixto: efectivo y transferencia.
  const b = await nueva(90, 'AUD002');
  const precioB = await precioDe(b.id);
  await tickets.discountRegistration(b.id, { monto: 300, motivo: 'Cliente frecuente', expectedPrice: precioB, expectedCollected: 0 }, user.id);
  const saldoB = await precioDe(b.id);
  await cerrar(b.id, { metodo: undefined, pagos: [{ metodo: 'CASH', importe: saldoB - 500 }, { metodo: 'TRANSFER', importe: 500 }] });
  // Parte en efectivo y el resto por transferencia.
  const c = await nueva(90, 'AUD003');
  await tickets.cobrarParteEnEfectivo(c.id, { importe: 700, expectedPrice: await precioDe(c.id), expectedCollected: 0 }, user.id);
  await cerrar(c.id, { metodo: 'TRANSFER' });
  // Descuento total: sale sin cobro.
  const d = await nueva(30, 'AUD004');
  const precioD = await precioDe(d.id);
  await tickets.discountRegistration(d.id, { monto: precioD, total: true, motivo: 'Poco tiempo', expectedPrice: precioD, expectedCollected: 0 }, user.id);
  await cerrar(d.id, { closeType: 'NO_CHARGE', metodo: undefined });
  // Cortesía.
  const e = await nueva(30, 'AUD005');
  await cerrar(e.id, { closeType: 'COURTESY', motivo: 'Invitado', metodo: undefined });
  // «Se fue antes»: se cobra en efectivo la tarifa elegida, no la de ahora.
  const f = await nueva(5 * 60, 'AUD006');
  const [primera] = (await tickets.opcionesSalidaAnterior(f.id)).opciones;
  await tickets.registrarSalidaAnterior(f.id, { closeType: 'PAYMENT', metodo: 'CASH', expectedPrice: primera.precio, expectedCollected: 0, salidaEn: primera.salidaEn }, user.id);
  // Entrada olvidada: se corrige la hora hacia atrás y se cobra en efectivo lo recalculado.
  const g = await nueva(0, 'AUD007');
  await tickets.corregirEntradaOlvidada(g.id, dayjs().subtract(95, 'minute').toISOString(), user.id);
  await cerrar(g.id);
  // Abonos por día: cobrado en efectivo, marcado pagado después, y uno cobrado y eliminado.
  // El precio del día lo carga más adelante otra prueba: acá se crea solo si falta.
  const precioDia = (await ds.getRepository(TicketPrice).findOneBy({ ticketTimeType: 'DIA', vehicleType: 'AUTO' }))
    ? null : await ds.getRepository(TicketPrice).save({ ticketTimeType: 'DIA', vehicleType: 'AUTO', ticketTimePrice: 2000 });
  const pase = await tickets.createRegistrationForDay({ ticketTimeType: 'DIA', vehicleType: 'AUTO', days: 1, paid: true, paymentMetodo: 'CASH', efectivoRecibido: 2000 }, user.id);
  const pendiente = await tickets.createRegistrationForDay({ ticketTimeType: 'DIA', vehicleType: 'AUTO', days: 1, paid: false }, user.id);
  await tickets.updateTicketStatus(pendiente.id, { paid: true, paymentMetodo: 'CASH', efectivoRecibido: 2000 }, user.id);
  const borrado = await tickets.createRegistrationForDay({ ticketTimeType: 'DIA', vehicleType: 'AUTO', days: 1, paid: true, paymentMetodo: 'CASH', efectivoRecibido: 2000 }, user.id);
  await tickets.removeRegistrationForDay(borrado.id);
  // Varios: un gasto y un ingreso en efectivo.
  await boxes.createOtherPayment({ description: 'Gasto auditoría', price: 700, type: 'EGRESOS', paymentMethod: 'CASH' });
  await boxes.createOtherPayment({ description: 'Ingreso auditoría', price: 400, type: 'INGRESOS', paymentMethod: 'CASH' });

  // 1) Cada estadía quedó saldada: lo cobrado (con devoluciones) más la cortesía es su precio.
  for (const id of ids) {
    const [fila] = await ds.query(`SELECT r.price,
        COALESCE(SUM(m.monto) FILTER (WHERE m.tipo IN ('ANTICIPO', 'SALDO', 'AJUSTE')), 0) AS cobrado,
        COALESCE(SUM(m.monto) FILTER (WHERE m.tipo = 'CORTESIA'), 0) AS cortesia
      FROM ticket_registrations r LEFT JOIN movimientos m ON m."ticketRegistrationId" = r.id
      WHERE r.id = $1 GROUP BY r.id`, [id]);
    assert.equal(Number(fila.cobrado) + Number(fila.cortesia), Number(fila.price), `estadía ${id} saldada`);
  }
  // 2) La caja coincide con el libro: fondo + efectivo de las estadías + abonos + varios.
  const [libro] = await ds.query(`SELECT COALESCE(SUM(monto), 0) AS total FROM movimientos
    WHERE "turnoId" = $1 AND metodo = 'CASH' AND tipo IN ('ANTICIPO', 'SALDO', 'AJUSTE')`, [t.id]);
  const abonos = pase.price + pendiente.price;
  const esperado = fondo + Number(libro.total) + abonos - 700 + 400;
  assert.equal((await context()).efectivoDisponible, esperado, 'la caja coincide con el libro de movimientos');
  // Cuenta a mano: A deja solo su precio (3000 − 1000 − lo que sobró), B el efectivo del pago mixto,
  // C la parte en efectivo, D y E nada, F la tarifa elegida y G lo recalculado.
  const precio = async (r) => Number((await ds.getRepository(Registration).findOneByOrFail({ id: r.id })).price);
  assert.equal(Number(libro.total), (await precio(a)) + (saldoB - 500) + 700 + primera.precio + (await precio(g)));
  // 3) El detalle del historial: cada peso en efectivo del turno, con su operación cuando se puede
  // identificar, y nada que no sea efectivo (transferencias, cortesías, descuentos, varios).
  const detalle = await shifts.cobrosEfectivo(t.id);
  const resumen = await book().shiftSummary(ds.manager, await ds.getRepository(Turno).findOneByOrFail({ id: t.id }));
  assert.equal(detalle.total, resumen.efectivoCobrado - resumen.devolucionesEfectivo, 'el total es el efectivo cobrado menos lo devuelto del resumen');
  assert.equal(detalle.total, Number(libro.total) + abonos, 'estadías del libro de movimientos + pases cobrados');
  assert.equal(detalle.cantidad, detalle.cobros.length);
  const de = (patente) => detalle.cobros.filter((c) => c.identificacion === patente).map((c) => [c.concepto, c.importe]);
  // Anticipo, su reducción y la devolución del sobrante al salir, con su signo.
  const filasA = de('AUD001');
  assert.deepEqual(filasA.map(([concepto]) => concepto), ['ANTICIPO', 'DEVOLUCION', 'DEVOLUCION']);
  assert.equal(filasA.reduce((s, [, importe]) => s + importe, 0), await precio(a));
  // Pago mixto: solo la parte en efectivo.
  assert.deepEqual(de('AUD002'), [['SALDO', saldoB - 500]]);
  // Parte en efectivo y el resto por transferencia: solo los 700.
  assert.deepEqual(de('AUD003').map(([, importe]) => importe), [700]);
  // Descuento total y cortesía no son plata.
  assert.deepEqual(de('AUD004'), []);
  assert.deepEqual(de('AUD005'), []);
  assert.deepEqual(de('AUD006'), [['SALDO', primera.precio]]);
  // El pase cobrado al registrarlo se identifica; no tiene patente y no se inventa una.
  const pases = detalle.cobros.filter((c) => c.concepto === 'ESTADIA_PERIODO');
  assert.deepEqual(pases.map((c) => [c.importe, c.identificacion, c.periodo]), [[pase.price, null, 'día']]);
  // El marcado como pagado después y el creado y eliminado no dejan de qué fue: se muestran como
  // entradas de caja sin detalle, con su importe (el eliminado entra y sale).
  assert.deepEqual(detalle.cobros.filter((c) => c.sinDetalle).map((c) => c.importe).sort((x, y) => x - y), [-borrado.price, pendiente.price, borrado.price].sort((x, y) => x - y));
  assert.equal(detalle.sinDetalle, 3);
  // Ordenado por hora; los gastos e ingresos de varios no son cobros.
  assert.deepEqual(detalle.cobros.map((c) => c.fecha), [...detalle.cobros.map((c) => c.fecha)].sort());
  assert.ok(!detalle.cobros.some((c) => Math.abs(c.importe) === 400 && c.sinDetalle));
  // Consultarlo no cambia nada.
  assert.equal((await context()).efectivoDisponible, esperado);
  // 4) Contando exactamente lo esperado, el arqueo cierra sin diferencia.
  const closed = await shifts.close(t.id, user.id, { efectivoContado: esperado, efectivoEsperado: esperado, efectivoParaSiguiente: 15000, sueldoEsperado: 0, sinSueldo: true });
  assert.equal(closed.diferencia, 0);
  if (precioDia) await ds.getRepository(TicketPrice).delete(precioDia.id);
  // Los pases quedarían «adentro» para las pruebas que cuentan ocupación: se retiran sin tocar la caja.
  await ds.getRepository(RegistrationDay).update([pase.id, pendiente.id], { retired: true });
});

test('cobros en efectivo por turno: cada uno ve lo que recibió, aunque la estadía siga en otro turno o compartan la caja', async () => {
  // Sin sueldo durante la prueba; la siguiente usa el que estaba configurado.
  const previa = await ds.getRepository(Schedule).findOneOrFail({ where: {} });
  await tickets.updateSchedule({ sueldoAutomatico: false });
  const cobrosDe = async (turnoId) => (await shifts.cobrosEfectivo(turnoId)).cobros.map((c) => [c.identificacion, c.concepto, c.importe]);
  const entrar = async (patente, minutos = 90) => age(await tickets.createRegistrationByPlate({ vehicleType: 'AUTO', licensePlate: patente }), minutos);
  // El anticipo lo cobra un turno y el saldo otro: cada uno tiene lo suyo.
  const t1 = await openCash(user.id, (await principal()).efectivoDisponible);
  const x = await entrar('TUR001');
  await tickets.addAdvancePayment(x.id, { advancePaidAmount: 500, metodo: 'CASH' }, user.id);
  await closeCash(user.id, (await context()).efectivoDisponible);
  const t2 = await openCash(second.id, (await principal()).efectivoDisponible);
  const saldo = (await tickets.getCloseSummary(x.id)).previewBracket.price - 500;
  await tickets.closeRegistrationByPlate(x.id, await payload(x.id), second.id);
  assert.deepEqual(await cobrosDe(t1.id), [['TUR001', 'ANTICIPO', 500]]);
  assert.deepEqual(await cobrosDe(t2.id), [['TUR001', 'SALDO', saldo]]);
  await closeCash(second.id, (await context(second.id)).efectivoDisponible);

  // Caja compartida: la conciliación mira toda la caja; el detalle de cada turno, solo lo suyo.
  await tickets.updateSchedule({ multipleShiftsEnabled: true });
  try {
    const a = await openCash(user.id, (await principal()).efectivoDisponible);
    const b = await openCash(second.id, 0);
    assert.equal(a.cashSessionId, b.cashSessionId);
    const y = await entrar('TUR002');
    await tickets.closeRegistrationByPlate(y.id, await payload(y.id), user.id);
    const z = await entrar('TUR003');
    await tickets.closeRegistrationByPlate(z.id, await payload(z.id), second.id);
    assert.deepEqual((await cobrosDe(a.id)).map(([patente]) => patente), ['TUR002']);
    assert.deepEqual((await cobrosDe(b.id)).map(([patente]) => patente), ['TUR003']);
    const conciliacion = await shifts.conciliacion(a.id, user.id, 'ADMIN');
    assert.ok(conciliacion.movimientos.length >= 2, 'la conciliación sí abarca toda la caja');

    // Un pago en efectivo de un inquilino: sin patente, con el nombre y su concepto. Se arma igual
    // que lo hace la cuenta corriente: el libro y la caja en la misma transacción.
    const Customer = load('customers/entities/customer.entity', 'Customer');
    const Cuenta = load('cuentas/entities/cuenta-movimiento.entity', 'CuentaMovimiento');
    const inquilino = await ds.getRepository(Customer).save({ firstName: 'Lucía', lastName: 'Inquilina', customerType: 'RENTER', numberOfVehicles: 1 });
    const caja = (await ds.getRepository(CashEntry).findOneByOrFail({ turnoId: a.id })).boxId;
    await ds.transaction(async (m) => {
      await m.getRepository(Cuenta).save({ playaId: require('node:crypto').randomUUID(), customerId: inquilino.id, fecha: dayjs().format('YYYY-MM-DD'), tipo: 'PAGO', importe: -4000, concepto: 'Pago', metodo: 'CASH' });
      await m.getRepository(CashEntry).save({ boxId: caja, amount: 4000, description: 'Movimiento de efectivo', categoria: 'COBRO', turnoId: a.id });
    });
    const conInquilino = await shifts.cobrosEfectivo(a.id);
    assert.deepEqual(conInquilino.cobros.map((c) => [c.identificacion, c.concepto, c.importe, c.sinDetalle]),
      [['TUR002', 'SALDO', conInquilino.cobros[0].importe, false], ['Inquilina Lucía', 'PAGO_INQUILINO', 4000, false]]);
    assert.equal(conInquilino.cantidad, 2);
    await ds.getRepository(CashEntry).delete({ turnoId: a.id, amount: 4000 });
    await assert.rejects(shifts.cobrosEfectivo(require('node:crypto').randomUUID()), /Turno no encontrado/);
    await shifts.close(b.id, second.id, { cerrarCaja: false, conteoRelevo: (await context(second.id)).efectivoDisponible });
    await closeCash(user.id, 15000);
  } finally {
    await tickets.updateSchedule({ multipleShiftsEnabled: false, sueldoAutomatico: previa.sueldoAutomatico, sueldosPorUsuario: previa.sueldosPorUsuario });
  }
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

test('medianoche sin continuación: cierra turno y caja sin contar, no abre otro y el siguiente cuenta lo recibido', async () => {
  const today = dayjs().tz('America/Argentina/Buenos_Aires').startOf('day');
  const yesterday = today.subtract(1, 'day');
  const opened = yesterday.add(20, 'hour').toDate();
  const backdate = async (turno, session = true) => {
    await ds.getRepository(Turno).update(turno.id, { fechaApertura: opened, fechaOperativa: yesterday.format('YYYY-MM-DD') });
    if (!session) return;
    await ds.getRepository(Session).update(turno.cashSessionId, { fechaApertura: opened });
    // Las cajas que las pruebas anteriores cerraron hoy pasan a antes de esta apertura: si no, la
    // última cerrada no sería la del corte, cosa que no puede pasar con una sola sesión abierta por caja.
    await ds.query(`UPDATE cash_sessions SET "fechaCierre" = $1 WHERE estado = 'CERRADO' AND "fechaCierre" > $1`, [dayjs(opened).subtract(1, 'hour').toDate()]);
  };
  await tickets.updateSchedule({ continuarTurnoMedianoche: false, sueldoAutomatico: true, sueldosPorUsuario: [{ usuarioId: user.id, importe: 1000 }] });
  try {
    const t = await openCash(user.id, 15000);
    await cash(user.id, 5000);
    // El cobro fue antes de las 00:00: entra en lo que queda para el siguiente.
    await ds.query('UPDATE cash_entries SET "createdAt" = $1 WHERE "turnoId" = $2', [yesterday.add(21, 'hour').toDate(), t.id]);
    await backdate(t);
    await Promise.all([ds.transaction(m => book().rolloverShifts(m)), ds.transaction(m => book().rolloverShifts(m))]);
    const old = await ds.getRepository(Turno).findOneBy({ id: t.id });
    assert.equal(old.estado, 'CERRADO');
    assert.equal(old.fechaCierre.toISOString(), today.toDate().toISOString());
    assert.equal(old.cierreAutomatico, true);
    assert.equal(old.cierreCaja, true);
    assert.equal(old.efectivoContado, null);
    assert.equal(old.efectivoParaSiguiente, 20000);
    assert.equal(old.sueldoRetirado, 0);
    assert.equal(await ds.getRepository(Turno).count({ where: { continuacionDeId: t.id } }), 0);
    const session = await ds.getRepository(Session).findOneBy({ id: t.cashSessionId });
    assert.equal(session.estado, 'CERRADO');
    assert.equal(session.cierreAutomatico, true);
    assert.equal(session.efectivoContado, null);
    assert.equal(session.efectivoParaSiguiente, 20000);
    assert.equal(await ds.getRepository(CashEntry).count({ where: { turnoId: t.id } }), 1);
    const ctx = await context();
    assert.equal(ctx.active, null);
    const caja = ctx.cajas.find(c => c.principal);
    assert.equal(caja.session, null);
    assert.equal(caja.pending.id, t.cashSessionId);
    assert.equal(caja.traspaso.cierreAutomatico, true);
    assert.equal(caja.efectivoDisponible, 20000);
    assert.equal((await book().shiftSummary(ds.manager, old)).alcanceCaja, 'Caja cerrada a las 00:00 sin contar');
    // La jornada terminó: una operación sin conexión de después de las 00:00 queda para revisar.
    await assert.rejects(ds.transaction(m => book().offlineShift(m, t.id, user.id, new Date())), /jornada ya terminó/);
    // El siguiente cuenta lo que recibe: la diferencia con lo esperado queda en su apertura.
    await assert.rejects(shifts.open(second.id, { cajaId: caja.id, fondoInicial: 19000, cambioAgregado: 0, sesionAnteriorId: caja.pending.id }), /diferencia/);
    const next = await shifts.open(second.id, { cajaId: caja.id, fondoInicial: 19000, cambioAgregado: 0, sesionAnteriorId: caja.pending.id, motivoApertura: 'Faltaban billetes' });
    const nextSession = await ds.getRepository(Session).findOneBy({ id: next.cashSessionId });
    assert.equal(nextSession.sesionAnteriorId, t.cashSessionId);
    assert.equal(nextSession.fondoEsperado, 20000);
    assert.equal(nextSession.diferenciaApertura, 1000);
    await closeCash(second.id, 15000);

    // Turnos múltiples en la misma caja: cada uno termina a las 00:00 y solo el último cierra la caja.
    await tickets.updateSchedule({ multipleShiftsEnabled: true });
    const a = await openCash(user.id, 15000);
    const b = await openCash(second.id, 0);
    assert.equal(b.cashSessionId, a.cashSessionId);
    await backdate(a); await backdate(b, false);
    await ds.transaction(m => book().rolloverShifts(m));
    const cerrados = await ds.getRepository(Turno).findBy([{ id: a.id }, { id: b.id }]);
    assert.deepEqual(cerrados.map(r => r.estado), ['CERRADO', 'CERRADO']);
    assert.equal(cerrados.filter(r => r.cierreCaja).length, 1);
    assert.equal((await ds.getRepository(Session).findOneBy({ id: a.cashSessionId })).estado, 'CERRADO');
    assert.equal(await ds.getRepository(Turno).count({ where: [{ continuacionDeId: a.id }, { continuacionDeId: b.id }] }), 0);

    // Si otro operador abrió después de las 00:00, el turno de ayer termina y la caja sigue con él.
    const shared = (await principal());
    const c = await openCash(user.id, shared.efectivoDisponible);
    const d = await openCash(second.id, 0);
    await backdate(c, false);
    await ds.transaction(m => book().rolloverShifts(m));
    const ayer = await ds.getRepository(Turno).findOneBy({ id: c.id });
    assert.equal(ayer.estado, 'CERRADO');
    assert.equal(ayer.cierreCaja, false);
    assert.equal((await ds.getRepository(Session).findOneBy({ id: c.cashSessionId })).estado, 'ABIERTO');
    assert.equal((await context(second.id)).active.id, d.id);
    await closeCash(second.id, 15000);
  } finally {
    await tickets.updateSchedule({ continuarTurnoMedianoche: true, multipleShiftsEnabled: false, sueldoAutomatico: false, sueldosPorUsuario: [] });
  }
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
  await shifts.close(a.id, user.id, { cerrarCaja: false, efectivoEsperado: 40000, sueldoEsperado: 25000, conteoRelevo: 40000 });
  assert.equal((await context(second.id)).efectivoDisponible, 15000);
  const conciliacion = await shifts.conciliacion(b.id, second.id, 'USER');
  assert.equal(conciliacion.ingresos, 25000, 'conserva cobros del participante que cerró');
  assert.equal(conciliacion.egresos, 25000, 'descuenta una sola vez el sueldo ya retirado');
  assert.equal(conciliacion.esperado, 15000);
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

// Cualquier diferencia pide motivo (sin tolerancia), con código para el front; «No sé el motivo»
// alcanza y la diferencia queda registrada igual.
test('cierre con diferencia: pide motivo con código y acepta «No sé el motivo»', async () => {
  const t = await openCash(user.id, 15000);
  await cash(user.id, 1000);
  assert.equal((await context()).efectivoDisponible, 16000);
  const sinMotivo = { cerrarCaja: true, efectivoEsperado: 16000, efectivoContado: 15500, efectivoParaSiguiente: 15000 };
  const pideMotivo = (e) => e.getResponse?.().code === 'MOTIVO_DIFERENCIA_REQUERIDO';
  await assert.rejects(shifts.close(t.id, user.id, sinMotivo), pideMotivo);
  await assert.rejects(shifts.close(t.id, user.id, { ...sinMotivo, observaciones: '   ' }), pideMotivo);
  const closed = await shifts.close(t.id, user.id, { ...sinMotivo, observaciones: 'No sé el motivo' });
  assert.equal(closed.diferencia, 500);
  assert.equal(closed.observaciones, 'No sé el motivo');
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
  // Pendientes de esta semana: los de más de 7 días dejan de contar (ver la prueba siguiente).
  const dia = (n) => dayjs().subtract(n, 'day').toDate();
  const older = await repo.save({ description: marker + ' pendiente anterior', user: author, createdAt: dia(3) });
  const newer = await repo.save({ description: marker + ' pendiente más reciente', user: author, createdAt: dia(2) });
  const read = await repo.save({ description: marker + ' ya leído más reciente', user: author, readBy: [user.id], createdAt: dayjs().subtract(1, 'hour').toDate() });
  const own = await repo.save({ description: marker + ' propio reciente', user, createdAt: dayjs().subtract(2, 'hour').toDate() });
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

test('avisos: solo los para revisar de esta semana quedan pendientes y suman al número', async () => {
  const Note = load('notes/entities/note.entity', 'Note');
  const NotesService = load('notes/notes.service', 'NotesService');
  const service = new NotesService(ds.getRepository(Note), ds.getRepository(User), { sendNotification: async () => {} });
  const repo = ds.getRepository(Note);
  const marker = 'SemanaAvisosTask';
  const author = await ds.getRepository(User).save({ username: 'avisos-semana', email: 'avisos-semana@example.test', firstName: 'Semana', lastName: 'Avisos', role: 'USER' });
  const hoyAR = dayjs().tz('America/Argentina/Buenos_Aires');
  const fecha = (dias) => hoyAR.subtract(dias, 'day').format('YYYY-MM-DD');
  const revisarHoy = await repo.save({ description: marker + ' faltante', user: author, date: fecha(0) });
  const revisarBorde = await repo.save({ description: marker + ' hace seis días', user: author, date: fecha(6) });
  const revisarViejo = await repo.save({ description: marker + ' hace siete días', user: author, date: fecha(7) });
  const informativo = await repo.save({ description: marker + ' descuento', user: author, date: fecha(0), paraRevisar: false });
  const unread = await service.unread(user.id);
  assert.ok(unread.includes(revisarHoy.id) && unread.includes(revisarBorde.id));
  assert.ok(!unread.includes(revisarViejo.id) && !unread.includes(informativo.id));
  const query = { page: 1, limit: 10, search: marker, path: 'http://example.test/notes' };
  const lista = await service.findAll(query, user.id);
  // Lo viejo y lo informativo no se borran: se listan, pero no como pendientes.
  assert.equal(lista.meta.totalItems, 4);
  assert.deepEqual(lista.pendientes.sort(), [revisarHoy.id, revisarBorde.id].sort());
  assert.deepEqual(lista.conteos, { todos: 4, sinLeer: 2, leidos: 2 });
  assert.equal((await service.findAll(query, user.id, { estado: 'SIN_LEER' })).meta.totalItems, 2);
  // Marcar todo solo toca lo pendiente; lo viejo sin leer queda igual, sin contar.
  await service.markAllRead(user.id);
  assert.equal((await service.findAll(query, user.id)).conteos.sinLeer, 0);
  const [viejo] = await ds.query('SELECT "readBy" FROM notes WHERE id = $1', [revisarViejo.id]);
  assert.deepEqual(viejo.readBy, []);
});

test('avisos: cada operación publica el suyo como para revisar o informativo', async () => {
  const Note = load('notes/entities/note.entity', 'Note');
  const { publishAutomaticNote } = require('../dist/notes/automatic-note');
  const id = require('node:crypto').randomUUID();
  await ds.transaction(m => publishAutomaticNote(m, { sourceKey: `clasificacion:${id}:sin`, origin: 'Nueva operación', sourceType: 'TICKET', sourceId: id, usuarioId: user.id, description: 'Sin clasificar' }));
  await ds.transaction(m => publishAutomaticNote(m, { sourceKey: `clasificacion:${id}:info`, origin: 'Descuento de vehículo', sourceType: 'TICKET', sourceId: id, usuarioId: user.id, description: 'Cliente frecuente', paraRevisar: false }));
  const nota = (sufijo) => ds.getRepository(Note).findOneByOrFail({ sourceKey: `clasificacion:${id}:${sufijo}` });
  // Una operación que no dice nada queda para revisar: mejor de más que perder un aviso.
  assert.equal((await nota('sin')).paraRevisar, true);
  assert.equal((await nota('info')).paraRevisar, false);
  // Cierres: con el efectivo que coincide la nota es informativa; con diferencia, para revisar.
  await tickets.updateSchedule({ sueldoAutomatico: false });
  const coincide = await openCash(user.id, (await principal()).efectivoDisponible);
  let ctx = await context();
  await shifts.close(coincide.id, user.id, { efectivoContado: ctx.efectivoDisponible, efectivoEsperado: ctx.efectivoDisponible, efectivoParaSiguiente: ctx.efectivoDisponible, observaciones: 'Todo en orden' });
  assert.equal((await ds.getRepository(Note).findOneByOrFail({ sourceKey: `cierre:${coincide.id}` })).paraRevisar, false);
  const falta = await openCash(user.id, (await principal()).efectivoDisponible);
  ctx = await context();
  await shifts.close(falta.id, user.id, { efectivoContado: ctx.efectivoDisponible - 100, efectivoEsperado: ctx.efectivoDisponible, efectivoParaSiguiente: ctx.efectivoDisponible - 100, observaciones: 'Faltan 100' });
  assert.equal((await ds.getRepository(Note).findOneByOrFail({ sourceKey: `cierre:${falta.id}` })).paraRevisar, true);
  // Apertura: sin diferencia, informativa.
  const caja = await principal();
  const abierto = await shifts.open(user.id, { cajaId: caja.id, fondoInicial: caja.efectivoDisponible, cambioAgregado: 0, sesionAnteriorId: caja.pending?.id, motivoApertura: 'Recibí el cambio en monedas' });
  assert.equal((await ds.getRepository(Note).findOneByOrFail({ sourceKey: `apertura:${abierto.cashSessionId}` })).paraRevisar, false);
  ctx = await context();
  await shifts.close(abierto.id, user.id, { efectivoContado: ctx.efectivoDisponible, efectivoEsperado: ctx.efectivoDisponible, efectivoParaSiguiente: ctx.efectivoDisponible });
});

test('avisos: la migración clasifica los automáticos que ya existían', async () => {
  const Note = load('notes/entities/note.entity', 'Note');
  const repo = ds.getRepository(Note);
  const id = require('node:crypto').randomUUID();
  const coincide = await ds.getRepository(Turno).save({ nombre: 'Clasificar', usuarioApertura: user, fondoInicial: 0, estado: 'CERRADO', diferencia: 0 });
  const conDiferencia = await ds.getRepository(Turno).save({ nombre: 'Clasificar', usuarioApertura: user, fondoInicial: 0, estado: 'CERRADO', diferencia: 500 });
  const notas = await repo.save([
    { description: 'Equipo', user },
    { description: 'Descuento', user, sourceKey: `mig:${id}:descuento`, origin: 'Descuento de vehículo', sourceType: 'TICKET' },
    { description: 'Comentario', user, sourceKey: `mig:${id}:comentario`, origin: 'Comentario de inquilino', sourceType: 'INQUILINO' },
    { description: 'Patente', user, sourceKey: `mig:${id}:patente`, origin: 'Entrada con patente ya activa', sourceType: 'TICKET' },
    { description: 'Coincide', user, sourceKey: `cierre:${coincide.id}`, origin: 'Cierre de turno', sourceType: 'TURNO' },
    { description: 'Faltante', user, sourceKey: `cierre:${conDiferencia.id}`, origin: 'Cierre de turno', sourceType: 'TURNO' },
  ]);
  const Migracion = load('database/migrations/1790000055000-avisos-para-revisar', 'AvisosParaRevisar1790000055000');
  const runner = ds.createQueryRunner();
  try { await new Migracion().up(runner); await new Migracion().up(runner); } finally { await runner.release(); }
  const clasificadas = await repo.findBy(notas.map(n => ({ id: n.id })));
  const por = Object.fromEntries(clasificadas.map(n => [n.description, n.paraRevisar]));
  assert.deepEqual(por, { Equipo: true, Descuento: false, Comentario: false, Patente: true, Coincide: false, Faltante: true });
});
