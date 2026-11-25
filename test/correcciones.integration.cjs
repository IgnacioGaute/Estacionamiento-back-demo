// Ejecutar después de pnpm build. PostgreSQL efímero: nunca lee .env ni usa la base del proyecto.
// Correcciones de registros y el historial de movimientos (docs/correcciones.md).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
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
const CashEntry = load('turnos/entities/cash-entry.entity', 'CashEntry');
const Box = load('box-lists/entities/box-list.entity', 'BoxList');
const Other = load('box-lists/entities/other-payment.entity', 'OtherPayment');
const User = load('users/entities/user.entity', 'User');
const Empresa = load('tenancy/entities/empresa.entity', 'Empresa');
const Correccion = load('operaciones/entities/correccion.entity', 'Correccion');
const TransferenciaRecibida = load('mercadopago/entities/transferencia-recibida.entity', 'TransferenciaRecibida');
const CobroTransferencia = load('mercadopago/entities/cobro-transferencia.entity', 'CobroTransferencia');
const Playa = load('tenancy/entities/playa.entity', 'Playa');
const TicketsService = load('tickets/tickets.service', 'TicketsService');
const TurnosService = load('turnos/turnos.service', 'TurnosService');
const MovimientosService = load('movimientos/movimientos.service', 'MovimientosService');
const BoxListsService = load('box-lists/box-lists.service', 'BoxListsService');
const CorreccionesService = load('operaciones/correcciones.service', 'CorreccionesService');
const HistorialService = load('operaciones/historial.service', 'HistorialService');
const PanelService = load('operaciones/panel.service', 'PanelService');
const VerificacionAliasService = load('mercadopago/verificacion-alias.service', 'VerificacionAliasService');
const { shiftSummary } = require('../dist/turnos/turno-book');
const { tenantContext } = require('../dist/tenancy/tenant-context');
const { billetes } = require('./mostrador.cjs');

let ds, root, pgStarted = false, tickets, shifts, boxes, correcciones, conMp, historial, empresa, admin, ana, beto, counter = 0;
const bin = process.env.PG_TEST_BIN || 'C:/Program Files/PostgreSQL/18/bin';
const pg = (name, args) => {
  const output = fs.openSync(path.join(root, 'commands.log'), 'a');
  try { return execFileSync(path.join(bin, name + (process.platform === 'win32' ? '.exe' : '')), args, { windowsHide: true, stdio: ['ignore', output, output], timeout: 30000 }); }
  finally { fs.closeSync(output); }
};
const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const repo = (e) => ds.getRepository(e);
const como = (u, fn) => tenantContext.run({ userId: u.id, role: u.role, empresaId: empresa.id }, fn);
const actor = (u) => ({ usuarioId: u.id, rol: u.role });
const codigo = (code) => (e) => e.response?.code === code;
const hoy = () => dayjs().tz('America/Argentina/Buenos_Aires').format('YYYY-MM-DD');

// La verificación de transferencias, sin Mercado Pago: cada operación se puede usar una sola vez.
const usadas = new Set();
const verificacionFalsa = {
  async candidatasParaCorreccion() { return { disponible: true, motivo: null, opciones: [] }; },
  async usarEnCorreccion(_m, operacionId) {
    if (usadas.has(operacionId)) { const { ConflictException } = require('@nestjs/common'); throw new ConflictException({ code: 'TRANSFERENCIA_USADA', message: 'usada' }); }
    usadas.add(operacionId);
    return { transferenciaId: randomUUID(), operacionId, paymentTypeId: 'bank_transfer' };
  },
};

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-pg-test-'));
  pg('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--locale=C']);
  const port = await freePort();
  pgStarted = true;
  pg('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'postgres.log'), '-o', '-h 127.0.0.1 -p ' + port + ' -F', '-w', 'start']);
  ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: 'postgres', entities: [path.resolve('dist/**/*.entity.js')], migrations: [load('database/migrations/1790000000000-flexible-vehicle-types', 'FlexibleVehicleTypes1790000000000')], migrationsRun: true, synchronize: true });
  await ds.initialize();
  await ds.query('ALTER TABLE ticket_schedule_settings ALTER COLUMN "sinCobroEnTolerancia" SET DEFAULT false');
  shifts = new TurnosService(repo(Turno), repo(Movimiento), ds);
  const movements = new MovimientosService(repo(Movimiento), shifts);
  boxes = new BoxListsService(repo(Box), repo(Other), ds);
  tickets = new TicketsService(repo(Ticket), repo(TicketPrice), repo(Bracket), repo(Registration), repo(RegistrationDay), repo(Schedule), boxes, { emitNewRegistration() {} }, movements, ds);
  correcciones = new CorreccionesService(ds, movements, boxes, tickets, verificacionFalsa);
  historial = new HistorialService(ds);
  empresa = await repo(Empresa).save({ nombre: 'Empresa correcciones' });
  // La verificación real, con la cuenta de Mercado Pago ya habilitada (sin red): usar una
  // transferencia registrada, una sola vez.
  const alias = new VerificacionAliasService(null, null, repo(TransferenciaRecibida), null, null, tickets, ds, null);
  alias.habilitacion = async () => ({ ok: true, cuenta: { mpUserId: 'mp-1', empresaId: empresa.id } });
  conMp = new CorreccionesService(ds, movements, boxes, tickets, alias);
  admin = await repo(User).save({ username: 'admin', firstName: 'Admi', lastName: 'Nistra', email: 'admin@test.local', role: 'ADMIN' });
  ana = await repo(User).save({ username: 'ana', firstName: 'Ana', lastName: 'Uno', email: 'ana@test.local', role: 'USER' });
  beto = await repo(User).save({ username: 'beto', firstName: 'Beto', lastName: 'Dos', email: 'beto@test.local', role: 'USER' });
  await como(admin, async () => {
    await tickets.updateSchedule({ dayStartHour: 8, dayEndHour: 20, graceMinutes: 5, pricingDayTypeBasis: 'ENTRY', barcodeTicketsEnabled: true, shiftsEnabled: true, multipleShiftsEnabled: true, sinCobroEnTolerancia: false });
    await tickets.createPriceBracket({ vehicleType: 'AUTO', label: 'Hora', uptoMinutes: 60, price: 1000 });
    await tickets.createPriceBracket({ vehicleType: 'AUTO', label: 'Extra', price: 1000, recurringUnitMinutes: 60, recurringPriceMode: 'FIXED' });
  });
  // Ana abre la caja y Beto se suma (caja compartida).
  const ctx = await como(ana, () => shifts.getCashContext(ana.id));
  const caja = ctx.cajas.find(c => c.principal);
  await como(ana, () => shifts.open(ana.id, { cajaId: caja.id, fondoInicial: 0, cambioAgregado: 0 }));
  const abierta = (await como(beto, () => shifts.getCashContext(beto.id))).cajas.find(c => c.principal);
  await como(beto, () => shifts.open(beto.id, { cajaId: abierta.id, fondoInicial: 0, sesionActivaId: abierta.session.id, conteoRelevo: abierta.efectivoDisponible }));
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

