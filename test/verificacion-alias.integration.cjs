// Verificación de transferencias al alias contra PostgreSQL real. Ejecutar después de pnpm build
// (carga desde dist/). PostgreSQL efímero: nunca lee .env ni usa la base del proyecto. MercadoPago
// está simulado: `fetch` devuelve los pagos que arma cada prueba.
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
const Empresa = load('tenancy/entities/empresa.entity', 'Empresa');
const Playa = load('tenancy/entities/playa.entity', 'Playa');
const Cuenta = load('mercadopago/entities/cuenta-mercadopago.entity', 'CuentaMercadoPago');
const Intento = load('mercadopago/entities/cobro-transferencia.entity', 'CobroTransferencia');
const Transferencia = load('mercadopago/entities/transferencia-recibida.entity', 'TransferenciaRecibida');
const Adicional = load('saas/entities/empresa-adicional.entity', 'EmpresaAdicional');
const TicketsService = load('tickets/tickets.service', 'TicketsService');
const TurnosService = load('turnos/turnos.service', 'TurnosService');
const MovimientosService = load('movimientos/movimientos.service', 'MovimientosService');
const BoxListsService = load('box-lists/box-lists.service', 'BoxListsService');
const { VerificacionAliasService, olvidarLecturas } = require('../dist/mercadopago/verificacion-alias.service');
const { CONDICIONES_VIGENTES } = require('../dist/mercadopago/condiciones');
const { tenantContext } = require('../dist/tenancy/tenant-context');

let ds, root, pgStarted = false, tickets, alias;
let n = 0;
let operacion = 9000;
// Lo que «devuelve MercadoPago» en la próxima consulta, y si falla.
let pagosMp = [];
let mpFalla = false;
const fetchOriginal = global.fetch;

const bin = process.env.PG_TEST_BIN || 'C:/Program Files/PostgreSQL/18/bin';
const pg = (name, args) => {
  const output = fs.openSync(path.join(root, 'commands.log'), 'a');
  try { return execFileSync(path.join(bin, name + (process.platform === 'win32' ? '.exe' : '')), args, { windowsHide: true, stdio: ['ignore', output, output], timeout: 30000 }); }
  finally { fs.closeSync(output); }
};
const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const repo = (e) => ds.getRepository(e);

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-pg-test-'));
  pg('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--locale=C']);
  const port = await freePort();
  pgStarted = true;
  pg('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'postgres.log'), '-o', '-h 127.0.0.1 -p ' + port + ' -F', '-w', 'start']);
  ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: 'postgres', entities: [path.resolve('dist/**/*.entity.js')], migrations: [load('database/migrations/1790000000000-flexible-vehicle-types', 'FlexibleVehicleTypes1790000000000')], migrationsRun: true, synchronize: true });
  await ds.initialize();
  // Lo mismo que hace installTenantConnections con cada alta: estampar la playa del contexto.
  ds.subscribers.push({ beforeInsert(event) {
    const scope = tenantContext.getStore();
    if (scope && event.entity && event.metadata.findColumnWithPropertyName('playaId') && event.entity.playaId == null) event.entity.playaId = scope.playaId;
  } });
  const shifts = new TurnosService(repo(Turno), repo(Movimiento), ds);
  const movements = new MovimientosService(repo(Movimiento), shifts);
  const boxes = new BoxListsService(repo(Box), repo(Other), ds);
  tickets = new TicketsService(repo(Ticket), repo(TicketPrice), repo(Bracket), repo(Registration), repo(RegistrationDay), repo(Schedule), boxes, { emitNewRegistration() {} }, movements, ds);
  alias = new VerificacionAliasService(repo(Cuenta), repo(Intento), repo(Transferencia), repo(Adicional), { tokenDeEmpresa: async () => 'token-de-prueba' }, tickets, ds);
  await tickets.updateSchedule({ dayStartHour: 8, dayEndHour: 20, graceMinutes: 5, pricingDayTypeBasis: 'ENTRY', barcodeTicketsEnabled: false });
  // Hasta una hora $1000, después $1000 por hora.
  await tickets.createPriceBracket({ vehicleType: 'AUTO', label: 'Hora', uptoMinutes: 60, price: 1000 });
  await tickets.createPriceBracket({ vehicleType: 'AUTO', label: 'Extra', price: 1000, recurringUnitMinutes: 60, recurringPriceMode: 'FIXED' });
  global.fetch = async (url) => {
    assert.ok(String(url).startsWith('https://api.mercadopago.com/v1/payments/search?'));
    if (mpFalla) return new Response('{}', { status: 500 });
    return new Response(JSON.stringify({ results: pagosMp, paging: { total: pagosMp.length } }), { status: 200 });
  };
});

