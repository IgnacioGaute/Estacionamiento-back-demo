// Ejecutar después de pnpm build. PostgreSQL efímero: nunca lee .env ni usa la base del proyecto.
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
  await tickets.updateSchedule({ dayStartHour: 8, dayEndHour: 20, graceMinutes: 5, pricingDayTypeBasis: 'ENTRY' });
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

test('recibo real: crea la primera caja sin bloquearse y separa efectivo, transferencia y cheque', { timeout: 15000 }, async () => {
  const Customer = load('customers/entities/customer.entity', 'Customer');
  const Receipt = load('receipts/entities/receipt.entity', 'Receipt');
  const ReceiptPayment = load('receipts/entities/receipt-payment.entity', 'ReceiptPayment');
  const History = load('receipts/entities/payment-history-on-account.entity', 'PaymentHistoryOnAccount');
  const ReceiptsService = load('receipts/receipts.service', 'ReceiptsService');
  const service = new ReceiptsService(ds.getRepository(Receipt), ds.getRepository(Customer), ds.getRepository(ReceiptPayment), ds.getRepository(History), ds.getRepository(Movimiento), boxes, ds);
  const customer = await ds.getRepository(Customer).save({ firstName: 'Cash', lastName: 'Test', customerType: 'OWNER', numberOfVehicles: 1 });
  const today = dayjs().tz('America/Argentina/Buenos_Aires').format('YYYY-MM-DD');
  const receipt = await ds.getRepository(Receipt).save({ customer, status: 'PENDING', price: 1500, startAmount: 1500, startDate: today, dateNow: today, receiptTypeKey: 'OWNER' });
  const before = await totalBox();
  await service.updateReceipt(receipt.id, customer.id, { onAccount: false, payments: [
    { paymentType: 'CASH', price: 500 }, { paymentType: 'TRANSFER', price: 600 }, { paymentType: 'CHECK', price: 400 },
  ] });
  assert.equal(await totalBox(), before + 500);
  assert.equal(await ds.getRepository(ReceiptPayment).count({ where: { receipt: { id: receipt.id } } }), 3);
  assert.equal((await ds.getRepository(Receipt).findOneBy({ id: receipt.id })).status, 'PAID');
});

test('tarjeta física: segundo escaneo prepara el cobro y usa el mismo libro que patente', async () => {
  const ticket = await tickets.create({ codeBar: '12345678901', vehicleType: 'AUTO' });
  const first = await scanner.start({ barCode: ticket.codeBar });
  assert.equal(first.requiresClose, false);
  await age({ id: first.registrationId });
  const second = await scanner.start({ barCode: ticket.codeBar });
  assert.equal(second.requiresClose, true);
  assert.equal(second.registrationId, first.registrationId);
  const before = await totalBox();
  await tickets.closeRegistrationByPlate(first.registrationId, await payload(first.registrationId), user.id);
  assert.equal(await movements.sumByRegistration(first.registrationId), 1000);
  assert.equal(await totalBox(), before + 1000);
  const registration = await ds.getRepository(Registration).findOne({ where: { id: first.registrationId }, relations: ['ticket'] });
  assert.equal(registration.ticket, null);
  assert.equal(registration.entryMode, 'BARCODE');
  assert.equal(registration.vehicleType, 'AUTO');
  assert.equal(registration.codeBarTicket, ticket.codeBar);
});

test('dos cierres simultáneos cobran una sola vez', async () => {
  const registration = await openPlate();
  const dto = await payload(registration.id);
  const before = await totalBox();
  await Promise.all([tickets.closeRegistrationByPlate(registration.id, dto, user.id), tickets.closeRegistrationByPlate(registration.id, dto, user.id)]);
  assert.equal(await ds.getRepository(Movimiento).count({ where: { ticketRegistration: { id: registration.id } } }), 1);
  assert.equal(await totalBox(), before + 1000);
});