async function entrar(u, minutos = 30, plate = 'COR' + (++counter)) {
  const r = await como(u, () => tickets.createRegistrationByPlate({ vehicleType: 'AUTO', licensePlate: plate }, u.id));
  const entry = dayjs().tz('America/Argentina/Buenos_Aires').subtract(minutos, 'minute');
  await repo(Registration).update(r.id, { entryDay: entry.format('YYYY-MM-DD'), entryTime: entry.format('HH:mm:ss') });
  return r;
}
async function cobrar(u, extra = {}, minutos = 30, plate) {
  const r = await entrar(u, minutos, plate);
  const s = await como(u, () => tickets.getCloseSummary(r.id));
  await como(u, () => tickets.closeRegistrationByPlate(r.id, { closeType: 'PAYMENT', metodo: 'CASH', expectedPrice: s.previewBracket.price, expectedCollected: s.totalCollectedSoFar, efectivoRecibido: s.saldoACobrar, ...extra }, u.id));
  const movs = await repo(Movimiento).find({ where: { ticketRegistration: { id: r.id } }, order: { sequence: 'ASC' } });
  return { id: r.id, plate: r.licensePlateOriginal, movs, mov: movs.find(m => m.metodo === 'CASH')?.id };
}
const esperado = async (u) => (await como(u, () => shifts.getCashContext(u.id))).active.efectivoDisponible;
const cajaHoy = async () => Number((await repo(Box).findOneBy({ date: hoy() }))?.totalPrice ?? 0);
const detalle = (u, id) => como(u, () => correcciones.detalleEstadia(id, actor(u)));
const corregir = async (u, id, datos, servicio = correcciones) => {
  const d = await detalle(u, id);
  return como(u, () => servicio.crear({ solicitudId: randomUUID(), registrationId: id, version: d.version, motivo: 'PRUEBA', ...datos }, actor(u)));
};
const turnoDe = async (u) => {
  const activo = (await como(u, () => shifts.getCashContext(u.id))).active;
  return activo ? repo(Turno).findOneBy({ id: activo.id }) : null;
};