after(async () => {
  global.fetch = fetchOriginal;
  if (ds?.isInitialized) await ds.destroy();
  if (pgStarted && fs.existsSync(path.join(root, 'data', 'postmaster.pid'))) pg('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'immediate', '-w', 'stop']);
  if (root) {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('alias-pg-test-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// Cada prueba con su propia empresa y su cuenta de MercadoPago: así los intentos de una no
// compiten con los de otra.
async function empresaDePrueba() {
  n++;
  const empresa = await repo(Empresa).save({ nombre: 'Empresa ' + n });
  const playaA = await repo(Playa).save({ empresaId: empresa.id, nombre: 'Playa A ' + n });
  const playaB = await repo(Playa).save({ empresaId: empresa.id, nombre: 'Playa B ' + n });
  const operador = await repo(User).save(repo(User).create({ username: 'op' + n, firstName: 'Op', lastName: String(n), email: `op${n}@example.test`, role: 'USER', empresaId: empresa.id }));
  const mpUserId = String(70000 + n);
  await repo(Cuenta).save({ empresaId: empresa.id, mpUserId, nickname: 'PRUEBA', accessToken: 'x', refreshToken: 'y', expiraEl: new Date(Date.now() + 864e5 * 30), estado: 'ACTIVA', condicionesVersion: CONDICIONES_VIGENTES.version, alias: 'playa.prueba', verificacionAlias: true });
  await repo(Adicional).save({ empresaId: empresa.id, codigo: 'VERIFICACION_ALIAS', habilitado: true, precioMensual: 5000 });
  const en = (playa, fn) => tenantContext.run({ empresaId: empresa.id, playaId: playa.id, userId: operador.id, role: 'USER' }, fn);
  return { empresa, playaA, playaB, operador, mpUserId, en };
}

async function estadia(ctx, playa, minutos = 30) {
  const r = await ctx.en(playa, () => tickets.createRegistrationByPlate({ vehicleType: 'AUTO', licensePlate: 'AL' + n + 'X' + (++operacion) }));
  await envejecer(r, minutos);
  return r;
}
async function envejecer(r, minutos) {
  const entrada = dayjs().tz('America/Argentina/Buenos_Aires').subtract(minutos, 'minute');
  await repo(Registration).update(r.id, { entryDay: entrada.format('YYYY-MM-DD'), entryTime: entrada.format('HH:mm:ss') });
}

// Un pago como los que devuelve /v1/payments/search.
const transferencia = (ctx, importe, extra = {}) => ({
  id: ++operacion, collector_id: Number(ctx.mpUserId), status: 'approved', currency_id: 'ARS', transaction_amount: importe,
  operation_type: 'account_fund', payment_type_id: 'bank_transfer', payment_method_id: 'cvu', point_of_interaction: { type: 'PSP_TRANSFER' },
  date_created: new Date().toISOString(), date_approved: new Date().toISOString(), ...extra,
});

const consultar = (ctx, playa, id) => { olvidarLecturas(); return ctx.en(playa, () => alias.consultar(id)); };
const iniciar = (ctx, playa, registrationId) => { olvidarLecturas(); return ctx.en(playa, () => alias.iniciar(registrationId)); };
const movimientosDe = (registrationId) => repo(Movimiento).find({ where: { ticketRegistration: { id: registrationId } } });
const codigo = (error) => error?.getResponse?.()?.code;

test('una transferencia y un solo cobro esperándola: se confirma una vez y registra cobro y salida', async () => {
  const ctx = await empresaDePrueba();
  const r = await estadia(ctx, ctx.playaA);
  pagosMp = [];
  const inicio = await iniciar(ctx, ctx.playaA, r.id);
  assert.equal(inicio.estado, 'ESPERANDO');
  assert.equal(inicio.importe, 1000);
  assert.equal(inicio.alias, 'playa.prueba');
  assert.equal((await movimientosDe(r.id)).length, 0, 'esperar no registra nada');

  const t = transferencia(ctx, 1000);
  pagosMp = [t];
  const v = await consultar(ctx, ctx.playaA, inicio.id);
  assert.equal(v.estado, 'CONFIRMADO');
  assert.equal(v.modo, 'AUTOMATICO_COINCIDENCIA_UNICA');
  assert.equal(v.salidaRegistrada, true);
  assert.equal(v.transferencia.operacionId, String(t.id));

  // Consultar de nuevo (otra pantalla, un reintento) no cobra dos veces.
  await consultar(ctx, ctx.playaA, inicio.id);
  const movs = await movimientosDe(r.id);
  assert.equal(movs.length, 1);
  assert.equal(movs[0].metodo, 'TRANSFER');
  assert.equal(movs[0].monto, 1000);
  assert.match(movs[0].referencia, new RegExp(String(t.id)));
  assert.ok((await repo(Registration).findOneBy({ id: r.id })).departureTime, 'la salida quedó registrada');
  const fila = await repo(Transferencia).findOneBy({ mpUserId: ctx.mpUserId, operacionId: String(t.id) });
  assert.equal(fila.estado, 'USADA');
  assert.equal(fila.cobroId, inicio.id);
  assert.equal(fila.importe, 1000);
});

test('dos transferencias del mismo importe: revisión con las dos, el operador asigna una y la otra nunca se asocia sola', async () => {
  const ctx = await empresaDePrueba();
  const r = await estadia(ctx, ctx.playaA);
  const [t1, t2] = [transferencia(ctx, 1000, { payer: { first_name: 'Ana' } }), transferencia(ctx, 1000)];
  pagosMp = [t1, t2];
  const inicio = await iniciar(ctx, ctx.playaA, r.id);
  assert.equal(inicio.estado, 'REVISION');
  assert.equal(inicio.motivoRevision, 'VARIAS_TRANSFERENCIAS');
  assert.deepEqual(inicio.opciones.map((o) => o.operacionId).sort(), [String(t1.id), String(t2.id)].sort());
  assert.equal(inicio.opciones.find((o) => o.operacionId === String(t1.id)).nombre, 'Ana');
  assert.equal((await movimientosDe(r.id)).length, 0, 'con dudas no se registra nada');

  const v = await ctx.en(ctx.playaA, () => alias.asignar(inicio.id, String(t1.id)));
  assert.equal(v.estado, 'CONFIRMADO');
  assert.equal(v.modo, 'MANUAL');
  assert.equal((await repo(Transferencia).findOneBy({ mpUserId: ctx.mpUserId, operacionId: String(t2.id) })).estado, 'REVISION');

  // Un cobro nuevo del mismo importe: la que quedó en revisión no se le asocia sola.
  const r2 = await estadia(ctx, ctx.playaA);
  const segundo = await iniciar(ctx, ctx.playaA, r2.id);
  assert.equal(segundo.estado, 'REVISION');
  assert.deepEqual(segundo.opciones.map((o) => o.operacionId), [String(t2.id)]);
  assert.equal((await movimientosDe(r2.id)).length, 0);
});

test('una transferencia y dos autos del mismo importe en distintas playas: revisión, y si dos cajas la asignan a la vez solo una puede', async () => {
  const ctx = await empresaDePrueba();
  const rA = await estadia(ctx, ctx.playaA);
  const rB = await estadia(ctx, ctx.playaB);
  pagosMp = [];
  const iA = await iniciar(ctx, ctx.playaA, rA.id);
  const iB = await iniciar(ctx, ctx.playaB, rB.id);
  const t = transferencia(ctx, 1000);
  pagosMp = [t];
  const vA = await consultar(ctx, ctx.playaA, iA.id);
  const vB = await consultar(ctx, ctx.playaB, iB.id);
  assert.equal(vA.estado, 'REVISION');
  assert.equal(vA.motivoRevision, 'VARIOS_COBROS');
  assert.equal(vB.estado, 'REVISION');
  assert.deepEqual(vB.opciones.map((o) => o.operacionId), [String(t.id)]);

  const resultados = await Promise.allSettled([
    ctx.en(ctx.playaA, () => alias.asignar(iA.id, String(t.id))),
    ctx.en(ctx.playaB, () => alias.asignar(iB.id, String(t.id))),
  ]);
  const ok = resultados.filter((x) => x.status === 'fulfilled');
  const rechazados = resultados.filter((x) => x.status === 'rejected');
  assert.equal(ok.length, 1, 'una sola caja la usa');
  assert.equal(rechazados.length, 1);
  assert.equal(codigo(rechazados[0].reason), 'TRANSFERENCIA_USADA');
  const movs = [...(await movimientosDe(rA.id)), ...(await movimientosDe(rB.id))];
  assert.equal(movs.length, 1, 'un solo cobro con esa transferencia');

  // La que quedó esperando ya no la ve entre sus opciones, aunque recargue.
  const perdio = ok[0].value.id === iA.id ? { playa: ctx.playaB, id: iB.id } : { playa: ctx.playaA, id: iA.id };
  const despues = await consultar(ctx, perdio.playa, perdio.id);
  assert.equal(despues.estado, 'REVISION');
  assert.deepEqual(despues.opciones, []);
});

test('tarjetas, suscripciones, egresos y pagos generados por el sistema del mismo importe quedan afuera', async () => {
  const ctx = await empresaDePrueba();
  const r = await estadia(ctx, ctx.playaA);
  pagosMp = [
    transferencia(ctx, 1000, { operation_type: 'regular_payment', payment_type_id: 'credit_card', point_of_interaction: { type: 'CHECKOUT' } }),
    transferencia(ctx, 1000, { operation_type: 'recurring_payment', payment_type_id: 'credit_card', point_of_interaction: { type: 'SUBSCRIPTIONS' } }),
    transferencia(ctx, 1000, { collector_id: 1 }),
    transferencia(ctx, 1000, { external_reference: 'cobro-qr' }),
    transferencia(ctx, 1000, { status: 'pending' }),
  ];
  const v = await iniciar(ctx, ctx.playaA, r.id);
  assert.equal(v.estado, 'ESPERANDO');
  assert.equal(await repo(Transferencia).countBy({ mpUserId: ctx.mpUserId }), 0, 'no se guarda nada de eso');
});

test('si MercadoPago falla, el cobro sigue esperando y se informa el error (nunca «no pagó»)', async () => {
  const ctx = await empresaDePrueba();
  const r = await estadia(ctx, ctx.playaA);
  mpFalla = true;
  try {
    const v = await iniciar(ctx, ctx.playaA, r.id);
    assert.equal(v.estado, 'ESPERANDO');
    assert.equal(v.consulta.ok, false);
    assert.match(v.consulta.error, /No se pudo consultar MercadoPago/);
  } finally {
    mpFalla = false;
  }
  pagosMp = [transferencia(ctx, 1000)];
  const intento = await repo(Intento).findOneBy({ registrationId: r.id });
  assert.equal((await consultar(ctx, ctx.playaA, intento.id)).estado, 'CONFIRMADO', 'al volver MercadoPago se confirma');
});

test('cancelado y pago tardío: no registra esa salida, y el cobro siguiente del mismo importe va a revisión', async () => {
  const ctx = await empresaDePrueba();
  const r1 = await estadia(ctx, ctx.playaA);
  pagosMp = [];
  const i1 = await iniciar(ctx, ctx.playaA, r1.id);
  assert.equal((await ctx.en(ctx.playaA, () => alias.cancelar(i1.id))).estado, 'CANCELADO');
  // La plata llega después de cancelar.
  pagosMp = [transferencia(ctx, 1000)];
  const r2 = await estadia(ctx, ctx.playaA);
  const i2 = await iniciar(ctx, ctx.playaA, r2.id);
  assert.equal(i2.estado, 'REVISION', 'puede ser el pago tardío del cancelado');
  assert.equal(i2.motivoRevision, 'VARIOS_COBROS');
  assert.equal((await movimientosDe(r1.id)).length, 0);
  assert.equal((await movimientosDe(r2.id)).length, 0);
  assert.equal((await ctx.en(ctx.playaA, () => alias.consultar(i1.id))).estado, 'CANCELADO', 'el cancelado no se reabre');
});

test('pagada por otro medio mientras esperaba: no genera otro cobro ni otra salida', async () => {
  const ctx = await empresaDePrueba();
  const r = await estadia(ctx, ctx.playaA);
  pagosMp = [];
  const i = await iniciar(ctx, ctx.playaA, r.id);
  await ctx.en(ctx.playaA, async () => {
    const s = await tickets.getCloseSummary(r.id);
    await tickets.closeRegistrationByPlate(r.id, { closeType: 'PAYMENT', metodo: 'CASH', expectedPrice: s.previewBracket.price, expectedCollected: s.totalCollectedSoFar }, ctx.operador.id);
  });
  pagosMp = [transferencia(ctx, 1000)];
  const v = await consultar(ctx, ctx.playaA, i.id);
  assert.equal(v.estado, 'PAGADO_OTRO_MEDIO');
  const movs = await movimientosDe(r.id);
  assert.equal(movs.length, 1);
  assert.equal(movs[0].metodo, 'CASH');
});

test('si la tarifa subió mientras se esperaba, se registra el pago y queda el saldo, sin salida', async () => {
  const ctx = await empresaDePrueba();
  const r = await estadia(ctx, ctx.playaA, 30);
  pagosMp = [];
  const i = await iniciar(ctx, ctx.playaA, r.id);
  assert.equal(i.importe, 1000);
  await envejecer(r, 90);
  pagosMp = [transferencia(ctx, 1000)];
  const v = await consultar(ctx, ctx.playaA, i.id);
  assert.equal(v.estado, 'CONFIRMADO');
  assert.equal(v.salidaRegistrada, false);
  assert.equal(v.saldoPendiente, 1000);
  assert.equal((await repo(Registration).findOneBy({ id: r.id })).departureTime, null);
});

test('reabrir la pantalla recupera el mismo intento y no duplica', async () => {
  const ctx = await empresaDePrueba();
  const r = await estadia(ctx, ctx.playaA);
  pagosMp = [];
  const a = await iniciar(ctx, ctx.playaA, r.id);
  const b = await iniciar(ctx, ctx.playaA, r.id);
  assert.equal(a.id, b.id);
  assert.equal((await ctx.en(ctx.playaA, () => alias.deEstadia(r.id))).id, a.id);
  assert.equal(await repo(Intento).countBy({ registrationId: r.id }), 1);
  // Ampliar la búsqueda corre el inicio cinco minutos para atrás, una sola vez.
  const ampliado = await ctx.en(ctx.playaA, () => alias.ampliar(a.id));
  assert.equal(ampliado.ventanaMinutos, 5);
  assert.equal(ampliado.puedeAmpliar, false);
});

test('sin el adicional habilitado no se ofrece, no se inicia y un intento abierto no confirma', async () => {
  const ctx = await empresaDePrueba();
  const r = await estadia(ctx, ctx.playaA);
  pagosMp = [];
  const i = await iniciar(ctx, ctx.playaA, r.id);
  await repo(Adicional).update({ empresaId: ctx.empresa.id }, { habilitado: false });
  assert.equal((await ctx.en(ctx.playaA, () => alias.disponibilidad())).disponible, false);
  const r2 = await estadia(ctx, ctx.playaA);
  await assert.rejects(iniciar(ctx, ctx.playaA, r2.id), (e) => codigo(e) === 'ADICIONAL_NO_HABILITADO');
  pagosMp = [transferencia(ctx, 1000)];
  const v = await consultar(ctx, ctx.playaA, i.id);
  assert.equal(v.estado, 'ESPERANDO');
  assert.equal(v.consulta.code, 'ADICIONAL_NO_HABILITADO');
  assert.equal((await movimientosDe(r.id)).length, 0);
});

test('otra playa de la empresa no puede consultar, asignar ni cancelar un intento ajeno', async () => {
  const ctx = await empresaDePrueba();
  const r = await estadia(ctx, ctx.playaA);
  pagosMp = [];
  const i = await iniciar(ctx, ctx.playaA, r.id);
  await assert.rejects(ctx.en(ctx.playaB, () => alias.consultar(i.id)), /no encontrado/i);
  await assert.rejects(ctx.en(ctx.playaB, () => alias.cancelar(i.id)), /no encontrado/i);
  await assert.rejects(ctx.en(ctx.playaB, () => alias.asignar(i.id, '1')), /no encontrado/i);
});