test('cierres de tickets diferentes no pierden incrementos de caja', async () => {
  const registrations = await Promise.all([openPlate(), openPlate(), openPlate()]);
  const before = await totalBox();
  const dtos = await Promise.all(registrations.map(r => payload(r.id)));
  await Promise.all(registrations.map((r, i) => tickets.closeRegistrationByPlate(r.id, dtos[i], user.id)));
  assert.equal(await totalBox(), before + 3000);
});

test('un fallo de caja revierte el movimiento y mantiene el ticket abierto', async () => {
  const registration = await openPlate();
  const dto = await payload(registration.id);
  const original = boxes.applyTicketPayment;
  boxes.applyTicketPayment = async () => { throw new Error('Fallo simulado'); };
  try { await assert.rejects(tickets.closeRegistrationByPlate(registration.id, dto, user.id), /Fallo simulado/); }
  finally { boxes.applyTicketPayment = original; }
  assert.equal(await movements.sumByRegistration(registration.id), 0);
  assert.equal((await ds.getRepository(Registration).findOneBy({ id: registration.id })).departureTime, null);
});

test('anticipo absoluto repetido es idempotente y su reducción registra devolución con motivo', async () => {
  const registration = await openPlate();
  const before = await totalBox();
  await Promise.all([1, 2].map(() => tickets.addAdvancePayment(registration.id, { advancePaidAmount: 800, metodo: 'CASH' }, user.id)));
  assert.equal(await movements.sumByRegistration(registration.id), 800);
  await assert.rejects(tickets.addAdvancePayment(registration.id, { advancePaidAmount: 500, metodo: 'CASH' }, user.id));
  await tickets.addAdvancePayment(registration.id, { advancePaidAmount: 500, metodo: 'CASH', adjustmentReason: 'Corrección acordada' }, user.id);
  assert.equal(await movements.sumByRegistration(registration.id), 500);
  await tickets.closeRegistrationByPlate(registration.id, await payload(registration.id), user.id);
  assert.equal(await movements.sumByRegistration(registration.id), 1000);
  assert.equal(await totalBox(), before + 1000);
});

test('excedente: no cierra sin confirmar devolución y registra ajuste negativo', async () => {
  const registration = await openPlate();
  await tickets.addAdvancePayment(registration.id, { advancePaidAmount: 1500, metodo: 'TRANSFER' }, user.id);
  const dto = await payload(registration.id, { closeType: 'NO_CHARGE' });
  await assert.rejects(tickets.closeRegistrationByPlate(registration.id, dto, user.id));
  await tickets.closeRegistrationByPlate(registration.id, { ...dto, refundMetodo: 'TRANSFER' }, user.id);
  assert.equal(await movements.sumByRegistration(registration.id), 1000);
});

test('cortesía no suma efectivo ni cobros del ticket', async () => {
  const shift = await shifts.open(user.id, { fondoInicial: 200 });
  const registration = await openPlate();
  const before = await totalBox();
  await tickets.closeRegistrationByPlate(registration.id, await payload(registration.id, { closeType: 'COURTESY', motivo: 'Invitado' }), user.id);
  assert.equal(await movements.sumByRegistration(registration.id), 0);
  assert.equal(await totalBox(), before);
  const closed = await shifts.close(shift.id, user.id, { efectivoContado: 200, efectivoEsperado: 200 });
  assert.equal(closed.efectivoTeorico, 200);
  assert.equal(closed.diferencia, 0);
  await shifts.open(user.id, { fondoInicial: 0, turnoAnteriorId: closed.id });
});