test('efectivo → transferencia: sin evidencia queda pendiente sin tocar la caja; con la acreditación se aplica, baja el esperado y el total cobrado sigue igual', async () => {
  const c = await cobrar(ana);
  const antes = { esperado: await esperado(ana), caja: await cajaHoy(), resumen: await shiftSummary(ds.manager, await turnoDe(ana)) };
  const pendiente = await corregir(ana, c.id, { tipo: 'MEDIO_PAGO', movimientoId: c.mov, metodo: 'TRANSFER' });
  assert.equal(pendiente.estado, 'PENDIENTE');
  assert.match(pendiente.efecto.lineas.join(' '), /Sin una transferencia verificada/);
  assert.equal(await esperado(ana), antes.esperado, 'una pendiente no baja el efectivo esperado');
  assert.equal(await repo(Movimiento).countBy({ ticketRegistration: { id: c.id } }), 1);
  // Mientras está pendiente no se puede pedir otra sobre el mismo cobro.
  await assert.rejects(corregir(ana, c.id, { tipo: 'MEDIO_PAGO', movimientoId: c.mov, metodo: 'TRANSFER', operacionId: 'op-1' }), codigo('CORRECCION_PENDIENTE'));
  await como(admin, () => correcciones.resolver(pendiente.id, { accion: 'RECHAZAR', resolucion: 'Se aplica con la acreditación' }, actor(admin)));

  const aplicada = await corregir(ana, c.id, { tipo: 'MEDIO_PAGO', movimientoId: c.mov, metodo: 'TRANSFER', operacionId: 'op-1' });
  assert.equal(aplicada.estado, 'APLICADA');
  assert.equal(aplicada.evidencia.tipo, 'MERCADOPAGO');
  assert.deepEqual(aplicada.efecto.lineas.slice(1, 4), ['Antes: efectivo.', 'Después: transferencia verificada en Mercado Pago.', 'El total cobrado sigue siendo $1.000.']);
  assert.equal(await esperado(ana), antes.esperado - 1000, 'el efectivo esperado de la caja baja');
  assert.equal(await cajaHoy(), antes.caja - 1000, 'la planilla del día refleja el efectivo corregido');
  // El original queda; dos ajustes vinculados lo compensan; el total cobrado no cambia.
  const movs = await repo(Movimiento).find({ where: { ticketRegistration: { id: c.id } }, order: { sequence: 'ASC' } });
  assert.deepEqual(movs.map(m => [m.tipo, m.metodo, m.monto, m.correccionId === aplicada.id]), [['SALDO', 'CASH', 1000, false], ['AJUSTE', 'CASH', -1000, true], ['AJUSTE', 'TRANSFER', 1000, true]]);
  assert.equal(await tickets.collectedAmount(await repo(Registration).findOneBy({ id: c.id })), 1000);
  // El resumen del turno: menos efectivo cobrado, el alias suma lo mismo.
  const resumen = await shiftSummary(ds.manager, await turnoDe(ana));
  assert.equal(resumen.efectivoCobrado, antes.resumen.efectivoCobrado - 1000);
  assert.equal(resumen.mercadoPagoAlias, antes.resumen.mercadoPagoAlias + 1000);

  // Un reintento (doble toque, respuesta perdida) devuelve la misma corrección sin aplicarla de nuevo.
  const d = await detalle(ana, c.id);
  const solicitudId = randomUUID();
  const otro = await cobrar(ana);
  const pedido = { solicitudId, registrationId: otro.id, version: (await detalle(ana, otro.id)).version, motivo: 'PRUEBA', tipo: 'MEDIO_PAGO', movimientoId: otro.mov, metodo: 'TRANSFER', operacionId: 'op-2' };
  const [a, b] = await Promise.all([como(ana, () => correcciones.crear(pedido, actor(ana))), como(ana, () => correcciones.crear(pedido, actor(ana)))]);
  assert.equal(a.id, b.id);
  assert.equal(await repo(Movimiento).countBy({ correccionId: a.id }), 2);
  // Una acreditación ya usada no respalda otro cobro, y no queda nada a medias.
  const tercero = await cobrar(ana);
  const corrAntes = await repo(Correccion).count();
  await assert.rejects(corregir(ana, tercero.id, { tipo: 'MEDIO_PAGO', movimientoId: tercero.mov, metodo: 'TRANSFER', operacionId: 'op-1' }), codigo('TRANSFERENCIA_USADA'));
  assert.equal(await repo(Correccion).count(), corrAntes);
  assert.equal(await repo(Movimiento).countBy({ ticketRegistration: { id: tercero.id } }), 1);
  assert.ok(d.correcciones.length >= 2, 'el detalle conserva la rechazada y la aplicada');
});

test('la acreditación real: se usa una sola vez, con importe y hora del cobro', async () => {
  const ahora = new Date();
  await repo(TransferenciaRecibida).save([
    { empresaId: empresa.id, mpUserId: 'mp-1', operacionId: 'mp-real', importe: 1000, moneda: 'ARS', estadoMp: 'approved', fechaOperacion: ahora },
    { empresaId: empresa.id, mpUserId: 'mp-1', operacionId: 'mp-otro-importe', importe: 1500, moneda: 'ARS', estadoMp: 'approved', fechaOperacion: ahora },
  ]);
  const c = await cobrar(ana);
  await assert.rejects(corregir(ana, c.id, { tipo: 'MEDIO_PAGO', movimientoId: c.mov, metodo: 'TRANSFER', operacionId: 'mp-otro-importe' }, conMp), codigo('TRANSFERENCIA_NO_CORRESPONDE'));
  const ok = await corregir(ana, c.id, { tipo: 'MEDIO_PAGO', movimientoId: c.mov, metodo: 'TRANSFER', operacionId: 'mp-real' }, conMp);
  assert.equal(ok.estado, 'APLICADA');
  const t = await repo(TransferenciaRecibida).findOneBy({ operacionId: 'mp-real' });
  assert.deepEqual([t.estado, t.modo, t.registrationId], ['USADA', 'CORRECCION', c.id]);
  const otro = await cobrar(ana);
  await assert.rejects(corregir(ana, otro.id, { tipo: 'MEDIO_PAGO', movimientoId: otro.mov, metodo: 'TRANSFER', operacionId: 'mp-real' }, conMp), codigo('TRANSFERENCIA_USADA'));

  // Una transferencia que quedó en revisión para un cobro por alias, o con un cobro por alias de ese
  // importe esperando la plata, no respalda una corrección: puede ser de ese cobro.
  await repo(TransferenciaRecibida).save([
    { empresaId: empresa.id, mpUserId: 'mp-1', operacionId: 'mp-en-revision', importe: 1000, moneda: 'ARS', estadoMp: 'approved', fechaOperacion: new Date(), estado: 'REVISION' },
    { empresaId: empresa.id, mpUserId: 'mp-1', operacionId: 'mp-esperada', importe: 1000, moneda: 'ARS', estadoMp: 'approved', fechaOperacion: new Date() },
  ]);
  await assert.rejects(corregir(ana, otro.id, { tipo: 'MEDIO_PAGO', movimientoId: otro.mov, metodo: 'TRANSFER', operacionId: 'mp-en-revision' }, conMp), codigo('TRANSFERENCIA_RESERVADA'));
  const playa = await repo(Playa).save({ nombre: 'Correcciones', empresaId: empresa.id });
  const esperando = await entrar(ana, 30);
  const intento = await repo(CobroTransferencia).save({ empresaId: empresa.id, playaId: playa.id, registrationId: esperando.id, mpUserId: 'mp-1', importe: 1000,
    estado: 'ESPERANDO', buscarDesde: new Date(Date.now() - 60_000), venceEl: new Date(Date.now() + 600_000) });
  await assert.rejects(corregir(ana, otro.id, { tipo: 'MEDIO_PAGO', movimientoId: otro.mov, metodo: 'TRANSFER', operacionId: 'mp-esperada' }, conMp), codigo('TRANSFERENCIA_RESERVADA'));
  await repo(CobroTransferencia).update(intento.id, { estado: 'CANCELADO' });
  assert.equal((await corregir(ana, otro.id, { tipo: 'MEDIO_PAGO', movimientoId: otro.mov, metodo: 'TRANSFER', operacionId: 'mp-esperada' }, conMp)).estado, 'APLICADA');
});

