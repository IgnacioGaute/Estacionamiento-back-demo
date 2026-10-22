// Modalidad de operación por playa (Con cobro / Gratuito). Ejecutar después de pnpm build.
// PostgreSQL efímero con RLS, guard e interceptor reales: nunca lee .env ni usa la base del proyecto.
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
const load = (p, name) => require('../dist/' + p)[name];
const Ticket = load('tickets/entities/ticket.entity', 'Ticket');
const Registration = load('tickets/entities/ticket-registration.entity', 'TicketRegistration');
const User = load('users/entities/user.entity', 'User');
const Empresa = load('tenancy/entities/empresa.entity', 'Empresa');
const Playa = load('tenancy/entities/playa.entity', 'Playa');
const { tenantContext } = require('../dist/tenancy/tenant-context');

let ds, root, app, pgStarted = false;
const bin = process.env.PG_TEST_BIN || 'C:/Program Files/PostgreSQL/18/bin';
const pg = (name, args) => {
  // PostgreSQL hereda stdout en Windows; un pipe mantendría spawnSync esperando aunque pg_ctl termine.
  const output = fs.openSync(path.join(root, 'commands.log'), 'a');
  try {
    return execFileSync(path.join(bin, name + (process.platform === 'win32' ? '.exe' : '')), args, { windowsHide: true, stdio: ['ignore', output, output], timeout: 30000 });
  } finally { fs.closeSync(output); }
};
const freePort = () => new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'modalidad-pg-test-'));
  pg('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--locale=C']);
  const port = await freePort();
  pgStarted = true;
  pg('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'postgres.log'), '-o', '-h 127.0.0.1 -p ' + port + ' -F', '-w', 'start']);
  ds = new DataSource({
    type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: 'postgres',
    entities: [path.resolve('dist/**/*.entity.js')],
    migrations: [load('database/migrations/1790000000000-flexible-vehicle-types', 'FlexibleVehicleTypes1790000000000')],
    migrationsRun: true, synchronize: true,
  });
  await ds.initialize();
  const { Test } = require('@nestjs/testing');
  const { TypeOrmModule } = require('@nestjs/typeorm');
  const { ConfigModule } = require('@nestjs/config');
  const { ValidationPipe } = require('@nestjs/common');
  const { installTenantConnections } = require('../dist/tenancy/tenant-context');
  const runner = ds.createQueryRunner();
  try {
    for (const [file, name] of [
      ['1790000001000-tenant-isolation', 'TenantIsolation1790000001000'],
      ['1790000002000-auth-version', 'AuthVersion1790000002000'],
      ['1790000004000-parking-receipts', 'ParkingReceipts1790000004000'],
      ['1790000009000-mercadopago-cuentas', 'MercadoPagoCuentas1790000009000'],
      ['1790000011000-cobros-mercadopago', 'CobrosMercadoPago1790000011000'],
      ['1790000010000-offline-sessions', 'OfflineSessions1790000010000'],
      ['1790000013000-offline-multiple-devices', 'OfflineMultipleDevices1790000013000'],
      ['1790000021000-suscripciones', 'Suscripciones1790000021000'],
      ['1790000022000-cuenta-alta', 'CuentaAlta1790000022000'],
      ['1790000023000-facturas-anticipadas', 'FacturasAnticipadas1790000023000'],
      ['1790000024000-debito-automatico', 'DebitoAutomatico1790000024000'],
      ['1790000025000-periodos-de-pago', 'PeriodosDePago1790000025000'],
      ['1790000026000-plate-recognizer-cuentas', 'PlateRecognizerCuentas1790000026000'],
      ['1790000028000-cajas-compartidas', 'CajasCompartidas1790000028000'],
      ['1790000029000-condiciones-mercadopago', 'CondicionesMercadoPago1790000029000'],
      ['1790000030000-verificacion-alias', 'VerificacionAlias1790000030000'],
      ['1790000031000-qr-interoperable', 'QrInteroperable1790000031000'],
      ['1790000032000-comisiones-caja', 'ComisionesCaja1790000032000'],
      ['1790000033000-comisiones-medios-mp', 'ComisionesMediosMp1790000033000'],
      ['1790000034000-alias-abonos', 'AliasAbonos1790000034000'],
      ['1790000035000-alias-inquilinos', 'AliasInquilinos1790000035000'],
      ['1790000036000-turnos-diarios', 'TurnosDiarios1790000036000'],
      ['1790000042000-modalidad-operacion', 'ModalidadOperacion1790000042000'],
      ['1790000043000-superadmin-operativo', 'SuperadminOperativo1790000043000'],
    ]) await new (load('database/migrations/' + file, name))().up(runner);
  } finally { await runner.release(); }
  installTenantConnections(ds);
  const options = { ...ds.options, synchronize: false, migrationsRun: false };
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ NEXTAUTH_SECRET: 'modalidad-test-secret', API_SECRET_TOKEN: 'test-static-secret' })] }),
      TypeOrmModule.forRootAsync({
        useFactory: () => options,
        dataSourceFactory: async (opts) => { const db = await new DataSource(opts).initialize(); installTenantConnections(db); return db; },
      }),
      load('tenancy/tenancy.module', 'TenancyModule'),
      load('tickets/tickets.module', 'TicketsModule'),
      load('users/users.module', 'UsersModule'),
      load('notes/notes.module', 'NotesModule'),
      load('auth/auth.module', 'AuthModule'),
      load('receipts/receipts.module', 'ReceiptsModule'),
      load('scanner/scanner.module', 'ScannerModule'),
    ],
    providers: [
      load('utils/strategies/jwt.strategy', 'JwtStrategy'),
      { provide: require('@nestjs/core').APP_GUARD, useClass: load('tenancy/tenant-access', 'TenantGuard') },
      { provide: require('@nestjs/core').APP_INTERCEPTOR, useClass: load('tenancy/tenant-access', 'TenantInterceptor') },
    ],
  }).compile();
  app = module.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1');
});