test('control de patente simultánea admite una sola entrada salvo excepción explícita', async () => {
  const dto = { vehicleType: 'AUTO', licensePlate: 'DUP123' };
  const results = await Promise.allSettled([tickets.createRegistrationByPlate(dto), tickets.createRegistrationByPlate(dto)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await tickets.createRegistrationByPlate({ ...dto, duplicateOverride: true, duplicateOverrideReason: 'Patente provisoria compartida' });
});

test('cambio de tarifas no altera una estadía abierta', async () => {
  const registration = await openPlate();
  const bracket = await ds.getRepository(Bracket).findOneBy({ label: 'Hora' });
  await tickets.updatePriceBracket(bracket.id, { price: 1800 });
  assert.equal((await tickets.getCloseSummary(registration.id)).previewBracket.price, 1000);
  const newRegistration = await openPlate();
  assert.equal((await tickets.getCloseSummary(newRegistration.id)).previewBracket.price, 1800);
  await tickets.updatePriceBracket(bracket.id, { price: 1000 });
});

test('importe desactualizado exige volver a confirmar sin cobrar', async () => {
  const registration = await openPlate();
  const dto = await payload(registration.id);
  await age(registration, 80);
  await assert.rejects(tickets.closeRegistrationByPlate(registration.id, dto, user.id));
  assert.equal(await movements.sumByRegistration(registration.id), 0);
});

test('saldo histórico se conserva sin inventar movimientos y admite ajustes posteriores', async () => {
  const registration = await openPlate();
  await ds.getRepository(Registration).update(registration.id, { pricingSnapshot: null, advancePaidAmount: 800 });
  assert.equal((await tickets.getCloseSummary(registration.id)).totalCollectedSoFar, 800);
  await tickets.addAdvancePayment(registration.id, { advancePaidAmount: 600, metodo: 'CASH', adjustmentReason: 'Devolución histórica' }, user.id);
  assert.equal((await tickets.getCloseSummary(registration.id)).totalCollectedSoFar, 600);
  await tickets.addAdvancePayment(registration.id, { advancePaidAmount: 700, metodo: 'CASH' }, user.id);
  assert.equal((await tickets.getCloseSummary(registration.id)).totalCollectedSoFar, 700);
});

test('horario de entrada y salida son explícitos y se conservan en la estadía', async () => {
  const registration = await openPlate();
  const saved = await ds.getRepository(Registration).findOneBy({ id: registration.id });
  const snapshot = saved.pricingSnapshot;
  const nowHour = dayjs().tz('America/Argentina/Buenos_Aires').hour();
  snapshot.schedule.dayStartHour = nowHour;
  snapshot.schedule.dayEndHour = (nowHour + 1) % 24;
  snapshot.schedule.pricingDayTypeBasis = 'ENTRY';
  await ds.getRepository(Registration).update(saved.id, { pricingSnapshot: snapshot, entryDay: dayjs().subtract(1, 'day').format('YYYY-MM-DD'), entryTime: ((nowHour + 12) % 24).toString().padStart(2, '0') + ':00:00' });
  assert.equal((await tickets.getCloseSummary(saved.id)).pricingDayType, 'NIGHT');
  snapshot.schedule.pricingDayTypeBasis = 'EXIT';
  await ds.getRepository(Registration).update(saved.id, { pricingSnapshot: snapshot });
  assert.equal((await tickets.getCloseSummary(saved.id)).pricingDayType, 'DAY');
});


test('la planilla conserva el anticipo en su día aunque la estadía se cierre después', async () => {
  const registration = await openPlate();
  await tickets.addAdvancePayment(registration.id, { advancePaidAmount: 800, metodo: 'CASH' }, user.id);
  const yesterday = dayjs().tz('America/Argentina/Buenos_Aires').subtract(1, 'day').startOf('day').add(12, 'hour');
  await ds.getRepository(Movimiento).update({ ticketRegistration: { id: registration.id } }, { fechaHora: yesterday.toDate() });
  await boxes.createBox({ date: yesterday.format('YYYY-MM-DD'), totalPrice: 800 });
  await tickets.closeRegistrationByPlate(registration.id, await payload(registration.id), user.id);
  const prior = await boxes.findBoxByDate(yesterday.format('YYYY-MM-DD'));
  const today = await boxes.findBoxByDate(dayjs().tz('America/Argentina/Buenos_Aires').format('YYYY-MM-DD'));
  assert.equal(prior.ticketMovements.filter(m => m.ticketRegistration.id === registration.id).reduce((n, m) => n + m.monto, 0), 800);
  assert.equal(today.ticketMovements.filter(m => m.ticketRegistration.id === registration.id).reduce((n, m) => n + m.monto, 0), 200);
});

test('anticipo de ficha física conserva la relación del ticket en la respuesta', async () => {
  const ticket = await tickets.create({ codeBar: 'ADVANCE-CARD', vehicleType: 'AUTO' });
  const opened = await scanner.start({ barCode: ticket.codeBar });
  const updated = await tickets.addAdvancePayment(opened.registrationId, { advancePaidAmount: 100, metodo: 'CASH' }, user.id);
  assert.equal(updated.ticket.id, ticket.id);
});


async function closeCurrent(carry = 0, operator = user.id) {
  const ctx = await shifts.getCashContext();
  return shifts.close(ctx.active.id, operator, { efectivoContado: ctx.efectivoDisponible, efectivoEsperado: ctx.efectivoDisponible, efectivoParaSiguiente: carry });
}

test('caja compartida: un turno de 24 h admite varias fechas y sólo suma efectivo', async () => {
  const prior = await closeCurrent();
  const shift = await shifts.open(user.id, { fondoInicial: 100, turnoAnteriorId: prior.id, nombre: 'Diario', duracionPrevistaHoras: 24 });
  await ds.getRepository(Turno).update(shift.id, { fechaApertura: dayjs().subtract(23, 'hour').toDate() });
  const cash = await openPlate();
  const transfer = await openPlate();
  const before = await totalBox();
  await tickets.closeRegistrationByPlate(cash.id, await payload(cash.id), user.id);
  await tickets.closeRegistrationByPlate(transfer.id, await payload(transfer.id, { metodo: 'TRANSFER' }), user.id);
  await boxes.createOtherPayment({ description: 'Gasto', type: 'EGRESOS', paymentMethod: 'CASH', price: 200 });
  await boxes.createOtherPayment({ description: 'Banco', type: 'INGRESOS', paymentMethod: 'TRANSFER', price: 900 });
  assert.equal(await totalBox(), before + 800);
  const ctx = await shifts.getCashContext();
  assert.equal(ctx.active.id, shift.id);
  assert.equal(ctx.efectivoDisponible, 900);
});

test('abonos: transferencia no entra al efectivo y cambiar de medio registra sólo la diferencia', async () => {
  await ds.getRepository(TicketPrice).save({ vehicleType: 'AUTO', ticketTimeType: 'DIA', ticketTimePrice: 500 });
  const before = (await shifts.getCashContext()).efectivoDisponible;
  const dto = { vehicleType: 'AUTO', ticketTimeType: 'DIA', days: 1, lastNameCustomer: 'Test', paid: true };
  const abono = await tickets.createRegistrationForDay({ ...dto, paymentMetodo: 'TRANSFER' });
  assert.equal((await shifts.getCashContext()).efectivoDisponible, before);
  await tickets.updateTicketStatus(abono.id, { paymentMetodo: 'CASH' });
  assert.equal((await shifts.getCashContext()).efectivoDisponible, before + 500);
  await tickets.updateTicketStatus(abono.id, { retired: true });
  assert.equal((await shifts.getCashContext()).efectivoDisponible, before + 500);
  await tickets.removeRegistrationForDay(abono.id);
  assert.equal((await shifts.getCashContext()).efectivoDisponible, before);
});

test('relevo: retiro parcial, recepción única y tres turnos en el mismo día', async () => {
  const secondUser = await ds.getRepository(User).save({ username: 'second', firstName: 'Second', lastName: 'Operator', email: 'second@example.test', role: 'USER' });
  const ctx = await shifts.getCashContext();
  await assert.rejects(shifts.close(ctx.active.id, secondUser.id, { efectivoContado: 900, efectivoEsperado: 900 }), /responsable/);
  await assert.rejects(shifts.open(secondUser.id, { fondoInicial: 0 }), /turno abierto/);
  await assert.rejects(shifts.close(ctx.active.id, user.id, { efectivoContado: 900, efectivoParaSiguiente: 1000, efectivoEsperado: 900 }), /más efectivo/);
  const first = await closeCurrent(300);
  assert.equal(first.efectivoRetirado, 600);
  assert.equal((await shifts.getCashContext()).efectivoDisponible, 300);
  const before = await totalBox();
  await assert.rejects(shifts.open(secondUser.id, { fondoInicial: 200, turnoAnteriorId: first.id }), /menor/);
  const results = await Promise.allSettled([1, 2].map(() => shifts.open(secondUser.id, { fondoInicial: 300, turnoAnteriorId: first.id, nombre: 'Tarde', duracionPrevistaHoras: 8 })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const second = results.find(r => r.status === 'fulfilled').value;
  assert.equal(second.fondoRecibido, 300);
  assert.equal(await totalBox(), before); // El fondo recibido no es una venta.
  assert.equal((await ds.getRepository(Turno).findOneBy({ id: first.id })).recibidoPorTurnoId, second.id);
  const closedSecond = await closeCurrent(0, secondUser.id);
  assert.equal(closedSecond.efectivoRetirado, 300);
  const third = await shifts.open(user.id, { fondoInicial: 0, turnoAnteriorId: closedSecond.id, nombre: 'Noche', duracionPrevistaHoras: 8 });
  assert.equal(third.fondoRecibido, 0);
  assert.equal((await shifts.getCashContext()).efectivoDisponible, 0);
});

test('cierre detecta cobros nuevos, exige motivo por diferencias y bloquea efectivo entre relevos', async () => {
  const ctx = await shifts.getCashContext();
  const registration = await openPlate();
  await tickets.addAdvancePayment(registration.id, { advancePaidAmount: 100, metodo: 'CASH' }, user.id);
  await assert.rejects(shifts.close(ctx.active.id, user.id, { efectivoContado: 0, efectivoEsperado: 0 }), /cambió/);
  await assert.rejects(shifts.close(ctx.active.id, user.id, { efectivoContado: 90, efectivoEsperado: 100 }), /diferencia/);
  const closed = await shifts.close(ctx.active.id, user.id, { efectivoContado: 90, efectivoEsperado: 100, efectivoParaSiguiente: 20, observaciones: 'Faltante contado' });
  assert.equal(closed.diferencia, 10);
  assert.equal(closed.efectivoRetirado, 70);
  const before = await totalBox();
  await assert.rejects(tickets.addAdvancePayment(registration.id, { advancePaidAmount: 200, metodo: 'CASH' }, user.id), /siguiente turno/);
  assert.equal(await movements.sumByRegistration(registration.id), 100);
  assert.equal(await totalBox(), before);
  await assert.rejects(shifts.close(closed.id, user.id, { efectivoContado: 90, efectivoEsperado: 100 }), /cerrado/);
  await shifts.open(user.id, { fondoInicial: 20, turnoAnteriorId: closed.id });
});

test('recibos y ajustes centrales participan del arqueo y revierten junto con su transacción', async () => {
  const date = dayjs().tz('America/Argentina/Buenos_Aires').format('YYYY-MM-DD');
  const before = (await shifts.getCashContext()).efectivoDisponible;
  await ds.transaction(async manager => {
    const box = await boxes.findBoxByDate(date, manager);
    await boxes.updateBox(box.id, { totalPrice: box.totalPrice + 700 }, manager);
  });
  assert.equal((await shifts.getCashContext()).efectivoDisponible, before + 700);
  await assert.rejects(ds.transaction(async manager => {
    await boxes.createBox({ date, totalPrice: 800 }, manager);
    throw new Error('Fallo del recibo');
  }), /Fallo/);
  assert.equal((await shifts.getCashContext()).efectivoDisponible, before + 700);
});


test('un cierre anterior al modelo compartido puede entregar fondo sin recalcular su historia', async () => {
  const prior = await closeCurrent(0);
  // Consumir el relevo pendiente y cerrar su sucesor deja una cadena completa.
  await shifts.open(user.id, { fondoInicial: 0, turnoAnteriorId: prior.id });
  const zero = await closeCurrent(0);
  const legacy = await ds.getRepository(Turno).save({ usuarioApertura: user, fondoInicial: 50, estado: 'ABIERTO', cashVersion: 1, turnoAnteriorId: zero.id });
  await ds.getRepository(Turno).update(zero.id, { recibidoPorTurnoId: legacy.id });
  const closed = await shifts.close(legacy.id, user.id, { efectivoContado: 50, efectivoParaSiguiente: 20 });
  assert.equal(closed.efectivoTeorico, 50);
  const ctx = await shifts.getCashContext();
  assert.equal(ctx.pending.id, legacy.id);
  const received = await shifts.open(user.id, { fondoInicial: 20, turnoAnteriorId: legacy.id });
  assert.equal(received.fondoRecibido, 20);
});

test('un admin cierra el turno de otro operador y queda registrado el motivo', async () => {
  const ausente = await ds.getRepository(User).save({ username: 'ausente', firstName: 'Ope', lastName: 'Ausente', email: 'ausente@example.test', role: 'USER' });
  const previo = await closeCurrent(0);
  const abandonado = await shifts.open(ausente.id, { fondoInicial: 0, turnoAnteriorId: previo.id, nombre: 'Tarde' });
  const ctx = await shifts.getCashContext();
  const arqueo = { efectivoContado: ctx.efectivoDisponible, efectivoEsperado: ctx.efectivoDisponible };
  // Sin rol de admin sigue valiendo la regla anterior: sólo cierra su responsable.
  await assert.rejects(shifts.close(abandonado.id, user.id, arqueo), /responsable/);
  // Un admin tampoco puede cerrarlo en silencio: el motivo es obligatorio.
  await assert.rejects(shifts.close(abandonado.id, user.id, arqueo, 'ADMIN'), /otro operador/);
  const forzado = await shifts.close(abandonado.id, user.id, { ...arqueo, motivoCierreForzado: 'Se retiró sin cerrar la caja' }, 'ADMIN');
  assert.equal(forzado.cierreForzado, true);
  assert.equal(forzado.motivoCierreForzado, 'Se retiró sin cerrar la caja');
  assert.equal(forzado.usuarioCierre.id, user.id);
  assert.equal(forzado.efectivoTeorico, ctx.efectivoDisponible);
  // Cerrar el propio turno no cuenta como forzado, aunque quien cierre sea admin.
  const propio = await shifts.open(user.id, { fondoInicial: 0, turnoAnteriorId: forzado.id });
  const normal = await shifts.close(propio.id, user.id, { efectivoContado: 0, efectivoEsperado: 0 }, 'ADMIN');
  assert.equal(normal.cierreForzado, false);
  assert.equal(normal.motivoCierreForzado, null);
});

test('un turno de varios días figura en la planilla de cada día con su parte del efectivo', async () => {
  const hoy = dayjs().tz('America/Argentina/Buenos_Aires').format('YYYY-MM-DD');
  const manana = dayjs().tz('America/Argentina/Buenos_Aires').add(1, 'day').format('YYYY-MM-DD');
  const previo = await shifts.getCashContext();
  const turno = await shifts.open(user.id, { fondoInicial: 0, turnoAnteriorId: previo.pending ? previo.pending.id : undefined, nombre: 'Diario', duracionPrevistaHoras: 24 });

  // El mismo turno mueve efectivo en dos fechas distintas: dos planillas, un solo turno.
  await ds.transaction(m => boxes.createBox({ date: hoy, totalPrice: 500 }, m));
  await ds.transaction(m => boxes.createBox({ date: manana, totalPrice: 900 }, m));

  const filaDe = (box) => box.turnosDelDia.find(t => t.turnoId === turno.id);
  const boxHoy = await boxes.findBoxByDate(hoy);
  const boxManana = await boxes.findBoxByDate(manana);

  assert.ok(filaDe(boxHoy), 'el turno debe figurar en la planilla de hoy');
  assert.ok(filaDe(boxManana), 'el mismo turno debe figurar en la planilla del día siguiente');
  // Cada planilla ve sólo el efectivo que cayó en su día, no el arqueo entero del turno.
  assert.equal(filaDe(boxManana).efectivoDelDia, 900);
  assert.equal(filaDe(boxManana).turno.id, turno.id);
  assert.equal(filaDe(boxManana).movimientos, 1);
  // Sigue abierto, así que su arqueo todavía no pertenece a ningún día cerrado.
  assert.equal(filaDe(boxManana).abarcaOtrosDias, true);
  // El efectivo previo a la caja por turnos queda en su propia fila, sin turno.
  assert.ok(boxHoy.turnosDelDia.every(t => t.turnoId !== undefined));
});


test('migración conserva valores anteriores y permite vehículos nuevos en las cinco tablas', async () => {
  const runner = ds.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    await runner.query('CREATE SCHEMA vehicle_migration_test');
    await runner.query('SET LOCAL search_path TO vehicle_migration_test');
    await runner.query("CREATE TYPE legacy_vehicle AS ENUM ('AUTO', 'CAMIONETA')");
    const tables = ['tickets', 'tickets-price', 'ticket_price_brackets', 'ticket_registrations', 'ticket_registration_for_days'];
    for (const table of tables) {
      await runner.query(`CREATE TABLE "${table}" (id integer, "vehicleType" legacy_vehicle)`);
      await runner.query(`INSERT INTO "${table}" VALUES (1, 'AUTO'), (2, 'CAMIONETA'), (3, NULL)`);
    }
    const Migration = load('database/migrations/1790000000000-flexible-vehicle-types', 'FlexibleVehicleTypes1790000000000');
    await new Migration().up(runner);
    for (const table of tables) {
      assert.deepEqual((await runner.query(`SELECT "vehicleType" FROM "${table}" ORDER BY id`)).map(r => r.vehicleType), ['AUTO', 'CAMIONETA', null]);
      await runner.query(`INSERT INTO "${table}" VALUES (4, 'MOTO')`);
    }
    assert.equal((await runner.query('SELECT * FROM ticket_vehicle_types')).length, 2);
  } finally { await runner.rollbackTransaction(); await runner.release(); }
});

test('simular opciones sin guardar no cambia tarifas, registros ni caja', async () => {
  const before = await tickets.getSchedule();
  const count = await ds.getRepository(Registration).count();
  const cash = await totalBox();
  const options = load('tickets/pricing/pricing.types', 'defaultPricingOptions')();
  options.charging = { enabled: true, mode: 'PROPORTIONAL', unitMinutes: 60, rates: [{ vehicleType: 'AUTO', dayPrice: 600, nightPrice: 1200 }] };
  options.crossing = { enabled: true, mode: 'SPLIT' };
  const result = await tickets.previewPrice('AUTO', 'DAY', 137, '2026-09-18T19:30:00-03:00', options);
  assert.equal(result.price, 2440);
  assert.equal(result.breakdown.reduce((n, line) => n + line.amount, 0), result.price);
  assert.deepEqual((await tickets.getSchedule()).pricingOptions, before.pricingOptions);
  assert.equal(await ds.getRepository(Registration).count(), count);
  assert.equal(await totalBox(), cash);
});

test('vehículo nuevo: patente y ticket físico conservan sus reglas al cambiar precios o desactivarlo', async () => {
  const before = await tickets.getSchedule();
  await tickets.createVehicleType({ code: 'MOTO', name: 'Moto' });
  const options = load('tickets/pricing/pricing.types', 'defaultPricingOptions')();
  options.charging = { enabled: true, mode: 'STARTED', unitMinutes: 60, rates: ['AUTO', 'CAMIONETA', 'MOTO'].map(vehicleType => ({ vehicleType, dayPrice: 700, nightPrice: 700 })) };
  await tickets.updateSchedule({ pricingOptions: options });
  const plate = await age(await tickets.createRegistrationByPlate({ vehicleType: 'MOTO', licensePlate: 'MOTO123' }));
  const physical = await tickets.create({ codeBar: '98765432101', vehicleType: 'MOTO' });
  const first = await scanner.start({ barCode: physical.codeBar });
  await age({ id: first.registrationId });
  options.charging.rates.forEach(rate => { rate.dayPrice = 900; rate.nightPrice = 900; });
  await tickets.updateSchedule({ pricingOptions: options });
  await tickets.updateVehicleType('MOTO', { name: 'Motocicleta', enabled: false });
  await assert.rejects(tickets.createRegistrationByPlate({ vehicleType: 'MOTO', licensePlate: 'MOTO456' }), /desactivado/);
  const second = await scanner.start({ barCode: physical.codeBar });
  assert.equal(second.requiresClose, true);
  for (const id of [plate.id, first.registrationId]) {
    const dto = await payload(id);
    assert.equal(dto.expectedPrice, 700);
    await tickets.closeRegistrationByPlate(id, dto, user.id);
    const saved = await ds.getRepository(Registration).findOneBy({ id });
    assert.equal(saved.vehicleType, 'MOTO');
    assert.equal(saved.pricingBreakdown.reduce((n, line) => n + line.amount, 0), 700);
  }
  await tickets.updateSchedule({ pricingOptions: before.pricingOptions });
});


test('un administrador puede cerrar con motivo el turno de un operador dado de baja', async () => {
  const operator = await ds.getRepository(User).save({ username: 'retired', firstName: 'Retired', lastName: 'Operator', email: 'retired@example.test', role: 'USER' });
  const turno = await ds.getRepository(Turno).save({ usuarioApertura: { id: operator.id }, fondoInicial: 500, cashVersion: 2, estado: 'ABIERTO' });
  await ds.getRepository(User).softDelete(operator.id);
  const dto = { efectivoContado: 500, efectivoEsperado: 500, efectivoParaSiguiente: 200 };
  await assert.rejects(shifts.close(turno.id, user.id, dto, 'USER'), /operador responsable/);
  await assert.rejects(shifts.close(turno.id, user.id, dto, 'ADMIN'), /por qué/);
  const closed = await shifts.close(turno.id, user.id, { ...dto, motivoCierreForzado: 'El operador fue dado de baja' }, 'ADMIN');
  assert.equal(closed.estado, 'CERRADO');
  assert.equal(closed.cierreForzado, true);
  assert.equal(closed.efectivoRetirado, 300);
  assert.equal(closed.efectivoParaSiguiente, 200);
});

test('permanencia retirada: se desactiva para nuevas entradas y respeta copias anteriores', async () => {
  const options = load('tickets/pricing/pricing.types', 'defaultPricingOptions')();
  options.stay.enabled = true;
  options.stay.freeMinutes = 40;
  const before = await tickets.previewPrice('AUTO', 'DAY', 30, '2026-09-18T10:00:00-03:00');
  await tickets.updateSchedule({ pricingOptions: options });
  assert.equal((await tickets.getSchedule()).pricingOptions.stay.enabled, false);
  const [stored] = await ds.getRepository(Schedule).find({ order: { updatedAt: 'DESC' }, take: 1 });
  assert.equal(stored.pricingOptions.stay.enabled, false);
  const current = await tickets.previewPrice('AUTO', 'DAY', 30, '2026-09-18T10:00:00-03:00', options);
  assert.equal(current.price, before.price);
  const fresh = await openPlate();
  assert.equal(fresh.pricingSnapshot.schedule.pricingOptions.stay.enabled, false);
  const historical = JSON.parse(JSON.stringify(fresh.pricingSnapshot));
  historical.schedule.pricingOptions.stay.enabled = true;
  historical.schedule.pricingOptions.stay.freeMinutes = 40;
  await ds.getRepository(Registration).update(fresh.id, { pricingSnapshot: historical });
  const summary = await tickets.getCloseSummary(fresh.id);
  assert.equal(summary.previewBracket.price, 0);
});
