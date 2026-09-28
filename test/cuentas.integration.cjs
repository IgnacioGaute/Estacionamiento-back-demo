// Cuenta corriente de inquilinos. Ejecutar después de pnpm build (carga desde dist/).
// PostgreSQL efímero: nunca lee .env ni usa la base del proyecto.
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

const Customer = load('customers/entities/customer.entity', 'Customer');
const Receipt = load('receipts/entities/receipt.entity', 'Receipt');
const ReceiptPayment = load('receipts/entities/receipt-payment.entity', 'ReceiptPayment');
const History = load('receipts/entities/payment-history-on-account.entity', 'PaymentHistoryOnAccount');
const Movimiento = load('movimientos/entities/movimiento.entity', 'Movimiento');
const Box = load('box-lists/entities/box-list.entity', 'BoxList');
const Other = load('box-lists/entities/other-payment.entity', 'OtherPayment');
const Empresa = load('tenancy/entities/empresa.entity', 'Empresa');
const Playa = load('tenancy/entities/playa.entity', 'Playa');
const User = load('users/entities/user.entity', 'User');
const CuentaMovimiento = load('cuentas/entities/cuenta-movimiento.entity', 'CuentaMovimiento');
const Turno = load('turnos/entities/turno.entity', 'Turno');
const ParkingRenter = load('parking/entities/parking-renter.entity', 'ParkingRenter');
const ParkingOwner = load('parking/entities/parking-owner.entity', 'ParkingOwner');
const RenterParkingType = load('parking/entities/renter-parking-type.entity', 'RenterParkingType');
const InterestSettings = load('customers/entities/interest-setting.entity', 'InterestSettings');
const ParkingRentersService = load('parking/parking-renters.service', 'ParkingRentersService');
const CustomersService = load('customers/customers.service', 'CustomersService');
const CobroMercadoPago = load('mercadopago/entities/cobro-mercadopago.entity', 'CobroMercadoPago');
const CobrosMercadoPagoService = load('mercadopago/cobros.service', 'CobrosMercadoPagoService');
const ParkingReceiptsService = load('tickets/parking-receipts.service', 'ParkingReceiptsService');
const ReceiptsService = load('receipts/receipts.service', 'ReceiptsService');
const BoxListsService = load('box-lists/box-lists.service', 'BoxListsService');
const CuentasService = load('cuentas/cuentas.service', 'CuentasService');
const { tenantContext } = require('../dist/tenancy/tenant-context');

let ds, root, pgStarted = false, receipts, cuentas, boxes, user, playa, empresa;
const bin = process.env.PG_TEST_BIN || 'C:/Program Files/PostgreSQL/18/bin';
const pg = (name, args) => {
  const output = fs.openSync(path.join(root, 'commands.log'), 'a');
  try { return execFileSync(path.join(bin, name + (process.platform === 'win32' ? '.exe' : '')), args, { windowsHide: true, stdio: ['ignore', output, output], timeout: 30000 }); }
  finally { fs.closeSync(output); }
};
const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const hoy = () => dayjs().tz('America/Argentina/Buenos_Aires').format('YYYY-MM-DD');
const mes = (n) => dayjs().tz('America/Argentina/Buenos_Aires').add(n, 'month').format('YYYY-MM');
const enPlaya = (fn) => tenantContext.run({ empresaId: empresa.id, playaId: playa.id, userId: user.id, role: 'ADMIN' }, fn);

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuentas-pg-test-'));
  pg('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--locale=C']);
  const port = await freePort();
  pgStarted = true;
  pg('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'postgres.log'), '-o', '-h 127.0.0.1 -p ' + port + ' -F', '-w', 'start']);
  ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: 'postgres', entities: [path.resolve('dist/**/*.entity.js')], synchronize: true });
  await ds.initialize();
  // Lo mismo que hace installTenantConnections con cada alta: estampar la playa del contexto.
  ds.subscribers.push({ beforeInsert(event) {
    const scope = tenantContext.getStore();
    if (scope && event.entity && event.metadata.findColumnWithPropertyName('playaId') && event.entity.playaId == null) event.entity.playaId = scope.playaId;
  } });
  const repo = (e) => ds.getRepository(e);
  boxes = new BoxListsService(repo(Box), repo(Other), ds);
  receipts = new ReceiptsService(repo(Receipt), repo(Customer), repo(ReceiptPayment), repo(History), repo(Movimiento), boxes, ds);
  cuentas = new CuentasService(ds, receipts, boxes);
  empresa = await repo(Empresa).save({ nombre: 'Empresa de prueba' });
  playa = await repo(Playa).save({ empresaId: empresa.id, nombre: 'Playa de prueba', modulos: { inquilinos: true } });
  user = await repo(User).save(repo(User).create({ username: 'admin', firstName: 'Ada', lastName: 'Admin', email: 'admin@example.test', role: 'ADMIN', empresaId: empresa.id }));
});

