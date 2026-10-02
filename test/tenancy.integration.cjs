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
  const { Test } = require('@nestjs/testing');
  const { TypeOrmModule } = require('@nestjs/typeorm');
  const { ConfigModule, ConfigService } = require('@nestjs/config');
  const { ValidationPipe } = require('@nestjs/common');
  const module = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({isGlobal:true,ignoreEnvFile:true,load:[()=>({NEXTAUTH_SECRET:'isolated-tenancy-test-secret'})]}), TypeOrmModule.forRoot({ ...ds.options, synchronize: false, migrationsRun: false }), load('tenancy/tenancy.module', 'TenancyModule')],
    providers: [load('utils/strategies/jwt.strategy', 'JwtStrategy'), { provide: ConfigService, useValue: { get: () => 'isolated-tenancy-test-secret' } }],
  }).compile();
  app = module.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.init();
  const repo = ds.getRepository(User);
  superUser = await repo.save({ username: 'root-test', email: 'root@example.test', firstName: 'Root', lastName: 'Test', role: 'SUPER_ADMIN' });
  const company = await ds.getRepository(load('tenancy/entities/empresa.entity', 'Empresa')).save({ nombre: 'Role test' });
  adminUser = await repo.save({ username: 'admin-test', email: 'admin@example.test', firstName: 'Admin', lastName: 'Test', role: 'ADMIN', empresaId: company.id });

});