test('buscar transferencias: solo quien puede aplicar la corrección y hasta lo que queda del cobro', async () => {
  const c = await cobrar(ana);
  // Beto no registró ese cobro: la corrección la revisa administración, que busca la transferencia.
  await assert.rejects(como(beto, () => correcciones.transferenciasPara(c.mov, undefined, actor(beto))), codigo('TRANSFERENCIA_LA_BUSCA_ADMINISTRACION'));
  await assert.rejects(como(ana, () => correcciones.transferenciasPara(c.mov, 5000, actor(ana))), codigo('IMPORTE_MAYOR'));
  assert.equal((await como(ana, () => correcciones.transferenciasPara(c.mov, 1000, actor(ana)))).disponible, true);
  assert.equal((await como(admin, () => correcciones.transferenciasPara(c.mov, undefined, actor(admin)))).disponible, true);
});

test('operación de otro operador: queda pendiente y administración la aplica en la caja abierta', async () => {
  const c = await cobrar(ana);
  const antes = await esperado(ana);
  const pedida = await corregir(beto, c.id, { tipo: 'MEDIO_PAGO', movimientoId: c.mov, metodo: 'TRANSFER' });
  assert.equal(pedida.estado, 'PENDIENTE');
  assert.match(pedida.efecto.lineas.join(' '), /otro operador/);
  // Solo administración resuelve.
  await assert.rejects(como(beto, () => correcciones.resolver(pedida.id, { accion: 'APLICAR', resolucion: 'x' }, actor(beto))), /administración/);
  const resuelta = await como(admin, () => correcciones.resolver(pedida.id, { accion: 'APLICAR', resolucion: 'Vi la transferencia en el banco' }, actor(admin)));
  assert.equal(resuelta.estado, 'APLICADA');
  assert.equal(resuelta.evidencia.tipo, 'ADMINISTRACION');
  assert.equal(resuelta.revisadoPorNombre, 'Admi Nistra');
  assert.equal(await esperado(ana), antes - 1000);
  await assert.rejects(como(admin, () => correcciones.resolver(pedida.id, { accion: 'RECHAZAR', resolucion: 'x' }, actor(admin))), codigo('YA_RESUELTA'));
});

test('pago mixto: se corrige la parte equivocada y el resto del cobro queda igual', async () => {
  const c = await cobrar(ana, { metodo: undefined, pagos: [{ metodo: 'CASH', importe: 600 }, { metodo: 'TRANSFER', importe: 400 }], efectivoRecibido: 600 });
  const antes = await esperado(ana);
  const parte = await corregir(ana, c.id, { tipo: 'MEDIO_PAGO', movimientoId: c.mov, metodo: 'TRANSFER', importe: 300, operacionId: 'op-mixto' });
  assert.equal(parte.estado, 'APLICADA');
  assert.equal(await esperado(ana), antes - 300);
  await assert.rejects(corregir(ana, c.id, { tipo: 'MEDIO_PAGO', movimientoId: c.mov, metodo: 'TRANSFER', importe: 400, operacionId: 'op-mixto-2' }), codigo('IMPORTE_MAYOR'));
  const d = await detalle(ana, c.id);
  assert.deepEqual(d.medios, { CASH: 300, TRANSFER: 700 });
  assert.equal(d.cobrado, 1000);
  // Transferencia a mano → efectivo: sube el esperado.
  const transfer = d.pagos.find(p => p.metodo === 'TRANSFER');
  const aEfectivo = await corregir(ana, c.id, { tipo: 'MEDIO_PAGO', movimientoId: transfer.id, metodo: 'CASH' });
  assert.equal(aEfectivo.estado, 'APLICADA');
  assert.equal(await esperado(ana), antes - 300 + 400);
});