after(async () => {
  if (ds?.isInitialized) await ds.destroy();
  if (pgStarted && fs.existsSync(path.join(root, 'data', 'postmaster.pid'))) pg('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'immediate', '-w', 'stop']);
  if (root) {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('cuentas-pg-test-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

async function inquilino(nombre) {
  return enPlaya(() => ds.getRepository(Customer).save({ firstName: nombre, lastName: 'Prueba', customerType: 'RENTER', numberOfVehicles: 1 }));
}
async function totalCaja() {
  return Number((await ds.getRepository(Box).createQueryBuilder('b').select('COALESCE(SUM(b.totalPrice),0)', 'sum').getRawOne()).sum);
}
async function pendiente(customerId) {
  const filas = await ds.getRepository(Receipt).find({ where: { customer: { id: customerId }, status: 'PENDING' } });
  return filas.reduce((s, r) => s + r.price, 0);
}

test('vuelca la historia vieja, cobra en fracciones, deja saldo a favor y lo consume el recibo siguiente', { timeout: 30000 }, async () => {
  const c = await inquilino('Vieja');
  // Historia anterior a la cuenta corriente: un recibo pagado y otro con un pago parcial.
  await enPlaya(async () => {
    const pagado = await ds.getRepository(Receipt).save({ customer: c, status: 'PAID', price: 0, startAmount: 1000, startDate: `${mes(-2)}-02`, dateNow: `${mes(-2)}-02`, receiptTypeKey: 'X', receiptNumber: 'N° 0000-00000001' });
    await ds.getRepository(ReceiptPayment).save({ receipt: pagado, paymentType: 'CASH', price: 1000, paymentDate: `${mes(-2)}-05` });
    const parcial = await ds.getRepository(Receipt).save({ customer: c, status: 'PENDING', price: 1500, startAmount: 2000, startDate: `${mes(-1)}-02`, dateNow: `${mes(-1)}-02`, receiptTypeKey: 'X', receiptNumber: 'N° 0000-00000002' });
    await ds.getRepository(ReceiptPayment).save({ receipt: parcial, paymentType: 'TRANSFER', price: 500, paymentDate: `${mes(-1)}-06` });
  });

  const estado = await enPlaya(() => cuentas.estado(c.id));
  assert.equal(estado.saldo, 1500, 'el libro vuelca la historia y cuadra con lo pendiente');
  assert.equal(estado.movimientos.length, 4);
  assert.ok(estado.movimientos.every((m) => m.migrado));

  const cajaAntes = await totalCaja();
  const pago1 = await enPlaya(() => cuentas.registrarPago(c.id, { pagos: [{ metodo: 'CASH', importe: 1000 }] }, user.id));
  assert.equal(pago1.numero, '00000001');
  assert.equal(pago1.saldo, 500);
  assert.equal(await totalCaja(), cajaAntes + 1000, 'el efectivo entra a la caja');
  assert.equal(await pendiente(c.id), 500);

  const pago2 = await enPlaya(() => cuentas.registrarPago(c.id, { pagos: [{ metodo: 'TRANSFER', importe: 800 }] }, user.id));
  assert.equal(pago2.numero, '00000002');
  assert.equal(pago2.aFavor, 300);
  assert.equal(pago2.saldo, -300);
  assert.equal(await totalCaja(), cajaAntes + 1000, 'la transferencia no toca la caja física');
  assert.equal((await ds.getRepository(Customer).findOneBy({ id: c.id })).credit, 300);

  // El recibo del mes nuevo consume el saldo a favor en el acto.
  const nuevo = await enPlaya(() => ds.transaction((m) => receipts.createReceipt(c.id, m, 1000, `${mes(0)}-02`)));
  assert.equal(nuevo.price, 700);
  assert.equal(await pendiente(c.id), 700);

  // Anular el segundo pago devuelve la deuda y deshace el crédito que ya se había usado.
  const filaPago2 = await ds.getRepository(CuentaMovimiento).findOneBy({ numero: '00000002' });
  const anulado = await enPlaya(() => cuentas.anular(filaPago2.id, { motivo: 'Se cargó por error', confirmacion: 800 }, user.id));
  assert.equal(anulado.saldo, 1500);
  assert.equal(await pendiente(c.id), 1500, 'los recibos vuelven a cuadrar con el libro');
  await assert.rejects(enPlaya(() => cuentas.anular(filaPago2.id, { motivo: 'Otra vez lo mismo', confirmacion: 800 }, user.id)), /anulado/);

  // Un cobro con dos medios: el comprobante muestra una línea por recibo, y lo que se reimprime
  // después sale de lo guardado al cobrar, no del estado del día.
  const mixto = await enPlaya(() => cuentas.registrarPago(c.id, { pagos: [{ metodo: 'CASH', importe: 300 }, { metodo: 'TRANSFER', importe: 400 }] }, user.id));
  assert.deepEqual(mixto.imputaciones.map((i) => [i.aplicado, i.saldoRecibo]), [[500, 0], [200, 800]]);
  assert.equal(mixto.saldo, 800);
  await enPlaya(() => cuentas.registrarPago(c.id, { pagos: [{ metodo: 'CASH', importe: 100 }] }, user.id));
  const comprobante = (await enPlaya(() => cuentas.estado(c.id))).comprobantes.find((p) => p.numero === mixto.numero);
  assert.equal(comprobante.saldoDespues, 800);
  assert.deepEqual(comprobante.imputaciones.map((i) => [i.aplicado, i.resta]), [[500, 0], [200, 800]]);
});

test('saldo inicial por mes, bonificación y sus anulaciones', { timeout: 30000 }, async () => {
  const c = await inquilino('Nuevo');
  await enPlaya(() => cuentas.registrarSaldoInicial(c.id, { tipo: 'DEUDA', modo: 'POR_MES', meses: [{ mes: mes(-2), importe: 900 }, { mes: mes(-1), importe: 1100 }] }, user.id));
  let estado = await enPlaya(() => cuentas.estado(c.id));
  assert.equal(estado.saldo, 2000);
  assert.equal(estado.recibos.length, 2);
  assert.ok(estado.tieneSaldoInicial);
  await assert.rejects(
    enPlaya(() => cuentas.registrarSaldoInicial(c.id, { tipo: 'A_FAVOR', importe: 100 }, user.id)),
    (e) => e.response?.code === 'SALDO_INICIAL_EXISTENTE',
  );

  await enPlaya(() => cuentas.registrarAjuste(c.id, { tipo: 'BONIFICACION', importe: 400, motivo: 'Descuento acordado' }, user.id));
  estado = await enPlaya(() => cuentas.estado(c.id));
  assert.equal(estado.saldo, 1600);
  assert.equal(await pendiente(c.id), 1600, 'la bonificación baja el recibo más viejo');

  const bonificacion = estado.movimientos.find((m) => m.tipo === 'AJUSTE');
  await enPlaya(() => cuentas.anular(bonificacion.id, { motivo: 'No correspondía el descuento', confirmacion: 400 }, user.id));
  assert.equal(await pendiente(c.id), 2000);

  // Un recibo con pagos no se anula; sin pagos, se anula su cargo. Y nunca por el borrado viejo.
  await enPlaya(() => cuentas.registrarPago(c.id, { pagos: [{ metodo: 'CASH', importe: 100 }] }, user.id));
  const recibos = await ds.getRepository(Receipt).find({ where: { customer: { id: c.id } }, order: { startDate: 'ASC' } });
  await assert.rejects(enPlaya(() => receipts.deleteReceipt(recibos[1].id)), (e) => e.response?.code === 'USAR_CUENTA_CORRIENTE');
  estado = await enPlaya(() => cuentas.estado(c.id));
  const [conPago, sinPago] = recibos.map((r) => estado.recibos.find((x) => x.id === r.id).origen);
  assert.equal(conPago.anulable.code, 'RECIBO_CON_PAGOS');
  await assert.rejects(
    enPlaya(() => cuentas.anular(conPago.id, { motivo: 'Se cargó dos veces', confirmacion: 900 }, user.id)),
    (e) => e.response?.code === 'RECIBO_CON_PAGOS',
  );
  assert.ok(sinPago.anulable.ok);
  await enPlaya(() => cuentas.anular(sinPago.id, { motivo: 'Se cargó dos veces', confirmacion: 1100 }, user.id));
  estado = await enPlaya(() => cuentas.estado(c.id));
  assert.equal(estado.saldo, 800);
  assert.equal(await pendiente(c.id), 800);
});

test('recargo genera un cargo propio, sin período, y no reemplaza el abono del mes', { timeout: 30000 }, async () => {
  const c = await inquilino('Recargo');
  await enPlaya(() => cuentas.registrarAjuste(c.id, { tipo: 'RECARGO', importe: 250, motivo: 'Interés por mora' }, user.id));
  const recibos = await ds.getRepository(Receipt).find({ where: { customer: { id: c.id } } });
  assert.equal(recibos.length, 1);
  assert.match(recibos[0].concepto, /^Recargo/);
  assert.equal(recibos[0].tipoCargo, 'RECARGO');
  assert.equal(recibos[0].periodo, null);
  assert.equal((await enPlaya(() => cuentas.estado(c.id))).saldo, 250);
});

test('los inquilinos no pasan por el cobro viejo y la sección apagada no responde', { timeout: 30000 }, async () => {
  const c = await inquilino('Bloqueos');
  const r = await enPlaya(() => ds.transaction((m) => receipts.createReceipt(c.id, m, 500, `${mes(0)}-02`)));
  await assert.rejects(
    enPlaya(() => receipts.updateReceipt(r.id, c.id, { onAccount: false, payments: [{ paymentType: 'CASH', price: 500 }] })),
    (e) => e.response?.code === 'USAR_CUENTA_CORRIENTE',
  );
  await ds.getRepository(Playa).update(playa.id, { modulos: {} });
  await assert.rejects(enPlaya(() => cuentas.resumen()), (e) => e.response?.code === 'MODULO_INQUILINOS_APAGADO');
  await ds.getRepository(Playa).update(playa.id, { modulos: { inquilinos: true } });
  const resumen = await enPlaya(() => cuentas.resumen());
  assert.ok(resumen.inquilinos.some((i) => i.id === c.id && i.saldo === 500));
  assert.ok(resumen.kpis.saldoPendiente >= 500);
});

test('anular tiene plazo, pide motivo e importe, y queda en el listado de anulaciones', { timeout: 30000 }, async () => {
  const c = await inquilino('Plazos');
  const cargo = await enPlaya(() => ds.transaction((m) => receipts.createReceipt(c.id, m, 700, `${mes(0)}-02`)));
  let estado = await enPlaya(() => cuentas.estado(c.id));
  const origen = estado.recibos.find((r) => r.id === cargo.id).origen;
  assert.ok(origen.anulable.ok);

  await assert.rejects(
    enPlaya(() => cuentas.anular(origen.id, { motivo: 'error', confirmacion: 700 }, user.id)),
    (e) => e.response?.code === 'MOTIVO_CORTO',
  );
  await assert.rejects(
    enPlaya(() => cuentas.anular(origen.id, { motivo: 'Se cargó por error', confirmacion: 70 }, user.id)),
    (e) => e.response?.code === 'CONFIRMACION_INCORRECTA',
  );

  // Cargado el mes pasado (en hora argentina): ya no se anula, se bonifica.
  await ds.query(
    `UPDATE cuenta_movimientos
     SET "createdAt" = (date_trunc('month', now() AT TIME ZONE 'America/Argentina/Buenos_Aires') - interval '2 days') AT TIME ZONE 'America/Argentina/Buenos_Aires'
     WHERE id = $1`,
    [origen.id],
  );
  estado = await enPlaya(() => cuentas.estado(c.id));
  assert.equal(estado.recibos.find((r) => r.id === cargo.id).origen.anulable.code, 'FUERA_DE_PLAZO');
  await assert.rejects(
    enPlaya(() => cuentas.anular(origen.id, { motivo: 'Se cargó por error', confirmacion: 700 }, user.id)),
    (e) => e.response?.code === 'FUERA_DE_PLAZO',
  );

  // Un pago se anula solo mientras siga abierto el turno en que se cobró.
  const turnos = ds.getRepository(Turno);
  const turno = await enPlaya(() => turnos.save(turnos.create({ cashVersion: 2, fondoInicial: 0, usuarioApertura: user, estado: 'ABIERTO' })));
  await enPlaya(() => cuentas.registrarPago(c.id, { pagos: [{ metodo: 'CASH', importe: 300 }] }, user.id));
  const pago = await ds.getRepository(CuentaMovimiento).findOne({ where: { customerId: c.id, tipo: 'PAGO' } });
  assert.equal(pago.detalle.turnoId, turno.id);
  estado = await enPlaya(() => cuentas.estado(c.id));
  assert.ok(estado.comprobantes[0].anulable.ok, 'con el turno abierto se puede');
  await turnos.update(turno.id, { estado: 'CERRADO' });
  estado = await enPlaya(() => cuentas.estado(c.id));
  assert.equal(estado.comprobantes[0].anulable.code, 'TURNO_CERRADO');
  await assert.rejects(
    enPlaya(() => cuentas.anular(pago.id, { motivo: 'Se cobró de más', confirmacion: 300 }, user.id)),
    (e) => e.response?.code === 'TURNO_CERRADO',
  );

  // Lo anulado en los tests anteriores queda en el listado del mes, con quién y por qué.
  const listado = await enPlaya(() => cuentas.anulaciones(mes(0)));
  const pagoAnulado = listado.lista.find((l) => l.tipo === 'PAGO' && l.motivo === 'Se cargó por error');
  assert.equal(pagoAnulado.efecto, 800, 'anular un pago vuelve a poner la deuda');
  assert.equal(pagoAnulado.usuario, 'Ada Admin');
  assert.ok(listado.lista.some((l) => l.tipo === 'SALDO_INICIAL' && l.efecto === -1100));
  assert.equal(listado.totales.deudaAnulada, 1100);
  const resumen = await enPlaya(() => cuentas.resumen());
  assert.equal(resumen.kpis.anulacionesMes, listado.totales.cantidad);
});

// Inquilino con cocheras: el abono que se le carga sale de ellas.
async function inquilinoConCocheras(nombre, ...importes) {
  const c = await inquilino(nombre);
  for (const [i, amount] of importes.entries())
    await enPlaya(() => ds.getRepository(ParkingRenter).save({ customer: c, owner: 'Tipo prueba', garageNumber: `${nombre}-${i + 1}`, amount }));
  return c;
}
const cargosDe = (customerId) => ds.getRepository(Receipt).find({ where: { customer: { id: customerId } }, order: { createdAt: 'ASC' } });
const serviciosDeCocheras = () =>
  new ParkingRentersService(
    ds.getRepository(ParkingRenter), ds.getRepository(ParkingOwner), ds.getRepository(RenterParkingType),
    ds.getRepository(Customer), ds.getRepository(Receipt),
  );

test('cargar abonos: vista previa exacta, una sola vez por período aunque lleguen juntos', { timeout: 30000 }, async () => {
  const a = await inquilinoConCocheras('Abono A', 500);
  const b = await inquilinoConCocheras('Abono B', 300, 400);
  const sin = await inquilino('Sin cochera');
  const siguiente = mes(1);

  const plan = await enPlaya(() => cuentas.previsualizarAbonos(siguiente));
  assert.equal(plan.aCargar.find((x) => x.id === a.id).importe, 500);
  assert.equal(plan.aCargar.find((x) => x.id === b.id).importe, 700);
  assert.match(plan.sinCargar.find((x) => x.id === sin.id).motivo, /cocheras/);
  await assert.rejects(enPlaya(() => cuentas.previsualizarAbonos(mes(-1))), /Solo se cargan/);

  // Dos cargas simultáneas del mismo mes: cada inquilino recibe un solo cargo.
  const [r1, r2] = await Promise.all([
    enPlaya(() => cuentas.cargarAbonos(siguiente, 15, user.id)),
    enPlaya(() => cuentas.cargarAbonos(siguiente, 15, user.id)),
  ]);
  assert.equal(r1.cargados + r2.cargados, plan.aCargar.length);
  for (const c of [a, b]) {
    const cargos = (await cargosDe(c.id)).filter((r) => r.periodo === siguiente);
    assert.equal(cargos.length, 1);
    assert.equal(cargos[0].tipoCargo, 'ABONO');
    assert.equal(cargos[0].vencimiento, `${siguiente}-15`);
  }
  const otra = await enPlaya(() => cuentas.cargarAbonos(siguiente, 15, user.id));
  assert.equal(otra.cargados, 0);
  assert.ok(otra.yaCargados.some((x) => x.id === a.id));

  // Ni cargándolo a mano: el índice único rechaza un segundo cargo del mismo período.
  await assert.rejects(
    enPlaya(() => ds.transaction((m) => receipts.createReceipt(a.id, m, 500, `${siguiente}-02`))),
    (e) => e.response?.code === 'CARGO_DEL_PERIODO_EXISTENTE',
  );
});

test('la baja conserva la deuda, deja cobrar y no recibe más abonos', { timeout: 30000 }, async () => {
  const c = await inquilinoConCocheras('Baja', 900);
  await enPlaya(() => ds.transaction((m) => receipts.createReceipt(c.id, m, 900, `${mes(0)}-02`)));
  const clientes = new CustomersService(
    ds.getRepository(Customer), ds.getRepository(Receipt), ds.getRepository(InterestSettings),
    receipts, null, ds, null, serviciosDeCocheras(), cuentas,
  );
  await enPlaya(() => clientes.softDelete(c.id));

  const cargos = await ds.getRepository(Receipt).find({ where: { customer: { id: c.id } }, withDeleted: true });
  assert.equal(cargos.length, 1);
  assert.equal(cargos[0].deletedAt, null, 'el cargo sigue a la vista');
  const estado = await enPlaya(() => cuentas.estado(c.id));
  assert.equal(estado.recibos.length, 1, 'su cuenta muestra el cargo');
  const fila = (await enPlaya(() => cuentas.resumen())).inquilinos.find((i) => i.id === c.id);
  assert.ok(fila.baja);
  assert.equal(fila.saldo, 900);
  assert.equal(fila.abono, 0);

  const cobro = await enPlaya(() => cuentas.registrarPago(c.id, { pagos: [{ metodo: 'TRANSFER', importe: 900 }] }, user.id));
  assert.equal(cobro.saldo, 0);
  assert.equal(cobro.imputaciones[0].saldoRecibo, 0, 'el cobro se aplica a su cargo');
  assert.equal((await enPlaya(() => cuentas.estado(c.id))).recibos[0].situacion, 'SALDADO');
  const resumen = await enPlaya(() => cuentas.resumen());
  assert.equal(resumen.inquilinos.find((i) => i.id === c.id).saldo, 0);
  assert.ok(resumen.kpis.cobradoMes >= 900, 'lo cobrado a un dado de baja cuenta en el mes');

  const plan = await enPlaya(() => cuentas.previsualizarAbonos(mes(1)));
  assert.ok(![...plan.aCargar, ...plan.sinCargar, ...plan.yaCargados].some((x) => x.id === c.id), 'no se le cargan más abonos');
});

test('un cobro reintentado con el mismo identificador no se registra dos veces', { timeout: 30000 }, async () => {
  const c = await inquilino('Reintento');
  await enPlaya(() => ds.transaction((m) => receipts.createReceipt(c.id, m, 1000, `${mes(0)}-02`)));
  const cajaAntes = await totalCaja();
  const pedido = {
    pagos: [{ metodo: 'CASH', importe: 400 }, { metodo: 'TRANSFER', importe: 100 }],
    solicitudId: '6f1d8c1e-6a51-4c2e-9d3b-2f7c1a9e4b10',
  };
  const primero = await enPlaya(() => cuentas.registrarPago(c.id, pedido, user.id));
  const segundo = await enPlaya(() => cuentas.registrarPago(c.id, pedido, user.id));
  assert.equal(primero.repetido, false);
  assert.equal(segundo.repetido, true);
  assert.equal(segundo.numero, primero.numero);
  assert.equal(segundo.saldo, 500);
  assert.equal((await ds.getRepository(CuentaMovimiento).find({ where: { customerId: c.id, tipo: 'PAGO' } })).length, 2, 'dos medios, un solo cobro');
  assert.equal(await totalCaja(), cajaAntes + 400, 'el efectivo entra una sola vez');
});

test('un descuento no se muestra como plata pagada', { timeout: 30000 }, async () => {
  const c = await inquilino('Descuento');
  const cargo = await enPlaya(() => ds.transaction((m) => receipts.createReceipt(c.id, m, 80000, `${mes(0)}-02`)));
  await enPlaya(() => cuentas.registrarAjuste(c.id, { tipo: 'BONIFICACION', importe: 10000, motivo: 'Descuento pactado' }, user.id));
  await enPlaya(() => cuentas.registrarPago(c.id, { pagos: [{ metodo: 'TRANSFER', importe: 70000 }] }, user.id));
  const r = (await enPlaya(() => cuentas.estado(c.id))).recibos.find((x) => x.id === cargo.id);
  assert.equal(r.total, 80000);
  assert.equal(r.pagado, 70000);
  assert.equal(r.bonificado, 10000);
  assert.equal(r.aFavorAplicado, 0);
  assert.equal(r.situacion, 'SALDADO');
});

test('pendiente no es vencido: la deuda vence en su fecha', { timeout: 30000 }, async () => {
  const c = await inquilino('Vencimientos');
  await enPlaya(() => cuentas.registrarSaldoInicial(c.id, { tipo: 'DEUDA', modo: 'POR_MES', meses: [{ mes: mes(-2), importe: 600 }] }, user.id));
  await enPlaya(() => ds.transaction((m) => receipts.createReceipt(c.id, m, 400, `${mes(1)}-02`)));
  const fila = (await enPlaya(() => cuentas.resumen())).inquilinos.find((i) => i.id === c.id);
  assert.equal(fila.saldo, 1000);
  assert.equal(fila.vencido, 600, 'solo lo del mes viejo está vencido');
  assert.equal(fila.estado, 'VENCIDO');
  const estado = await enPlaya(() => cuentas.estado(c.id));
  assert.equal(estado.antiguedad.PENDIENTE, 400);
  assert.equal(estado.vencido, 600);
  assert.equal(estado.recibos.find((r) => r.periodo === mes(1)).vencido, false);
  assert.equal(estado.proximoAbono, mes(0), 'el mes actual todavía no tiene su abono');
});

test('devolver plata es una devolución de saldo a favor, con su salida de caja', { timeout: 30000 }, async () => {
  const c = await inquilino('Devolucion');
  await enPlaya(() => cuentas.registrarPago(c.id, { pagos: [{ metodo: 'CASH', importe: 300 }] }, user.id));
  await assert.rejects(
    enPlaya(() => cuentas.registrarDevolucion(c.id, { importe: 500, metodo: 'CASH', motivo: 'Se va del edificio' }, user.id)),
    (e) => e.response?.code === 'DEVOLUCION_SIN_SALDO_A_FAVOR',
  );
  const cajaAntes = await totalCaja();
  const hecho = await enPlaya(() => cuentas.registrarDevolucion(c.id, { importe: 300, metodo: 'CASH', motivo: 'Se va del edificio' }, user.id));
  assert.equal(hecho.saldo, 0);
  assert.equal(await totalCaja(), cajaAntes - 300, 'el efectivo sale de la caja');

  const fila = await ds.getRepository(CuentaMovimiento).findOne({ where: { customerId: c.id, tipo: 'DEVOLUCION' } });
  const estado = await enPlaya(() => cuentas.estado(c.id));
  assert.ok(estado.movimientos.find((m) => m.id === fila.id).anulable.ok);
  await enPlaya(() => cuentas.anular(fila.id, { motivo: 'Al final no se devolvió', confirmacion: 300 }, user.id));
  assert.equal(await totalCaja(), cajaAntes, 'anularla vuelve a entrar el efectivo');
  assert.equal((await enPlaya(() => cuentas.estado(c.id))).saldo, -300);
});

test('un precio nuevo rige para los abonos siguientes y no reescribe cargos', { timeout: 30000 }, async () => {
  const tipo = await enPlaya(() => ds.getRepository(RenterParkingType).save({ name: 'Tipo cambio', amount: 500 }));
  const c = await inquilino('Cambio de precio');
  await enPlaya(() => ds.getRepository(ParkingRenter).save({ customer: c, owner: 'Tipo cambio', parkingType: tipo, garageNumber: 'CP-1', amount: 500 }));
  const cargo = await enPlaya(() => ds.transaction((m) => receipts.createReceipt(c.id, m, 500, `${mes(0)}-02`)));
  await enPlaya(() => serviciosDeCocheras().updateRenterParkingType(tipo.id, { amount: 650, month: mes(0) }));

  const guardado = await ds.getRepository(Receipt).findOneBy({ id: cargo.id });
  assert.equal(guardado.price, 500, 'el cargo ya registrado conserva su importe');
  assert.equal((await enPlaya(() => cuentas.estado(c.id))).saldo, 500, 'la cuenta sigue cuadrando');
  const plan = await enPlaya(() => cuentas.previsualizarAbonos(mes(1)));
  assert.equal(plan.aCargar.find((x) => x.id === c.id).importe, 650, 'el próximo abono sale con el precio nuevo');
});

test('cocheras de inquilino con número y precio, sin propietario', { timeout: 30000 }, async () => {
  const clientes = new CustomersService(
    ds.getRepository(Customer), ds.getRepository(Receipt), ds.getRepository(InterestSettings),
    receipts, null, ds, null, serviciosDeCocheras(), cuentas,
  );
  const alta = (datos) => enPlaya(() => clientes.create({ phone: '', customerType: 'RENTER', ...datos }));

  await assert.rejects(
    alta({ firstName: 'Sin', lastName: 'Precio', numberOfVehicles: 1, parkingRenters: [{ garageNumber: 'SD-0' }] }),
    /precio mensual/,
  );
  const c = await alta({
    firstName: 'Libre', lastName: 'Cochera', numberOfVehicles: 2,
    parkingRenters: [{ garageNumber: 'SD-1', amount: 45000 }, { garageNumber: 'SD-2', amount: 5000 }],
  });
  const cocheras = await ds.getRepository(ParkingRenter).find({ where: { customer: { id: c.id } }, order: { garageNumber: 'ASC' } });
  assert.deepEqual(cocheras.map((r) => [r.garageNumber, r.amount, r.owner]), [['SD-1', 45000, null], ['SD-2', 5000, null]]);
  assert.equal((await enPlaya(() => cuentas.estado(c.id))).cliente.abono, 50000);
  const plan = await enPlaya(() => cuentas.previsualizarAbonos(mes(1)));
  assert.equal(plan.aCargar.find((x) => x.id === c.id)?.importe, 50000, 'sin dueño igual se le cargan los abonos');
  await assert.rejects(
    alta({ firstName: 'Otra', lastName: 'Cochera', numberOfVehicles: 1, parkingRenters: [{ garageNumber: ' sd-1 ', amount: 100 }] }),
    /ya se encuentra en uso/,
  );

  // Editar: el precio se escribe; una cochera con tipo de dueño pasa a llevar el precio escrito.
  const tipo = await enPlaya(() => ds.getRepository(RenterParkingType).save({ name: 'Tipo viejo', amount: 800 }));
  const viejo = await inquilino('Con tipo');
  await enPlaya(() => ds.getRepository(ParkingRenter).save({ customer: viejo, owner: 'Tipo viejo', parkingType: tipo, garageNumber: 'TV-1', amount: 800 }));
  await enPlaya(() => clientes.update(viejo.id, { numberOfVehicles: 1, monthsDebt: [], parkingRenters: [{ garageNumber: 'TV-1', amount: 950 }] }));
  const editada = await ds.getRepository(ParkingRenter).findOne({ where: { customer: { id: viejo.id } }, relations: ['parkingType'] });
  assert.equal(editada.amount, 950);
  assert.equal(editada.owner, null);
  assert.equal(editada.parkingType, null);
  await enPlaya(() => serviciosDeCocheras().updateRenterParkingType(tipo.id, { amount: 2000 }));
  assert.equal((await ds.getRepository(ParkingRenter).findOneBy({ id: editada.id })).amount, 950, 'un cambio del tipo ya no la pisa');
});

test('cobro con QR de MercadoPago: se asienta una sola vez, no pasa por la caja y no se anula', { timeout: 30000 }, async () => {
  // MercadoPago de mentira: genera el link y, cuando se le indica, informa el pago aprobado.
  let pagoAprobado = null;
  const mercadoPago = {
    crearPreferencia: async (_empresa, datos) => ({ preferenceId: `pref-${datos.referencia}`, initPoint: `https://mp.test/pagar/${datos.referencia}` }),
    buscarPagoAprobado: async () => pagoAprobado,
  };
  const cobrosMp = new CobrosMercadoPagoService(ds.getRepository(CobroMercadoPago), mercadoPago, null, { get: () => '' }, cuentas);

  const c = await inquilino('Con QR');
  await enPlaya(() => ds.transaction((m) => receipts.createReceipt(c.id, m, 600, `${mes(0)}-02`)));
  const proximo = await enPlaya(() => ds.transaction((m) => receipts.createReceipt(c.id, m, 400, `${mes(1)}-02`)));

  await assert.rejects(enPlaya(() => cobrosMp.crear(c.id, 'INQUILINO', user.id, {})), /importe/);
  const cobro = await enPlaya(() =>
    cobrosMp.crear(c.id, 'INQUILINO', user.id, { monto: 1000, receiptIds: [proximo.id], nota: 'Pagó con el celular' }),
  );
  assert.equal(cobro.estado, 'PENDIENTE');
  assert.match(cobro.initPoint, /mp\.test/);
  assert.equal((await enPlaya(() => cobrosMp.consultar(cobro.id))).estado, 'PENDIENTE', 'sin pago todavía');

  pagoAprobado = { id: 'mp-777', monto: 1000 };
  const cajaAntes = await totalCaja();
  const acreditado = await enPlaya(() => cobrosMp.consultar(cobro.id));
  assert.equal(acreditado.estado, 'ACREDITADO');
  assert.equal(acreditado.recibo.total, 1000);
  assert.equal(acreditado.recibo.medios[0].metodo, 'MERCADOPAGO');
  assert.equal(acreditado.recibo.saldo, 0);
  assert.equal(acreditado.recibo.nota, 'Pagó con el celular');

  await enPlaya(() => cobrosMp.consultar(cobro.id));
  const pagos = await ds.getRepository(CuentaMovimiento).find({ where: { customerId: c.id, tipo: 'PAGO' } });
  assert.equal(pagos.length, 1, 'consultar de nuevo no vuelve a asentar');
  assert.equal(await totalCaja(), cajaAntes, 'MercadoPago no entra a la caja física');

  const estado = await enPlaya(() => cuentas.estado(c.id));
  const cargoElegido = estado.recibos.find((r) => r.id === proximo.id);
  assert.equal(cargoElegido.situacion, 'SALDADO');
  assert.equal(cargoElegido.pagos[0].tipo, 'MERCADOPAGO');
  assert.equal(estado.comprobantes[0].anulable.code, 'PAGO_MERCADOPAGO', 'la plata entró: se devuelve, no se anula');
});

test('el recibo de un pago se entrega como comprobante público según la configuración', { timeout: 30000 }, async () => {
  const c = await inquilino('Recibo');
  await ds.getRepository(Customer).update(c.id, { phone: '12345' });
  await enPlaya(() => ds.transaction((m) => receipts.createReceipt(c.id, m, 700, `${mes(0)}-02`)));
  const pago = await enPlaya(() => cuentas.registrarPago(c.id, { pagos: [{ metodo: 'CASH', importe: 700 }] }, user.id));

  assert.equal(
    (await enPlaya(() => cuentas.emitirComprobante(pago.id))).deshabilitado,
    true,
    'sin QR ni térmica y sin un celular válido no hay cómo entregarlo',
  );

  // Con celular alcanza para mandarlo por WhatsApp, aunque la playa tenga todo apagado.
  await ds.getRepository(Customer).update(c.id, { phone: '261 555-0101' });
  const emitido = await enPlaya(() => cuentas.emitirComprobante(pago.id));
  assert.equal(emitido.deshabilitado, false);
  assert.equal(emitido.settings.qr, false);
  assert.equal(emitido.telefono, '5492615550101');

  await ds.query(
    `INSERT INTO ticket_schedule_settings ("playaId", "dayStartHour", "dayEndHour", "receiptDelivery") VALUES ($1, 8, 20, $2)`,
    [playa.id, JSON.stringify({ whatsapp: false, qr: true, print: false, paperWidth: 80 })],
  );
  const conQr = await enPlaya(() => cuentas.emitirComprobante(pago.id));
  assert.equal(conQr.settings.qr, true);
  assert.equal(conQr.token, emitido.token, 'prender un medio no cambia el enlace ya emitido');
  assert.match(emitido.token, /^[a-f0-9]{64}$/);
  assert.equal(emitido.snapshot.kind, 'PAGO');
  assert.equal(emitido.snapshot.numero, pago.numero);
  assert.equal(emitido.snapshot.total, 700);
  assert.deepEqual(emitido.snapshot.medios, [{ medio: 'Efectivo', importe: 700 }]);
  assert.equal(emitido.snapshot.aplicado[0].queda, 0);
  assert.equal(emitido.telefono, '5492615550101');
  assert.equal((await enPlaya(() => cuentas.emitirComprobante(pago.id))).token, emitido.token, 'pedirlo de nuevo da el mismo enlace');

  const lector = new ParkingReceiptsService(ds, null);
  const publico = await lector.readPublic(emitido.token);
  assert.equal(publico.cliente, 'Prueba Recibo');
  assert.equal(publico.anulado, false);
  assert.equal(JSON.stringify(publico).includes(user.id), false, 'no expone usuarios');

  await enPlaya(() => cuentas.anular(pago.id, { motivo: 'Se cobró por error', confirmacion: 700 }, user.id));
  assert.equal((await lector.readPublic(emitido.token)).anulado, true, 'el enlace muestra que se anuló');
  await assert.rejects(enPlaya(() => cuentas.emitirComprobante(pago.id)), /anulado/);
});