after(async () => {
  if (app) await app.close();
  if (ds?.isInitialized) await ds.destroy();
  if (pgStarted && fs.existsSync(path.join(root, 'data', 'postmaster.pid'))) pg('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'immediate', '-w', 'stop']);
  if (root) {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('tickets-pg-test-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});


const request = require('supertest');
const { JwtService } = require('@nestjs/jwt');
const jwt = new JwtService({ secret: 'isolated-tenancy-test-secret' });
let app, superUser, adminUser;
const token = u => jwt.sign({ id: u.id, role: u.role }, { expiresIn: '10m' });
const call = (method, route, user = superUser) => request(app.getHttpServer())[method]('/tenancy/' + route).set('Authorization', 'Bearer ' + token(user));

test('administración: autentica una cuenta real y rechaza ADMIN y roles viejos en el token', async () => {
  await request(app.getHttpServer()).get('/tenancy/empresas').expect(401);
  await call('get', 'empresas', adminUser).expect(403);
  await call('get', 'empresas', { ...adminUser, role: 'SUPER_ADMIN' }).expect(403);
  await call('get', 'empresas', { id: '11111111-1111-4111-8111-111111111111', role: 'SUPER_ADMIN' }).expect(401);
  await call('get', 'empresas').expect(200);
});

test('empresa, playas, usuarios: altas, edición, asignaciones, bajas y protección entre empresas', async () => {
  const e1 = (await call('post', 'empresas').send({ nombre: 'Empresa Uno' }).expect(201)).body;
  const e2 = (await call('post', 'empresas').send({ nombre: 'Empresa Dos' }).expect(201)).body;
  const p1 = (await call('post', `empresas/${e1.id}/playas`).send({ nombre: 'Centro' }).expect(201)).body;
  const p2 = (await call('post', `empresas/${e2.id}/playas`).send({ nombre: 'Norte' }).expect(201)).body;
  const datos = { firstName: 'Ana', lastName: 'Prueba', username: 'ana', email: 'ana@example.test', password: 'test-pass-123', role: 'ADMIN' };
  const u = (await call('post', `empresas/${e1.id}/usuarios`).send(datos).expect(201)).body;
  assert.equal(u.empresaId, e1.id); assert.equal(u.password, undefined);
  await call('post', `empresas/${e1.id}/usuarios`).send(datos).expect(409);
  await call('post', `empresas/${e1.id}/usuarios`).send({ ...datos, role: 'SUPER_ADMIN' }).expect(400);
  await call('patch', `empresas/${e2.id}/usuarios/${u.id}`).send({ firstName: 'Otra' }).expect(404);
  await call('patch', `usuarios/${u.id}/playas`).send({ playaIds: [p2.id] }).expect(400);
  await call('patch', `usuarios/${u.id}/playas`).send({ playaIds: [p1.id] }).expect(200);
  await call('patch', `empresas/${e1.id}/usuarios/${u.id}`).send({ firstName: 'Andrea', password: 'new-pass-123' }).expect(200);
  await call('patch', `playas/${p1.id}`).send({ nombre: 'Centro nuevo', direccion: 'Calle 123' }).expect(200);
  const listado = (await call('get', 'empresas').expect(200)).body.data;
  assert.deepEqual(listado.find(e => e.id === e1.id).usuarios[0].playaIds, [p1.id]);
  assert.equal(listado.find(e => e.id === e2.id).usuarios.length, 0);
  const stored = await ds.getRepository(User).findOne({ where: { id: u.id }, select: ['id', 'password'] });
  assert.ok(await require('bcryptjs').compare('new-pass-123', stored.password));
  await call('delete', `empresas/${e1.id}`).expect(400);
  await call('delete', `empresas/${e1.id}/usuarios/${u.id}`).expect(200);
  await call('get', 'empresas', u).expect(401);
  assert.equal(await ds.getRepository(User).count({ where: { id: u.id } }), 0);
  assert.equal(await ds.getRepository(User).count({ where: { id: u.id }, withDeleted: true }), 1);
  await call('delete', `playas/${p1.id}`).expect(200);
  await call('delete', `empresas/${e1.id}`).expect(400);
  await call('delete', `playas/${p2.id}`).expect(200);
  await call('delete', `empresas/${e2.id}`).expect(200);
});


test('playa nueva: Auto habilitado sin tarifas de ejemplo ni pases', async () => {
  const empresa = (await call('post', 'empresas').send({ nombre: 'Inicio sin ejemplos' }).expect(201)).body;
  const playa = (await call('post', `empresas/${empresa.id}/playas`).send({ nombre: 'Nueva playa' }).expect(201)).body;
  const vehicles = await ds.query('SELECT code, name, enabled FROM ticket_vehicle_types WHERE "playaId" = $1', [playa.id]);
  assert.deepEqual(vehicles, [{ code: 'AUTO', name: 'Auto', enabled: true }]);
  assert.equal(await ds.getRepository(Bracket).countBy({ playaId: playa.id }), 0);
  assert.equal(await ds.getRepository(TicketPrice).countBy({ playaId: playa.id }), 0);
  // El alta no guarda opciones implícitas; getSchedule usa los defaults de operación.
  assert.equal(await ds.getRepository(Schedule).countBy({ playaId: playa.id }), 0);

});

test('configuracion nueva: tickets fisicos y turnos apagados en entidad y servicio', async () => {
  const repository = ds.getRepository(Schedule);
  const service = new TicketsService(undefined, undefined, undefined, undefined, undefined, repository, undefined, undefined, undefined, ds);
  const fallback = await service.getSchedule();
  assert.equal(fallback.barcodeTicketsEnabled, false);
  assert.equal(fallback.shiftsEnabled, false);
  const saved = await repository.save(repository.create({ dayStartHour: 8, dayEndHour: 20 }));
  try {
    assert.equal(saved.barcodeTicketsEnabled, false);
    assert.equal(saved.shiftsEnabled, false);
    await repository.update(saved.id, { barcodeTicketsEnabled: true, shiftsEnabled: true });
    const existing = await service.getSchedule();
    assert.equal(existing.barcodeTicketsEnabled, true);
    assert.equal(existing.shiftsEnabled, true);
  } finally {
    await repository.delete(saved.id);
  }
});

test('migracion de defaults: conserva flags existentes y cambia solo nuevas filas', async () => {
  const Migration = load('database/migrations/1790000016000-simple-operation-defaults', 'SimpleOperationDefaults1790000016000');
  const runner = ds.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    const migration = new Migration();
    await migration.down(runner);
    const [enabled] = await runner.query('INSERT INTO ticket_schedule_settings ("dayStartHour", "dayEndHour") VALUES (8, 20) RETURNING id, "barcodeTicketsEnabled", "shiftsEnabled"');
    assert.equal(enabled.barcodeTicketsEnabled, true);
    assert.equal(enabled.shiftsEnabled, true);
    const [disabled] = await runner.query('INSERT INTO ticket_schedule_settings ("dayStartHour", "dayEndHour", "barcodeTicketsEnabled", "shiftsEnabled") VALUES (8, 20, false, false) RETURNING id');
    await migration.up(runner);
    const [after] = await runner.query('INSERT INTO ticket_schedule_settings ("dayStartHour", "dayEndHour") VALUES (8, 20) RETURNING id, "barcodeTicketsEnabled", "shiftsEnabled"');
    assert.equal(after.barcodeTicketsEnabled, false);
    assert.equal(after.shiftsEnabled, false);
    const existing = await runner.query('SELECT id, "barcodeTicketsEnabled", "shiftsEnabled" FROM ticket_schedule_settings WHERE id = ANY($1::uuid[])', [[enabled.id, disabled.id]]);
    assert.deepEqual(existing.find(row => row.id === enabled.id), enabled);
    assert.deepEqual(existing.find(row => row.id === disabled.id), { id: disabled.id, barcodeTicketsEnabled: false, shiftsEnabled: false });
    await migration.down(runner);
    const [stillDisabled] = await runner.query('SELECT "barcodeTicketsEnabled", "shiftsEnabled" FROM ticket_schedule_settings WHERE id = $1', [after.id]);
    assert.deepEqual(stillDisabled, { barcodeTicketsEnabled: false, shiftsEnabled: false });
  } finally {
    await runner.rollbackTransaction();
    await runner.release();
  }
});


test('sin configuracion guardada: bloquea abrir turnos y permite caja diaria con historial', async () => {
  assert.equal(await ds.getRepository(Schedule).count(), 0);
  const shiftService = new TurnosService(ds.getRepository(Turno), ds.getRepository(Movimiento), ds);
  await assert.rejects(shiftService.open(superUser.id, { fondoInicial: 0 }), /desactivados/);
  const historical = await ds.getRepository(Turno).save({ usuarioApertura: superUser, estado: 'CERRADO', cashVersion: 2, fondoInicial: 0 });
  const CashEntry = load('turnos/entities/cash-entry.entity', 'CashEntry');
  const boxService = new BoxListsService(ds.getRepository(Box), ds.getRepository(Other), ds);
  let box;
  try {
    box = await boxService.createBox({ date: '2026-09-26', totalPrice: 250 });
    const cash = await ds.getRepository(CashEntry).findOneByOrFail({ boxId: box.id });
    assert.equal(cash.amount, 250);
    assert.equal(cash.turnoId, null);
    assert.equal(await ds.getRepository(Turno).countBy({ estado: 'ABIERTO' }), 0);
  } finally {
    if (box) {
      await ds.getRepository(CashEntry).delete({ boxId: box.id });
      await ds.getRepository(Box).delete(box.id);
    }
    await ds.getRepository(Turno).delete(historical.id);
  }
});

test('offline sin configuracion guardada: sincroniza con tarifas y bloquea si activan turnos', async () => {
  const OfflineService = load('tickets/offline.service', 'OfflineService');
  const OfflineSession = load('tickets/entities/offline-session.entity', 'OfflineSession');
  const { tenantContext } = require('../dist/tenancy/tenant-context');
  const { randomUUID } = require('node:crypto');
  const Empresa = load('tenancy/entities/empresa.entity', 'Empresa');
  const Playa = load('tenancy/entities/playa.entity', 'Playa');
  const empresa = await ds.getRepository(Empresa).save({ nombre: 'Offline defaults' });
  const playa = await ds.getRepository(Playa).save({ empresaId: empresa.id, nombre: 'Patente' });
  const now = new Date();
  const deviceId = randomUUID();
  const registrationId = randomUUID();
  const service = new OfflineService(ds, undefined, undefined, undefined, { emitNewRegistration() {} });
  const session = await ds.getRepository(OfflineSession).save({ playaId: playa.id, userId: adminUser.id, deviceId,
    active: true, createdAt: now, expiresAt: new Date(now.getTime() + 3600000), processed: {},
    snapshot: { types: [{ code: 'AUTO', name: 'Auto' }], vehicles: [], pricing: { version: 1, capturedAt: now.toISOString(), schedule: { dayStartHour: 8, dayEndHour: 20, graceMinutes: 5, pricingDayTypeBasis: 'EXIT' }, brackets: [{ vehicleType: 'AUTO', ticketDayType: null, label: 'Hora', uptoMinutes: 60, price: 1000 }, { vehicleType: 'AUTO', ticketDayType: null, label: 'Adicional', uptoMinutes: null, price: 1000, recurringUnitMinutes: 60, recurringPriceMode: 'FIXED' }] } },
  });
  let settings;
  try {
    await tenantContext.run({ empresaId: empresa.id, playaId: playa.id, userId: adminUser.id, role: 'ADMIN' }, async () => {
      const operation = { deviceId, sessionId: session.id, id: randomUUID(), registrationId, kind: 'ENTRY', occurredAt: now.toISOString(), plate: 'DEFAULT1', vehicleType: 'AUTO' };
      const synced = await service.synchronize(operation);
      assert.equal(synced.status, 'SYNCED');
      assert.equal(synced.registrationId, registrationId);
      settings = await ds.getRepository(Schedule).save({ playaId: playa.id, dayStartHour: 8, dayEndHour: 20, shiftsEnabled: true });
      await assert.rejects(service.synchronize({ ...operation, id: randomUUID(), registrationId: randomUUID(), plate: 'DEFAULT2' }), /turnos fueron activados/);
    });
  } finally {
    await ds.getRepository(Registration).delete(registrationId);
    await ds.getRepository(OfflineSession).delete(session.id);
    if (settings) await ds.getRepository(Schedule).delete(settings.id);
    await ds.getRepository(Playa).delete(playa.id);
    await ds.getRepository(Empresa).delete(empresa.id);
  }
});

test('alta de empresa: la prueba gratis es opcional', async () => {
  const sin = (await call('post', 'empresas').send({ nombre: 'Alta sin prueba' }).expect(201)).body;
  assert.equal((await call('get', `empresas/${sin.id}/suscripcion`).expect(200)).body.cuenta.estado, 'SIN_ACTIVAR');
  const con = (await call('post', 'empresas').send({ nombre: 'Alta con prueba', diasPrueba: 7 }).expect(201)).body;
  assert.equal((await call('get', `empresas/${con.id}/suscripcion`).expect(200)).body.cuenta.estado, 'PRUEBA');
  await call('post', 'empresas').send({ nombre: 'Prueba de más', diasPrueba: 90 }).expect(400);
  await call('patch', `empresas/${sin.id}`).send({ diasPrueba: 7 }).expect(400);
  // El alta se da después, desde la ficha, sin plan: fecha de alta y días de prueba.
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
  const dada = (await call('post', `empresas/${sin.id}/suscripcion/alta`).send({ alta: hoy, diasPrueba: 7 }).expect(201)).body;
  assert.equal(dada.cuenta.estado, 'PRUEBA');
  assert.equal(dada.cuenta.alta, hoy);
  // Días extra piden motivo, y solo el super admin puede.
  await call('post', `empresas/${sin.id}/suscripcion/dias-extra`).send({ hasta: '2099-01-01' }).expect(400);
  await call('post', `empresas/${sin.id}/suscripcion/dias-extra`, adminUser).send({ hasta: hoy, motivo: 'intento' }).expect(403);
  await call('patch', `empresas/${sin.id}/suscripcion`).send({ alta: 'ayer' }).expect(400);
});