test('recibido y vuelto: corrige lo declarado sin tocar la caja ni el libro', async () => {
  const c = await cobrar(ana, { efectivoRecibido: 10000 });
  const antes = { esperado: await esperado(ana), caja: await cajaHoy(), movs: await repo(Movimiento).count() };
  await assert.rejects(corregir(ana, c.id, { tipo: 'RECIBIDO_VUELTO', movimientoId: c.mov, efectivoRecibido: 500 }), codigo('EFECTIVO_INSUFICIENTE'));
  await assert.rejects(corregir(ana, c.id, { tipo: 'RECIBIDO_VUELTO', movimientoId: c.mov, efectivoRecibido: 10000 }), codigo('SIN_CAMBIOS'));
  const ok = await corregir(ana, c.id, { tipo: 'RECIBIDO_VUELTO', movimientoId: c.mov, efectivoRecibido: 5000 });
  assert.equal(ok.estado, 'APLICADA');
  assert.deepEqual([ok.antes, ok.despues], [{ efectivoRecibido: 10000, vuelto: 9000 }, { efectivoRecibido: 5000, vuelto: 4000 }]);
  assert.deepEqual({ esperado: await esperado(ana), caja: await cajaHoy(), movs: await repo(Movimiento).count() }, antes);
  // El original sigue guardado; lo vigente sale de la corrección.
  assert.equal((await repo(Movimiento).findOneBy({ id: c.mov })).efectivoRecibido, 10000);
  const pago = (await detalle(ana, c.id)).pagos[0];
  assert.deepEqual([pago.efectivoRecibido, pago.vuelto, pago.recibidoCorregido], [5000, 4000, true]);
  const fila = (await como(admin, () => historial.listar({ tipo: 'SALIDA', q: c.plate }, { page: 1, limit: 10 }, actor(admin)))).data[0];
  assert.deepEqual([fila.recibido, fila.vuelto, fila.correccion], [5000, 4000, 'CORREGIDA']);
});

test('patente: se corrige en una salida registrada sin recalcular la tarifa y sin duplicar estadías', async () => {
  const c = await cobrar(ana);
  const adentro = await entrar(beto, 10, 'ADENTRO1');
  await assert.rejects(corregir(ana, c.id, { tipo: 'IDENTIFICACION', patente: 'ADENTRO1' }), codigo('PATENTE_ADENTRO'));
  const ok = await corregir(ana, c.id, { tipo: 'IDENTIFICACION', patente: 'ab 123 cd' });
  assert.equal(ok.estado, 'APLICADA');
  const r = await repo(Registration).findOneBy({ id: c.id });
  assert.deepEqual([r.licensePlateOriginal, r.licensePlateNormalized, r.price], ['AB 123 CD', 'AB123CD', 1000]);
  assert.equal(ok.antes.patente, c.plate);
  // Una estadía que sigue adentro se corrige desde el cobro (Corregir), no acá.
  await assert.rejects(corregir(beto, adentro.id, { tipo: 'IDENTIFICACION', patente: 'XX999XX' }), codigo('USAR_CORREGIR_ESTADIA'));
});