after(async () => {
  if (app) await app.close();
  if (ds?.isInitialized) await ds.destroy();
  if (pgStarted && fs.existsSync(path.join(root, 'data', 'postmaster.pid'))) pg('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'immediate', '-w', 'stop']);
  if (root) {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('modalidad-pg-test-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

const request = require('supertest');
const { JwtService } = require('@nestjs/jwt');
const jwt = new JwtService({ secret: 'modalidad-test-secret' });
const token = (u) => jwt.sign({ id: u.id, role: u.role, authVersion: u.authVersion ?? 0 }, { expiresIn: '10m' });
// `who` y `playaId`: sin playa, como el operador (su única playa la resuelve el backend).
const http = (method, route, who, playaId) => {
  const r = request(app.getHttpServer())[method](route).set('Authorization', 'Bearer ' + token(who));
  return playaId ? r.set('X-Playa-Id', playaId) : r;
};
const scoped = (scope, fn) => tenantContext.run(scope, fn);
const contar = async (tabla, playaId) => Number((await ds.query(`SELECT count(*) AS n FROM ${tabla} WHERE "playaId" = $1`, [playaId]))[0].n);
const modalidad = (playaId, valor, who = root_) => http('patch', `/tenancy/playas/${playaId}/modalidad`, who).send({ modalidad: valor });

let root_, adminA, adminB, operador, gratis, cobra, otraEmpresa;

test('prepara dos empresas: A con una playa que será gratuita y otra con cobro; B con cobro', async () => {
  const users = ds.getRepository(User);
  root_ = await users.save({ username: 'root', email: 'root@example.test', firstName: 'Root', lastName: 'Test', role: 'SUPER_ADMIN' });
  const eA = await ds.getRepository(Empresa).save({ nombre: 'Empresa A' });
  const eB = await ds.getRepository(Empresa).save({ nombre: 'Empresa B' });
  gratis = await ds.getRepository(Playa).save({ nombre: 'Visitantes', empresaId: eA.id });
  cobra = await ds.getRepository(Playa).save({ nombre: 'Centro', empresaId: eA.id });
  otraEmpresa = await ds.getRepository(Playa).save({ nombre: 'Otra', empresaId: eB.id });
  adminA = await users.save({ username: 'adminA', email: 'a@example.test', firstName: 'Admin', lastName: 'A', role: 'ADMIN', empresaId: eA.id });
  adminB = await users.save({ username: 'adminB', email: 'b@example.test', firstName: 'Admin', lastName: 'B', role: 'ADMIN', empresaId: eB.id });
  operador = await users.save({ username: 'op', email: 'op@example.test', firstName: 'Ana', lastName: 'Operadora', role: 'USER', empresaId: eA.id });
  await ds.query(`INSERT INTO usuario_playas ("usuarioId","playaId","rolPlaya") VALUES ($1,$2,'OPERADOR')`, [operador.id, gratis.id]);
  for (const [who, playa] of [[adminA, gratis], [adminA, cobra], [adminB, otraEmpresa]]) {
    await http('post', '/tickets/vehicle-types', who, playa.id).send({ code: 'AUTO', name: 'Auto' }).expect(201);
    if (playa !== gratis) {
      await http('post', '/tickets/priceBrackets', who, playa.id).send({ vehicleType: 'AUTO', label: 'Hora', uptoMinutes: 60, price: 1000 }).expect(201);
      await http('post', '/tickets/priceBrackets', who, playa.id).send({ vehicleType: 'AUTO', label: 'Extra', price: 1000, recurringUnitMinutes: 60, recurringPriceMode: 'FIXED' }).expect(201);
    }
  }
  // Las playas y estadías existentes quedan con cobro; la restricción rechaza otros valores.
  assert.equal((await ds.getRepository(Playa).findOneBy({ id: gratis.id })).modalidad, 'CON_COBRO');
  await assert.rejects(ds.query(`UPDATE playas SET modalidad = 'OTRA' WHERE id = $1`, [gratis.id]));
  // Repetir la migración no rompe nada (IF NOT EXISTS sobre lo que ya puso synchronize).
  const runner = ds.createQueryRunner();
  try { await new (load('database/migrations/1790000042000-modalidad-operacion', 'ModalidadOperacion1790000042000'))().up(runner); } finally { await runner.release(); }
});

test('solo el super admin cambia la modalidad, por su ruta propia; administradores y operadores la reciben', async () => {
  await modalidad(gratis.id, 'GRATUITO', adminA).expect(403);
  await modalidad(gratis.id, 'GRATUITO', operador).expect(403);
  await modalidad(gratis.id, 'GRATIS').expect(400);
  // La edición de datos de la playa no la acepta.
  await http('patch', `/tenancy/playas/${gratis.id}`, root_).send({ modalidad: 'GRATUITO' }).expect(400);
  // Tampoco la conexión operativa: parking_scoped solo lee playas.
  await assert.rejects(scoped({ empresaId: gratis.empresaId, playaId: gratis.id, userId: adminA.id }, () =>
    ds.query(`UPDATE playas SET modalidad = 'GRATUITO' WHERE id = $1`, [gratis.id])));
  const previa = await http('get', `/tenancy/playas/${gratis.id}/modalidad`, root_).expect(200);
  assert.deepEqual([previa.body.modalidad, previa.body.destino, previa.body.bloqueos], ['CON_COBRO', 'GRATUITO', []]);
  const cambio = await modalidad(gratis.id, 'GRATUITO').expect(200);
  assert.equal(cambio.body.modalidad, 'GRATUITO');
  const auditoria = await ds.query(`SELECT accion, entidad FROM audit_log WHERE "playaId" = $1 AND accion = 'PLAYA_MODALIDAD'`, [gratis.id]);
  assert.equal(auditoria.length, 1);
  assert.match(auditoria[0].entidad, /Con cobro → Gratuito/);
  const operadorCtx = await http('get', '/tenant/context', operador).expect(200);
  assert.deepEqual(operadorCtx.body.playas.map((p) => [p.id, p.modalidad]), [[gratis.id, 'GRATUITO']]);
  const adminCtx = await http('get', '/tenant/context', adminA).expect(200);
  assert.deepEqual(Object.fromEntries(adminCtx.body.playas.map((p) => [p.nombre, p.modalidad])), { Centro: 'CON_COBRO', Visitantes: 'GRATUITO' });
});

let gratuitaPatente;
test('ingreso gratuito por patente sin tarifas: sin snapshot de precios y con los controles de siempre', async () => {
  const entrada = await http('post', '/tickets/registrations/by-plate', operador).send({ licensePlate: 'aa 123 bb', vehicleType: 'AUTO' }).expect(201);
  gratuitaPatente = entrada.body;
  assert.equal(entrada.body.modalidad, 'GRATUITO');
  assert.equal(entrada.body.pricingSnapshot, null);
  assert.equal(entrada.body.entryOperatorName, 'Ana Operadora');
  const duplicada = await http('post', '/tickets/registrations/by-plate', operador).send({ licensePlate: 'AA123BB', vehicleType: 'AUTO' }).expect(400);
  assert.equal(duplicada.body.code, 'DUPLICATE_ACTIVE_PLATE');
  await http('post', '/tickets/registrations/by-plate', operador).send({ licensePlate: 'ZZ999', vehicleType: 'CAMION' }).expect(400);
  const resumen = await http('get', `/tickets/registrations/${entrada.body.id}/close-summary`, operador).expect(200);
  assert.equal(resumen.body.modalidad, 'GRATUITO');
  assert.equal(resumen.body.saldoACobrar, undefined);
  assert.equal(resumen.body.previewBracket, undefined);
  assert.equal(typeof resumen.body.elapsedMinutes, 'number');
  const busqueda = await http('get', '/tickets/registrations/active/search?q=AA123', operador).expect(200);
  assert.deepEqual(busqueda.body.map((r) => r.id), [entrada.body.id]);
});

test('salida gratuita: sin caja, movimientos ni cash_entries; reintentos y pedidos simultáneos no duplican', async () => {
  const [a, b] = await Promise.all([
    http('patch', `/tickets/registrations/${gratuitaPatente.id}/salida`, operador),
    http('patch', `/tickets/registrations/${gratuitaPatente.id}/salida`, operador),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body.departureTime, b.body.departureTime);
  assert.equal(a.body.exitOperatorName, 'Ana Operadora');
  const retry = await http('patch', `/tickets/registrations/${gratuitaPatente.id}/salida`, operador).expect(200);
  assert.equal(retry.body.departureTime, a.body.departureTime);
  for (const tabla of ['movimientos', 'cash_entries', 'box_lists', 'turnos', 'cash_sessions'])
    assert.equal(await contar(tabla, gratis.id), 0, tabla);
  const fila = await ds.getRepository(Registration).findOneBy({ id: gratuitaPatente.id });
  assert.equal(fila.price, 0);
  assert.equal(fila.boxList, undefined);
  assert.equal(fila.pricingBreakdown, null);
});

test('tarjeta física en modalidad gratuita: entra, la segunda lectura prepara la salida y se libera al salir', async () => {
  await scoped({ empresaId: gratis.empresaId, playaId: gratis.id, userId: adminA.id }, () => ds.getRepository(Ticket).save({ codeBar: 'CARD-1', vehicleType: 'AUTO' }));
  const entrada = await http('post', '/scanner/start-scanner', operador).send({ barCode: 'CARD-1' }).expect(201);
  assert.equal(entrada.body.requiresClose, false);
  const segunda = await http('post', '/scanner/start-scanner', operador).send({ barCode: 'CARD-1' }).expect(201);
  assert.equal(segunda.body.requiresClose, true);
  assert.equal(segunda.body.modalidad, 'GRATUITO');
  assert.equal(segunda.body.message, 'Confirmá la salida.');
  const salida = await http('patch', `/tickets/registrations/${segunda.body.registrationId}/salida`, operador).expect(200);
  assert.equal(salida.body.codeBarTicket, 'CARD-1');
  const fila = await ds.getRepository(Registration).findOne({ where: { id: segunda.body.registrationId }, relations: ['ticket'] });
  assert.equal(fila.ticket, null);
  assert.equal(fila.entryMode, 'BARCODE');
  // La tarjeta liberada vuelve a abrir una estadía nueva.
  const otra = await http('post', '/scanner/start-scanner', operador).send({ barCode: 'CARD-1' }).expect(201);
  assert.equal(otra.body.requiresClose, false);
  assert.notEqual(otra.body.registrationId, segunda.body.registrationId);
  await http('patch', `/tickets/registrations/${otra.body.registrationId}/salida`, operador).expect(200);
});

test('en la playa gratuita las operaciones financieras se rechazan, incluso para el administrador', async () => {
  const abierta = (await http('post', '/tickets/registrations/by-plate', operador).send({ licensePlate: 'FREE01', vehicleType: 'AUTO' }).expect(201)).body;
  const bloqueadas = [
    ['patch', `/tickets/registrations/${abierta.id}/close`, { closeType: 'NO_CHARGE', expectedPrice: 0, expectedCollected: 0 }],
    ['patch', `/tickets/registrations/${abierta.id}/advance-payment`, { advancePaidAmount: 100, metodo: 'CASH' }],
    ['post', `/tickets/registrations/${abierta.id}/discount`, { monto: 100, motivo: 'x', expectedPrice: 0, expectedCollected: 0 }],
    ['get', '/tickets/priceBrackets/preview?vehicleType=AUTO&ticketDayType=DAY&elapsedMinutes=60'],
    ['post', '/tickets/priceBrackets', { vehicleType: 'AUTO', label: 'Hora', uptoMinutes: 60, price: 1 }],
    ['post', '/turnos/open', { fondoInicial: 0 }],
    ['post', '/box-lists/otherPayment', { description: 'x', price: 100, type: 'INGRESOS', paymentMethod: 'CASH' }],
    ['post', '/tickets/registrationForDays', { vehicleType: 'AUTO', ticketTimeType: 'DIA', days: 1 }],
  ];
  for (const who of [operador, adminA]) for (const [method, route, body] of bloqueadas) {
    const r = await http(method, route, who, who === adminA ? gratis.id : undefined).send(body ?? {});
    // El operador no tiene algunas rutas (403 por rol) y el resto corta por modalidad: nunca pasa.
    assert.equal(r.status, 403, `${method} ${route}`);
    if (who === adminA) assert.equal(r.body.code, 'MODALIDAD_GRATUITA', `${method} ${route}`);
  }
  // Configuración: tarjetas físicas sí; turnos, horarios de tarifa y comprobantes no.
  await http('patch', '/tickets/schedule-settings', adminA, gratis.id).send({ barcodeTicketsEnabled: true }).expect(200);
  assert.equal((await http('patch', '/tickets/schedule-settings', adminA, gratis.id).send({ shiftsEnabled: true }).expect(403)).body.code, 'MODALIDAD_GRATUITA');
  assert.equal((await http('patch', '/tickets/schedule-settings', adminA, gratis.id).send({ receiptDelivery: { whatsapp: true, qr: true, print: false, paperWidth: 80 } }).expect(403)).body.code, 'MODALIDAD_GRATUITA');
  // Comprobantes: aunque la entrega haya quedado guardada de antes, en gratuita no hay.
  await ds.query(`UPDATE ticket_schedule_settings SET "receiptDelivery" = '{"whatsapp":true,"qr":true,"print":true,"paperWidth":80}'::jsonb WHERE "playaId" = $1`, [gratis.id]);
  const config = (await http('get', '/tickets/schedule-settings', operador).expect(200)).body;
  assert.deepEqual([config.receiptDelivery.whatsapp, config.receiptDelivery.qr, config.receiptDelivery.print], [false, false, false]);
  for (const kind of ['ENTRY', 'EXIT'])
    assert.equal((await http('post', `/tickets/registrations/${gratuitaPatente.id}/receipt`, operador).send({ kind }).expect(403)).body.code, 'MODALIDAD_GRATUITA');
  assert.equal(await contar('parking_receipts', gratis.id), 0);
  const offline = await http('post', '/tickets/offline/prepare', operador).send({ deviceId: '00000000-0000-4000-8000-000000000001' }).expect(201);
  assert.equal(offline.body.modalidad, 'GRATUITO');
  assert.equal(offline.body.pricing, null);
  assert.equal(offline.body.shiftsEnabled, false);
  assert.equal(offline.body.receiptDelivery, null);
  assert.deepEqual(offline.body.receipts, []);
  const unchanged = await http('post', '/tickets/offline/prepare', operador).send({ deviceId: '00000000-0000-4000-8000-000000000001', refresh: true, knownSessionId: offline.body.sessionId }).expect(201);
  assert.equal(unchanged.body.unchanged, true);
  assert.equal(unchanged.body.sessionId, offline.body.sessionId);
  assert.equal(unchanged.body.vehicles, undefined);
  // Segunda barrera, dentro de la transacción: aunque alguien llegue a la caja por otro camino.
  const boxes = app.get(load('box-lists/box-lists.service', 'BoxListsService'));
  await assert.rejects(scoped({ empresaId: gratis.empresaId, playaId: gratis.id, userId: adminA.id }, () =>
    ds.transaction((m) => boxes.applyTicketPayment('2026-10-19', 500, m))), (e) => e.getResponse().code === 'MODALIDAD_GRATUITA');
  for (const tabla of ['movimientos', 'cash_entries', 'box_lists', 'turnos', 'ticket_registration_for_days', 'ticket_price_brackets'])
    assert.equal(await contar(tabla, gratis.id), 0, tabla);
  await http('patch', `/tickets/registrations/${abierta.id}/salida`, operador).expect(200);
});

let conCobroAbierta;
test('la otra playa de la empresa y la otra empresa siguen cobrando igual; las estadías no se cruzan', async () => {
  const entrada = (await http('post', '/tickets/registrations/by-plate', adminA, cobra.id).send({ licensePlate: 'PAY01', vehicleType: 'AUTO' }).expect(201)).body;
  assert.equal(entrada.modalidad, 'CON_COBRO');
  assert.ok(entrada.pricingSnapshot);
  const resumen = (await http('get', `/tickets/registrations/${entrada.id}/close-summary`, adminA, cobra.id).expect(200)).body;
  assert.equal(resumen.modalidad, 'CON_COBRO');
  assert.equal(resumen.saldoACobrar, 1000);
  // Una estadía con cobro no sale por la ruta gratuita.
  assert.equal((await http('patch', `/tickets/registrations/${entrada.id}/salida`, adminA, cobra.id).expect(409)).body.code, 'ESTADIA_CON_COBRO');
  const cerrada = await http('patch', `/tickets/registrations/${entrada.id}/close`, adminA, cobra.id)
    .send({ closeType: 'PAYMENT', metodo: 'CASH', expectedPrice: 1000, expectedCollected: 0 }).expect(200);
  assert.equal(cerrada.body.price, 1000);
  assert.equal(await contar('movimientos', cobra.id), 1);
  assert.equal(await contar('cash_entries', cobra.id), 1);
  const otra = (await http('post', '/tickets/registrations/by-plate', adminB, otraEmpresa.id).send({ licensePlate: 'AA123BB', vehicleType: 'AUTO' }).expect(201)).body;
  assert.equal(otra.modalidad, 'CON_COBRO');
  // La estadía gratuita de la empresa A no existe para la empresa B, ni la salida gratuita la toca.
  await http('patch', `/tickets/registrations/${gratuitaPatente.id}/salida`, adminB, otraEmpresa.id).expect(404);
  await http('get', '/tenant/context', operador).expect(200);
  await http('get', '/tickets/vehicle-types', operador, otraEmpresa.id).expect(403);
  conCobroAbierta = (await http('post', '/tickets/registrations/by-plate', adminA, cobra.id).send({ licensePlate: 'PAY02', vehicleType: 'AUTO' }).expect(201)).body;
});

test('pasar a gratuita se bloquea con turnos abiertos, estadías con cobro adentro o cobros pendientes, sin tocar la historia', async () => {
  const historia = await ds.query(`SELECT id, monto FROM movimientos WHERE "playaId" = $1 ORDER BY id`, [cobra.id]);
  const snapshotAntes = (await ds.getRepository(Registration).findOneBy({ id: conCobroAbierta.id })).pricingSnapshot;
  const turno = await scoped({ empresaId: cobra.empresaId, playaId: cobra.id, userId: adminA.id }, () =>
    ds.getRepository(load('turnos/entities/turno.entity', 'Turno')).save({ usuarioApertura: { id: adminA.id }, fondoInicial: 0, estado: 'ABIERTO' }));
  await ds.query(`INSERT INTO cobros_mercadopago ("playaId","registrationId",tipo,monto,estado,"preferenceId","initPoint","expiraEl") VALUES ($1,$2,'HORA',1000,'PENDIENTE','p','u',now())`, [cobra.id, conCobroAbierta.id]);
  const previa = (await http('get', `/tenancy/playas/${cobra.id}/modalidad`, root_).expect(200)).body;
  assert.deepEqual(previa.bloqueos.map((b) => b.code).sort(), ['COBROS_PENDIENTES', 'ESTADIAS_CON_COBRO', 'TURNOS_ABIERTOS']);
  const rechazo = await modalidad(cobra.id, 'GRATUITO').expect(409);
  assert.equal(rechazo.body.code, 'MODALIDAD_CON_PENDIENTES');
  assert.match(rechazo.body.message, /Cobrar salida/);
  assert.equal(rechazo.body.bloqueos.length, 3);
  assert.equal((await ds.getRepository(Playa).findOneBy({ id: cobra.id })).modalidad, 'CON_COBRO');
  // Se resuelven a mano, como en la operación real.
  await ds.query(`UPDATE turnos SET estado = 'CERRADO', "fechaCierre" = now() WHERE id = $1`, [turno.id]);
  await ds.query(`UPDATE cobros_mercadopago SET estado = 'CANCELADO' WHERE "playaId" = $1`, [cobra.id]);
  assert.deepEqual((await modalidad(cobra.id, 'GRATUITO').expect(409)).body.bloqueos.map((b) => b.code), ['ESTADIAS_CON_COBRO']);
  const resumen = (await http('get', `/tickets/registrations/${conCobroAbierta.id}/close-summary`, adminA, cobra.id).expect(200)).body;
  await http('patch', `/tickets/registrations/${conCobroAbierta.id}/close`, adminA, cobra.id)
    .send({ closeType: 'PAYMENT', metodo: 'CASH', expectedPrice: resumen.previewBracket.price, expectedCollected: 0 }).expect(200);
  await modalidad(cobra.id, 'GRATUITO').expect(200);
  // La historia financiera queda igual y el administrador la sigue consultando.
  const despues = await ds.query(`SELECT id, monto FROM movimientos WHERE "playaId" = $1 ORDER BY id`, [cobra.id]);
  assert.equal(despues.length, historia.length + 1);
  assert.deepEqual(despues.filter((m) => historia.some((h) => h.id === m.id)), historia);
  assert.deepEqual((await ds.getRepository(Registration).findOneBy({ id: conCobroAbierta.id })).pricingSnapshot, snapshotAntes);
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
  await http('get', `/box-lists/date/${hoy}`, adminA, cobra.id).expect(200);
  await http('get', '/turnos', adminA, cobra.id).expect(200);
  // Las estadías ya cerradas conservan la modalidad con la que ingresaron.
  assert.equal((await ds.getRepository(Registration).findOneBy({ id: conCobroAbierta.id })).modalidad, 'CON_COBRO');
});

test('volver a cobrar: la estadía gratuita que sigue adentro sale sin cargo y no se le calcula tarifa', async () => {
  const adentro = (await http('post', '/tickets/registrations/by-plate', operador).send({ licensePlate: 'STAY01', vehicleType: 'AUTO' }).expect(201)).body;
  const cambio = await modalidad(gratis.id, 'CON_COBRO').expect(200);
  assert.deepEqual(cambio.body.avisos.map((a) => a.code).sort(), ['ESTADIAS_GRATUITAS', 'TIPOS_SIN_TARIFA']);
  const resumen = (await http('get', `/tickets/registrations/${adentro.id}/close-summary`, operador).expect(200)).body;
  assert.equal(resumen.modalidad, 'GRATUITO');
  assert.equal(resumen.saldoACobrar, undefined);
  assert.equal((await http('patch', `/tickets/registrations/${adentro.id}/close`, operador)
    .send({ closeType: 'NO_CHARGE', expectedPrice: 0, expectedCollected: 0 }).expect(409)).body.code, 'ESTADIA_GRATUITA');
  await http('patch', `/tickets/registrations/${adentro.id}/salida`, operador).expect(200);
  assert.equal(await contar('movimientos', gratis.id), 0);
  // Con cobro vuelven los comprobantes (con la entrega guardada). El de una estadía que entró gratis
  // no lleva importes: ni un $0.
  const constancia = (await http('post', `/tickets/registrations/${adentro.id}/receipt`, operador).send({ kind: 'EXIT' }).expect(201)).body;
  assert.equal(constancia.snapshot.modalidad, 'GRATUITO');
  assert.equal(constancia.snapshot.total, null);
  assert.equal(constancia.snapshot.collected, null);
  const publico = (await request(app.getHttpServer()).get(`/public/parking-receipts/${constancia.token}`).expect(200)).body;
  assert.equal(publico.modalidad, 'GRATUITO');
  assert.equal(publico.total, null);
  // Con cobro y sin tarifas cargadas, los ingresos nuevos se rechazan como siempre.
  const sinTarifa = await http('post', '/tickets/registrations/by-plate', operador).send({ licensePlate: 'NEW01', vehicleType: 'AUTO' });
  assert.equal(sinTarifa.status, 404);
  assert.equal(sinTarifa.body.code, 'TICKET_PRICE_BRACKET_NOT_FOUND');
});

test('un ingreso en curso termina antes del cambio de modalidad y el cambio lo ve', async () => {
  await modalidad(gratis.id, 'GRATUITO').expect(200);
  await modalidad(cobra.id, 'CON_COBRO').expect(200);
  // Simula un ingreso con cobro que tomó el bloqueo de tarifas y todavía no confirmó.
  const runner = ds.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  await runner.query('SELECT pg_advisory_xact_lock_shared(718903)');
  await runner.query(`INSERT INTO ticket_registrations ("playaId", description, price, "entryDay", "entryTime", "vehicleType", modalidad, "noPlate", "priceBracketFallbackUsed")
    VALUES ($1, 'en curso', 0, CURRENT_DATE, '10:00:00', 'AUTO', 'CON_COBRO', false, false)`, [cobra.id]);
  const pedido = modalidad(cobra.id, 'GRATUITO').then((r) => r);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await runner.commitTransaction();
  await runner.release();
  const r = await pedido;
  assert.equal(r.status, 409);
  assert.deepEqual(r.body.bloqueos.map((b) => b.code), ['ESTADIAS_CON_COBRO']);
});

test('contingencia gratuita: entradas sin tarifas, salidas por patente y tarjeta, reintentos e aislamiento sin caja', async () => {
  const { randomUUID } = require('node:crypto');
  const previousReceipts = await contar('parking_receipts', gratis.id);
  const card = await scoped({ empresaId: gratis.empresaId, playaId: gratis.id, userId: adminA.id }, () => ds.getRepository(Ticket).save({ codeBar: 'OFFLINE-CARD', vehicleType: 'AUTO' }));
  const existing = (await http('post', '/scanner/start-scanner', operador).send({ barCode: card.codeBar }).expect(201)).body;
  const deviceId = randomUUID();
  const snapshot = (await http('post', '/tickets/offline/prepare', operador).send({ deviceId, refresh: true }).expect(201)).body;
  assert.equal(snapshot.modalidad, 'GRATUITO');
  assert.ok(snapshot.vehicles.some(v => v.id === existing.registrationId && v.eligible && v.modalidad === 'GRATUITO' && !v.pricing));
  const sync = payload => http('post', '/tickets/offline/sync', operador).send({ sessionId: snapshot.sessionId, deviceId, ...payload });
  const entry = { id: randomUUID(), registrationId: randomUUID(), kind: 'ENTRY', occurredAt: new Date().toISOString(), plate: 'OFFGR01', vehicleType: 'AUTO' };
  await http('post', '/tickets/offline/sync', adminB, otraEmpresa.id).send({ sessionId: snapshot.sessionId, deviceId, ...entry }).expect(403);
  await sync(entry).expect(201);
  await sync(entry).expect(201);
  await sync({ ...entry, plate: 'OTRA01' }).expect(409);
  await sync({ ...entry, id: randomUUID(), registrationId: randomUUID() }).expect(409);
  const savedEntry = await ds.getRepository(Registration).findOneByOrFail({ id: entry.registrationId });
  assert.equal(savedEntry.modalidad, 'GRATUITO');
  assert.equal(savedEntry.pricingSnapshot, null);
  for (const registrationId of [entry.registrationId, existing.registrationId]) {
    const exit = { id: randomUUID(), registrationId, kind: 'EXIT', occurredAt: new Date().toISOString() };
    const invalid = await sync({ ...exit, expectedPrice: 100, method: 'CASH' }).expect(400);
    assert.equal(invalid.body.code, 'ESTADIA_GRATUITA');
    const [first, retry] = await Promise.all([sync(exit), sync(exit)]);
    assert.equal(first.status, 201);
    assert.equal(retry.status, 201);
    await sync({ ...exit, id: randomUUID() }).expect(409);
    const saved = await ds.getRepository(Registration).findOneOrFail({ where: { id: registrationId }, relations: ['ticket', 'boxList'] });
    assert.ok(saved.departureTime);
    assert.equal(saved.exitOperatorName, 'Ana Operadora');
    assert.equal(saved.price, 0);
    assert.equal(saved.ticket, null);
    assert.equal(saved.boxList, null);
    assert.equal(saved.pricingBreakdown, null);
  }
  assert.equal(await ds.getRepository(Registration).countBy({ licensePlateNormalized: 'OFFGR01' }), 1);
  assert.equal(await contar('parking_receipts', gratis.id), previousReceipts);
  for (const table of ['movimientos', 'cash_entries', 'box_lists', 'turnos'])
    assert.equal(await contar(table, gratis.id), 0, table);
});

test('contingencia gratuita conserva pendientes al volver a cobrar y permite salir gratis desde una nueva sesión con cobro', async () => {
  const { randomUUID } = require('node:crypto');
  const previousReceipts = await contar('parking_receipts', gratis.id);
  const deviceId = randomUUID();
  const snapshot = (await http('post', '/tickets/offline/prepare', operador).send({ deviceId }).expect(201)).body;
  const entry = { deviceId, sessionId: snapshot.sessionId, id: randomUUID(), registrationId: randomUUID(), kind: 'ENTRY', occurredAt: new Date().toISOString(), plate: 'OFFGR02', vehicleType: 'AUTO' };
  await http('post', '/tickets/offline/sync', operador).send(entry).expect(201);
  await modalidad(gratis.id, 'CON_COBRO').expect(200);
  const exit = { ...entry, id: randomUUID(), kind: 'EXIT', occurredAt: new Date().toISOString() };
  const changed = await http('post', '/tickets/offline/sync', operador).send(exit).expect(409);
  assert.equal(changed.body.code, 'MODALIDAD_CAMBIADA');
  const fresh = (await http('post', '/tickets/offline/prepare', operador).send({ deviceId }).expect(201)).body;
  assert.equal(fresh.modalidad, 'CON_COBRO');
  assert.ok(fresh.vehicles.some(v => v.id === entry.registrationId && v.eligible && v.modalidad === 'GRATUITO'));
  await http('post', '/tickets/offline/sync', operador).send({ ...exit, sessionId: fresh.sessionId }).expect(201);
  await modalidad(gratis.id, 'GRATUITO').expect(200);
  assert.equal(await contar('parking_receipts', gratis.id), previousReceipts);
  for (const table of ['movimientos', 'cash_entries', 'box_lists'])
    assert.equal(await contar(table, gratis.id), 0, table);
});

test('una contingencia preparada con cobro no sincroniza después de pasar a gratuita: queda pendiente', async () => {
  const deviceId = '00000000-0000-4000-8000-000000000002';
  await ds.query(`UPDATE ticket_registrations SET "departureDay" = CURRENT_DATE, "departureTime" = '11:00:00' WHERE "playaId" = $1 AND "departureTime" IS NULL`, [cobra.id]);
  const sesion = (await http('post', '/tickets/offline/prepare', adminA, cobra.id).send({ deviceId }).expect(201)).body;
  assert.equal(sesion.modalidad, 'CON_COBRO');
  await modalidad(cobra.id, 'GRATUITO').expect(200);
  const sync = await http('post', '/tickets/offline/sync', adminA, cobra.id).send({
    deviceId, sessionId: sesion.sessionId, id: '00000000-0000-4000-8000-000000000003', registrationId: '00000000-0000-4000-8000-000000000004',
    kind: 'ENTRY', occurredAt: new Date().toISOString(), plate: 'OFF01', vehicleType: 'AUTO',
  }).expect(409);
  assert.equal(sync.body.code, 'MODALIDAD_CAMBIADA');
  assert.equal(await ds.getRepository(Registration).countBy({ licensePlateNormalized: 'OFF01' }), 0);
});

test('planilla de vehículos: entradas, salidas y presentes con permanencia y operador, sin importes', async () => {
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
  const adentro = (await http('post', '/tickets/registrations/by-plate', operador).send({ licensePlate: 'PLAN01', vehicleType: 'AUTO' }).expect(201)).body;
  const todas = (await http('get', `/tickets/registrations/planilla?desde=${hoy}&hasta=${hoy}`, adminA, gratis.id).expect(200)).body;
  assert.ok(todas.meta.totalItems >= 2);
  const fila = todas.data.find((r) => r.id === adentro.id);
  assert.equal(fila.vehiculo, 'PLAN01');
  assert.equal(fila.modalidad, 'GRATUITO');
  assert.equal(fila.operadorEntrada, 'Ana Operadora');
  assert.equal(fila.salidaDia, null);
  assert.equal(typeof fila.permanenciaMinutos, 'number');
  for (const r of todas.data) for (const campo of ['price', 'total', 'collected', 'monto']) assert.equal(r[campo], undefined);
  assert.ok(todas.operadores.includes('Ana Operadora'));
  assert.equal(todas.resumen.presentes, 1);
  assert.equal(typeof todas.resumen.permanenciaMediana, 'number');
  const presentes = (await http('get', '/tickets/registrations/planilla?estado=PRESENTES', adminA, gratis.id).expect(200)).body;
  assert.deepEqual(presentes.data.map((r) => r.id), [adentro.id]);
  const salidas = (await http('get', `/tickets/registrations/planilla?estado=SALIDAS&desde=${hoy}&operador=Ana%20Operadora&q=AA123`, adminA, gratis.id).expect(200)).body;
  assert.deepEqual(salidas.data.map((r) => r.vehiculo), ['aa 123 bb']); // Tal cual la tipeó el operador.
  assert.equal(salidas.data[0].operadorSalida, 'Ana Operadora');
  await http('get', '/tickets/registrations/planilla?desde=2026-13-01', adminA, gratis.id).expect(400);
  // Es de administración: el operador no la consulta.
  await http('get', '/tickets/registrations/planilla', operador).expect(403);
  // Solo la playa propia: la otra empresa no ve estas filas.
  const ajena = (await http('get', `/tickets/registrations/planilla?desde=${hoy}`, adminB, otraEmpresa.id).expect(200)).body;
  assert.ok(ajena.data.every((r) => r.id !== adentro.id));
});

test('el super admin operando una playa ve y cierra solo lo de esa playa', async () => {
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
  // El alcance de plataforma deja pasar la RLS: la planilla y la salida filtran por la playa elegida.
  const ajena = (await http('post', '/tickets/registrations/by-plate', adminB, otraEmpresa.id).send({ licensePlate: 'OTRA77', vehicleType: 'AUTO' }).expect(201)).body;
  const planilla = (await http('get', `/tickets/registrations/planilla?desde=${hoy}`, root_, gratis.id).expect(200)).body;
  assert.ok(planilla.data.length > 0);
  assert.ok(planilla.data.every((r) => r.id !== ajena.id));
  const filas = await ds.query(`SELECT id FROM ticket_registrations WHERE "playaId" = $1 AND ("entryDay" = $2 OR "departureDay" = $2)`, [gratis.id, hoy]);
  assert.equal(planilla.meta.totalItems, filas.length);
  await http('patch', `/tickets/registrations/${ajena.id}/salida`, root_, gratis.id).expect(404);
});

test('la modalidad de una estadía no se puede cambiar después del ingreso, ni desde la base', async () => {
  const [fila] = await ds.query(`SELECT id FROM ticket_registrations WHERE "playaId" = $1 AND modalidad = 'CON_COBRO' LIMIT 1`, [cobra.id]);
  await assert.rejects(scoped({ empresaId: cobra.empresaId, playaId: cobra.id, userId: adminA.id }, () =>
    ds.query(`UPDATE ticket_registrations SET modalidad = 'GRATUITO' WHERE id = $1`, [fila.id])), /no se puede cambiar/);
  await assert.rejects(ds.query(`UPDATE ticket_registrations SET modalidad = 'GRATUITO' WHERE id = $1`, [fila.id]), /no se puede cambiar/);
});

test('ingresos digitales y su reversión también se cortan dentro de la transacción en una playa gratuita', async () => {
  const { recordDigital } = require('../dist/turnos/turno-book');
  await assert.rejects(scoped({ empresaId: gratis.empresaId, playaId: gratis.id, userId: adminA.id }, () =>
    ds.transaction((m) => recordDigital(m, -500, 'TRANSFER', 'Reversión de prueba', adminA.id))), (e) => e.getResponse().code === 'MODALIDAD_GRATUITA');
  assert.equal(await contar('turno_payments', gratis.id), 0);
});