test('vehículo equivocado: el cobro pasa al que salió, el otro vuelve adentro y la caja no cambia; si no cierra, queda para revisión', async () => {
  const b = await entrar(ana, 30);
  const a = await cobrar(ana, {}, 30);
  const antes = { esperado: await esperado(ana), caja: await cajaHoy() };
  const registradaA = await repo(Registration).findOneBy({ id: a.id });
  const ok = await corregir(ana, a.id, { tipo: 'VEHICULO', destinoRegistrationId: b.id });
  assert.equal(ok.estado, 'APLICADA', JSON.stringify(ok.efecto));
  const [ra, rb] = await Promise.all([repo(Registration).findOneBy({ id: a.id }), repo(Registration).findOneBy({ id: b.id })]);
  assert.equal(ra.departureTime, null, 'la estadía equivocada vuelve a figurar adentro');
  assert.deepEqual([rb.departureDay, rb.departureTime, rb.exitTurnoId, rb.price], [registradaA.departureDay, registradaA.departureTime, registradaA.exitTurnoId, 1000]);
  assert.equal(await tickets.collectedAmount(ra), 0);
  assert.equal(await tickets.collectedAmount(rb), 1000);
  assert.deepEqual({ esperado: await esperado(ana), caja: await cajaHoy() }, antes);
  // El historial: la salida es de B, con su cobro; la de A ya no figura.
  const salidas = (await como(admin, () => historial.listar({ tipo: 'SALIDA' }, { page: 1, limit: 100 }, actor(admin)))).data;
  assert.equal(salidas.find(s => s.registrationId === b.id)?.importe, 1000);
  assert.equal(salidas.find(s => s.registrationId === a.id), undefined);
  // El cobro original de A pasó a B: ya no se corrige en A (se corrige en B, que es donde está).
  const enA = (await detalle(ana, a.id)).pagos.find(p => p.id === a.mov);
  assert.deepEqual([enA.movido, enA.deCorreccion], [true, false]);
  await assert.rejects(corregir(ana, a.id, { tipo: 'MEDIO_PAGO', movimientoId: a.mov, metodo: 'TRANSFER' }), codigo('COBRO_MOVIDO'));
  await assert.rejects(corregir(ana, a.id, { tipo: 'RECIBIDO_VUELTO', movimientoId: a.mov, efectivoRecibido: 5000 }), codigo('COBRO_MOVIDO'));
  const enB = (await detalle(ana, b.id)).pagos.find(p => p.deCorreccion);
  assert.ok(enB && !enB.movido, 'el cobro de B figura como suyo');
  const recibidoB = await corregir(ana, b.id, { tipo: 'RECIBIDO_VUELTO', movimientoId: enB.id, efectivoRecibido: 2000 });
  assert.equal(recibidoB.estado, 'APLICADA');
  assert.deepEqual({ esperado: await esperado(ana), caja: await cajaHoy() }, antes, 'lo declarado no mueve la caja');

  // Un cobro que confirmó Mercado Pago no se mueve solo: queda para revisión.
  const otroB = await entrar(ana, 30);
  const qr = await cobrar(ana, {}, 30);
  await ds.query(`UPDATE movimientos SET metodo = 'MERCADOPAGO' WHERE id = $1`, [qr.mov]);
  const conQr = await corregir(ana, qr.id, { tipo: 'VEHICULO', destinoRegistrationId: otroB.id });
  assert.equal(conQr.estado, 'PENDIENTE');
  assert.match(conQr.efecto.lineas.join(' '), /lo confirmó Mercado Pago/);

  // Un vehículo que entró antes (otra tarifa): no se resuelve solo.
  const caro = await entrar(ana, 200);
  const d = await cobrar(ana, {}, 30);
  const pendiente = await corregir(ana, d.id, { tipo: 'VEHICULO', destinoRegistrationId: caro.id });
  assert.equal(pendiente.estado, 'PENDIENTE');
  assert.match(pendiente.efecto.lineas.join(' '), /no coincide con lo que correspondía/);
  await assert.rejects(como(admin, () => correcciones.resolver(pendiente.id, { accion: 'APLICAR', resolucion: 'x' }, actor(admin))), codigo('CORRECCION_NO_APLICABLE'));
  assert.notEqual((await repo(Registration).findOneBy({ id: d.id })).departureTime, null, 'nada cambió');
});

test('una operación que cambió mientras se corregía se vuelve a mirar', async () => {
  const c = await cobrar(ana);
  const d = await detalle(ana, c.id);
  await corregir(ana, c.id, { tipo: 'RECIBIDO_VUELTO', movimientoId: c.mov, efectivoRecibido: 2000 });
  await assert.rejects(como(ana, () => correcciones.crear({ solicitudId: randomUUID(), registrationId: c.id, version: d.version, motivo: 'x', tipo: 'RECIBIDO_VUELTO', movimientoId: c.mov, efectivoRecibido: 5000 }, actor(ana))), codigo('OPERACION_CAMBIO'));
  // Previsualizar no guarda nada.
  const nueva = await detalle(ana, c.id);
  const vista = await como(ana, () => correcciones.previsualizar({ solicitudId: randomUUID(), registrationId: c.id, version: nueva.version, motivo: 'x', tipo: 'MEDIO_PAGO', movimientoId: c.mov, metodo: 'TRANSFER', operacionId: 'op-vista' }, actor(ana)));
  assert.equal(vista.estado, 'APLICADA');
  assert.equal((await detalle(ana, c.id)).version, nueva.version);
});

test('historial: filtros y paginación en el servidor, y el operador ve solo lo suyo', async () => {
  const deBeto = await cobrar(beto, {}, 30, 'HISTBETO');
  const todas = await como(admin, () => historial.listar({}, { page: 1, limit: 100 }, actor(admin)));
  assert.ok(todas.meta.totalItems > 10);
  // El resumen: cuántos de cada tipo suman el total; lo cobrado por medio suma los importes de la lista.
  assert.equal(todas.resumen.total, todas.meta.totalItems);
  assert.equal(Object.values(todas.resumen.porTipo).reduce((a, n) => a + n, 0), todas.resumen.total);
  const porMedio = {};
  for (const f of todas.data) for (const [m, n] of Object.entries(f.medios ?? {})) porMedio[m] = (porMedio[m] ?? 0) + Number(n);
  for (const [m, n] of Object.entries(porMedio)) if (n) assert.equal(todas.resumen.cobrado.porMedio[m], n, m);
  assert.equal(todas.resumen.cobrado.total, Object.values(porMedio).reduce((a, n) => a + n, 0));
  assert.ok(todas.resumen.pendientes >= 1, 'hay correcciones esperando revisión');
  // La salida trae la duración y la patente aparte.
  const salidaBeto = todas.data.find(f => f.registrationId === deBeto.id && f.tipo === 'SALIDA');
  assert.equal(salidaBeto.patente, 'HISTBETO');
  assert.ok(salidaBeto.duracion >= 29 && salidaBeto.duracion <= 31, String(salidaBeto.duracion));
  // Con un tipo elegido, las cantidades por tipo siguen contando todos (son las de los filtros).
  const soloSalidas = await como(admin, () => historial.listar({ tipo: 'SALIDA' }, { page: 1, limit: 100 }, actor(admin)));
  assert.deepEqual(soloSalidas.resumen.porTipo, todas.resumen.porTipo);
  assert.equal(soloSalidas.resumen.total, todas.resumen.porTipo.SALIDA);
  // Una salida y su cobro son un solo renglón.
  assert.equal(todas.data.filter(f => f.registrationId === deBeto.id && f.tipo === 'SALIDA').length, 1);
  assert.equal(todas.data.filter(f => f.registrationId === deBeto.id && f.importe != null).length, 1);
  const paginaDos = await como(admin, () => historial.listar({}, { page: 2, limit: 3 }, actor(admin)));
  assert.deepEqual(paginaDos.data.map(f => f.id), todas.data.slice(3, 6).map(f => f.id));
  // Por medio, el vigente: las salidas corregidas a transferencia aparecen con transferencia.
  const transferencias = await como(admin, () => historial.listar({ medio: 'TRANSFER', tipo: 'SALIDA' }, { page: 1, limit: 100 }, actor(admin)));
  assert.ok(transferencias.data.length >= 3);
  assert.ok(transferencias.data.every(f => f.medios?.TRANSFER));
  const corregidas = await como(admin, () => historial.listar({ correccion: 'CORREGIDA', tipo: 'SALIDA' }, { page: 1, limit: 100 }, actor(admin)));
  assert.ok(corregidas.data.every(f => f.correccion === 'CORREGIDA'));
  const pendientes = await como(admin, () => historial.listar({ tipo: 'CORRECCION', correccion: 'PENDIENTE' }, { page: 1, limit: 100 }, actor(admin)));
  assert.ok(pendientes.data.length >= 1);
  assert.equal((await como(admin, () => historial.listar({ q: 'histbeto' }, { page: 1, limit: 10 }, actor(admin)))).meta.totalItems, 2);
  // Beto ve sus operaciones, no las de Ana.
  const deBetoVista = await como(beto, () => historial.listar({}, { page: 1, limit: 100 }, actor(beto)));
  assert.ok(deBetoVista.data.length > 0);
  assert.ok(deBetoVista.data.every(f => f.operador === 'Beto Dos'), JSON.stringify(deBetoVista.data.map(f => f.operador)));
  // Mi turno.
  const turno = await turnoDe(beto);
  const delTurno = await como(beto, () => historial.listar({ turnoId: turno.id }, { page: 1, limit: 100 }, actor(beto)));
  assert.ok(delTurno.data.some(f => f.registrationId === deBeto.id && f.tipo === 'SALIDA'));
  await assert.rejects(como(admin, () => historial.listar({ desde: '2026-13-01' }, { page: 1, limit: 10 }, actor(admin))), /fechas/);
});

test('panel: lo cobrado suma igual que el historial, con el período comparado, los autos adentro y el calendario', async () => {
  const panel = new PanelService(ds);
  const { occupancyAt } = require('../dist/turnos/turno-book');
  const dia = hoy();
  const r = await como(admin, () => panel.resumen({ desde: dia, hasta: dia }));
  const h = await como(admin, () => historial.listar({}, { page: 1, limit: 1 }, actor(admin)));
  // Lo cobrado y sus medios: los mismos que el resumen del historial del día.
  assert.equal(r.cobrado.total, h.resumen.cobrado.total);
  for (const [m, n] of Object.entries(h.resumen.cobrado.porMedio)) assert.equal(r.cobrado.porMedio[m], n, m);
  assert.deepEqual(r.cobrado.porDia.map(d => d.fecha), [dia]);
  assert.equal(r.cobrado.porDia[0].total, r.cobrado.total);
  // Un solo día también viene hora por hora, y suma lo mismo.
  assert.equal(r.cobrado.porHora.length, 24);
  assert.equal(r.cobrado.porHora.reduce((a, n) => a + n, 0), r.cobrado.total);
  assert.equal(r.cobrado.anterior.porHora.length, 24);
  // Comparado con el día anterior (sin datos en esta base).
  assert.deepEqual(r.comparacion, { modo: 'anterior', desde: dayjs(dia).subtract(1, 'day').format('YYYY-MM-DD'), hasta: dayjs(dia).subtract(1, 'day').format('YYYY-MM-DD') });
  assert.equal(r.cobrado.anterior.total, 0);
  // Las estadías: entradas y salidas como el historial; ticket y duración de las que salieron.
  assert.equal(r.estadias.salidas, (h.resumen.porTipo.SALIDA ?? 0) + 0);
  assert.equal(r.estadias.entradas, h.resumen.porTipo.ENTRADA ?? 0);
  assert.ok(r.estadias.ticketPromedio > 0);
  assert.ok(r.estadias.duracionPromedio >= 25, String(r.estadias.duracionPromedio));
  // Hoy: los autos adentro, con el mismo criterio que la caja.
  const ahora = await como(admin, () => occupancyAt(ds.manager, new Date()));
  assert.equal(r.hoy.adentroAhora, ahora);
  assert.equal(r.hoy.adentroPorHora.length, r.hoy.horaActual + 1);
  // El calendario: 20 semanas de lunes a hoy; hoy suma lo cobrado.
  assert.equal(dayjs(r.calendario[0].fecha).day(), 1);
  assert.equal(r.calendario.at(-1).fecha, dia);
  assert.ok(r.calendario.length > 19 * 7 && r.calendario.length <= 20 * 7);
  assert.equal(r.calendario.at(-1).total, r.cobrado.total);
  // Avisos: las correcciones esperando revisión.
  const [{ n }] = await ds.query(`SELECT COUNT(*)::int AS n FROM correcciones WHERE estado = 'PENDIENTE'`);
  assert.equal(r.avisos.correccionesPendientes, n);
  assert.equal(typeof r.avisos.faltantes.cantidad, 'number');
  // Un año atrás y sin comparar; rangos inválidos.
  const anio = await como(admin, () => panel.resumen({ desde: dia, hasta: dia, comparar: 'anio' }));
  assert.equal(anio.comparacion.desde, dayjs(dia).subtract(1, 'year').format('YYYY-MM-DD'));
  const solo = await como(admin, () => panel.resumen({ desde: dia, hasta: dia, comparar: 'no' }));
  assert.equal(solo.comparacion, null);
  assert.equal(solo.cobrado.anterior, null);
  assert.equal(solo.estadias.anterior, null);
  await assert.rejects(como(admin, () => panel.resumen({ desde: dia, hasta: dayjs(dia).subtract(1, 'day').format('YYYY-MM-DD') })), /fechas/);
  await assert.rejects(como(admin, () => panel.resumen({ desde: '2024-01-01', hasta: '2025-06-01' })), /un año/);
  await assert.rejects(como(admin, () => panel.resumen({ comparar: 'siempre' })), /Comparación/);
  // Un rango de varios días trae todos los días, aunque no haya movimientos.
  const semana = await como(admin, () => panel.resumen({ desde: dayjs(dia).subtract(6, 'day').format('YYYY-MM-DD'), hasta: dia }));
  assert.equal(semana.cobrado.porDia.length, 7);
  assert.equal(semana.estadias.porDia.length, 7);
  assert.equal(semana.cobrado.porHora, null);
  assert.equal(semana.cobrado.total, r.cobrado.total);
});

test('turno cerrado: el operador la manda a revisión; con la caja contada y cerrada, el arqueo queda igual y la corrección se vincula al cierre', async () => {
  // Beto cobra, deja la caja compartida (sigue Ana): su turno cerró, la caja no.
  const c = await cobrar(beto);
  const turnoBeto = await turnoDe(beto);
  const enCaja = await esperado(beto);
  await como(beto, () => shifts.close(turnoBeto.id, beto.id, { cerrarCaja: false, conteoRelevo: enCaja }));
  const pedida = await corregir(beto, c.id, { tipo: 'MEDIO_PAGO', movimientoId: c.mov, metodo: 'TRANSFER', operacionId: 'op-beto' });
  assert.equal(pedida.estado, 'PENDIENTE');
  assert.match(pedida.efecto.lineas.join(' '), /ya cerró/);
  // Administración la aplica: el efecto va al turno abierto de esa caja (Ana).
  const antesAna = await esperado(ana);
  const aplicada = await como(admin, () => correcciones.resolver(pedida.id, { accion: 'APLICAR', resolucion: 'Transferencia verificada', operacionId: 'op-beto' }, actor(admin)));
  assert.equal(aplicada.posteriorAlCierre, false);
  assert.equal(await esperado(ana), antesAna - 1000);

  // Ana cobra y cierra la caja contando.
  const ultimo = await cobrar(ana);
  const turnoAna = await turnoDe(ana);
  const contado = await esperado(ana);
  const cerrado = await como(ana, () => shifts.close(turnoAna.id, ana.id, { cerrarCaja: true, efectivoEsperado: contado, efectivoContado: contado, efectivoParaSiguiente: 0, desglose: billetes(contado) }));
  const arqueo = { contado: cerrado.efectivoContado, teorico: cerrado.efectivoTeorico, diferencia: cerrado.diferencia };
  const antesCaja = await cajaHoy();
  const posterior = await corregir(admin, ultimo.id, { tipo: 'MEDIO_PAGO', movimientoId: ultimo.mov, metodo: 'TRANSFER' });
  assert.equal(posterior.estado, 'APLICADA');
  assert.equal(posterior.posteriorAlCierre, true);
  assert.match(posterior.efecto.lineas.join(' '), /ya se contó: su arqueo no cambia/);
  const despues = await repo(Turno).findOneBy({ id: turnoAna.id });
  assert.deepEqual({ contado: despues.efectivoContado, teorico: despues.efectivoTeorico, diferencia: despues.diferencia }, arqueo);
  // Vinculada al cierre y en la planilla de hoy (sin turno: esa caja ya se contó).
  const resumen = await shiftSummary(ds.manager, despues);
  assert.deepEqual(resumen.correcciones.posterioresAlCierre, { cantidad: 1, efectivo: -1000, digital: 1000 });
  assert.equal(await cajaHoy(), antesCaja - 1000);
  const [entrada] = await ds.query(`SELECT "turnoId", categoria, amount FROM cash_entries WHERE categoria = 'CORRECCION' ORDER BY "createdAt" DESC LIMIT 1`);
  assert.deepEqual([entrada.turnoId, entrada.amount], [null, -1000]);
});
