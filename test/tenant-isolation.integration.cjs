// Ejecutar después de pnpm build. PostgreSQL efímero: nunca lee .env ni usa la base del proyecto.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
require('reflect-metadata');
require('tsconfig-paths').register({
  baseUrl: path.resolve('dist'),
  paths: { 'src/*': ['*'] },
});
const { DataSource } = require('typeorm');
const dayjs = require('dayjs');
const load = (p, name) => require('../dist/' + p)[name];
const Ticket = load('tickets/entities/ticket.entity', 'Ticket');
const TicketPrice = load('tickets/entities/ticket-price.entity', 'TicketPrice');
const Bracket = load(
  'tickets/entities/ticket-price-bracket.entity',
  'TicketPriceBracket',
);
const Registration = load(
  'tickets/entities/ticket-registration.entity',
  'TicketRegistration',
);
const RegistrationDay = load(
  'tickets/entities/ticket-registration-for-day.entity',
  'TicketRegistrationForDay',
);
const Schedule = load(
  'tickets/entities/ticket-schedule-settings.entity',
  'TicketScheduleSettings',
);
const Movimiento = load('movimientos/entities/movimiento.entity', 'Movimiento');
const Turno = load('turnos/entities/turno.entity', 'Turno');
const Box = load('box-lists/entities/box-list.entity', 'BoxList');
const Other = load('box-lists/entities/other-payment.entity', 'OtherPayment');
const User = load('users/entities/user.entity', 'User');
const TicketsService = load('tickets/tickets.service', 'TicketsService');
const TurnosService = load('turnos/turnos.service', 'TurnosService');
const MovimientosService = load(
  'movimientos/movimientos.service',
  'MovimientosService',
);
const BoxListsService = load('box-lists/box-lists.service', 'BoxListsService');
const ScannerService = load('scanner/scanner.service', 'ScannerService');
let ds,
  root,
  pgStarted = false,
  tickets,
  movements,
  shifts,
  boxes,
  user,
  scanner;
let counter = 0;
const bin = process.env.PG_TEST_BIN || 'C:/Program Files/PostgreSQL/18/bin';
const pg = (name, args) => {
  // PostgreSQL hereda stdout en Windows; un pipe mantendría spawnSync esperando aunque pg_ctl termine.
  const output = fs.openSync(path.join(root, 'commands.log'), 'a');
  try {
    return execFileSync(
      path.join(bin, name + (process.platform === 'win32' ? '.exe' : '')),
      args,
      { windowsHide: true, stdio: ['ignore', output, output], timeout: 30000 },
    );
  } finally {
    fs.closeSync(output);
  }
};
const freePort = () =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-pg-test-'));
  pg('initdb', [
    '-D',
    path.join(root, 'data'),
    '-U',
    'postgres',
    '-A',
    'trust',
    '--encoding=UTF8',
    '--locale=C',
  ]);
  const port = await freePort();
  pgStarted = true;
  pg('pg_ctl', [
    '-D',
    path.join(root, 'data'),
    '-l',
    path.join(root, 'postgres.log'),
    '-o',
    '-h 127.0.0.1 -p ' + port + ' -F',
    '-w',
    'start',
  ]);
  pgStarted = true;
  ds = new DataSource({
    type: 'postgres',
    host: '127.0.0.1',
    port,
    username: 'postgres',
    database: 'postgres',
    entities: [path.resolve('dist/**/*.entity.js')],
    migrations: [
      load(
        'database/migrations/1790000000000-flexible-vehicle-types',
        'FlexibleVehicleTypes1790000000000',
      ),
    ],
    migrationsRun: true,
    synchronize: true,
  });
  await ds.initialize();
  const { Test } = require('@nestjs/testing');
  const { TypeOrmModule } = require('@nestjs/typeorm');
  const { ConfigModule, ConfigService } = require('@nestjs/config');
  const { ValidationPipe } = require('@nestjs/common');
  const {
    installTenantConnections,
  } = require('../dist/tenancy/tenant-context');
  const migrationRunner = ds.createQueryRunner();
  try {
    await new (load(
      'database/migrations/1790000001000-tenant-isolation',
      'TenantIsolation1790000001000',
    ))().up(migrationRunner);
    await new (load('database/migrations/1790000002000-auth-version', 'AuthVersion1790000002000'))().up(migrationRunner);
  } finally {
    await migrationRunner.release();
  }
  installTenantConnections(ds);
  const options = { ...ds.options, synchronize: false, migrationsRun: false };
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [
          () => ({
            NEXTAUTH_SECRET: 'isolated-tenancy-test-secret',
            API_SECRET_TOKEN: 'test-static-secret',
          }),
        ],
      }),
      TypeOrmModule.forRootAsync({
        useFactory: () => options,
        dataSourceFactory: async (opts) => {
          const db = await new DataSource(opts).initialize();
          installTenantConnections(db);
          return db;
        },
      }),
      load('tenancy/tenancy.module', 'TenancyModule'),
      load('tickets/tickets.module', 'TicketsModule'),
      load('customers/customers.module', 'CustomersModule'),
      load('users/users.module', 'UsersModule'),
      load('notes/notes.module', 'NotesModule'),
      load('auth/auth.module', 'AuthModule'),
      load('receipts/receipts.module', 'ReceiptsModule'),
      load('scanner/scanner.module', 'ScannerModule'),
      load('parking/parking.module', 'ParkingModule'),
      load('plate-recognition/plate-recognition.module', 'PlateRecognitionModule'),
    ],
    providers: [
      load('utils/strategies/jwt.strategy', 'JwtStrategy'),
      {
        provide: require('@nestjs/core').APP_GUARD,
        useClass: load('tenancy/tenant-access', 'TenantGuard'),
      },
      {
        provide: require('@nestjs/core').APP_INTERCEPTOR,
        useClass: load('tenancy/tenant-access', 'TenantInterceptor'),
      },
    ],
  }).compile();
  app = module.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.listen(0, '127.0.0.1');
  const repo = ds.getRepository(User);
  superUser = await repo.save({
    username: 'root-test',
    email: 'root@example.test',
    firstName: 'Root',
    lastName: 'Test',
    role: 'SUPER_ADMIN',
  });
  adminUser = await repo.save({
    username: 'admin-test',
    email: 'admin@example.test',
    firstName: 'Admin',
    lastName: 'Test',
    role: 'ADMIN',
  });
});

after(async () => {
  if (app) await app.close();
  if (ds?.isInitialized) await ds.destroy();
  if (pgStarted && fs.existsSync(path.join(root, 'data', 'postmaster.pid')))
    pg('pg_ctl', [
      '-D',
      path.join(root, 'data'),
      '-m',
      'immediate',
      '-w',
      'stop',
    ]);
  if (root) {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('tickets-pg-test-'));
    fs.rmSync(resolved, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
});

const request = require('supertest');
const { JwtService } = require('@nestjs/jwt');
const jwt = new JwtService({ secret: 'isolated-tenancy-test-secret' });
let app, superUser, adminUser;
const token = (u) => jwt.sign({ id: u.id, role: u.role, authVersion: u.authVersion ?? 0 }, { expiresIn: '10m' });
const call = (method, route, user = superUser) =>
  request(app.getHttpServer())
    [method]('/tenancy/' + route)
    .set('Authorization', 'Bearer ' + token(user));

const { tenantContext } = require('../dist/tenancy/tenant-context');
const Empresa = load('tenancy/entities/empresa.entity', 'Empresa');
const Playa = load('tenancy/entities/playa.entity', 'Playa');
const Customer = load('customers/entities/customer.entity', 'Customer');
const scoped = (scope, fn) => tenantContext.run(scope, fn);
let a, b, a2, adminA, adminB, customerA, customerB;

test('prepara dos empresas y tres playas independientes', async () => {
  const e1 = await ds.getRepository(Empresa).save({ nombre: 'Empresa A' });
  const e2 = await ds.getRepository(Empresa).save({ nombre: 'Empresa B' });
  const p1 = await ds
    .getRepository(Playa)
    .save({ nombre: 'A1', empresaId: e1.id });
  const p2 = await ds
    .getRepository(Playa)
    .save({ nombre: 'B1', empresaId: e2.id });
  const p3 = await ds
    .getRepository(Playa)
    .save({ nombre: 'A2', empresaId: e1.id });
  adminA = await ds
    .getRepository(User)
    .save({
      username: 'adminA',
      email: 'a@example.test',
      firstName: 'A',
      lastName: 'Admin',
      role: 'ADMIN',
      empresaId: e1.id,
    });
  adminB = await ds
    .getRepository(User)
    .save({
      username: 'adminB',
      email: 'b@example.test',
      firstName: 'B',
      lastName: 'Admin',
      role: 'ADMIN',
      empresaId: e2.id,
    });
  a = { empresaId: e1.id, playaId: p1.id, userId: adminA.id };
  b = { empresaId: e2.id, playaId: p2.id, userId: adminB.id };
  a2 = { ...a, playaId: p3.id };
  customerA = await scoped(a, () =>
    ds
      .getRepository(Customer)
      .save({
        firstName: 'Customer A',
        lastName: 'Test',
        customerType: 'OWNER',
        numberOfVehicles: 1,
      }),
  );
  customerB = await scoped(b, () =>
    ds
      .getRepository(Customer)
      .save({
        firstName: 'Customer B',
        lastName: 'Test',
        customerType: 'OWNER',
        numberOfVehicles: 1,
      }),
  );
  assert.equal(customerA.playaId, a.playaId);
  assert.equal(customerB.playaId, b.playaId);
});

test('RLS filtra listados, agregados, IDs y modificaciones, incluso dentro de transacciones', async () => {
  await scoped(a, async () => {
    assert.equal(await ds.getRepository(Customer).count(), 1);
    assert.equal(
      await ds.getRepository(Customer).findOneBy({ id: customerB.id }),
      null,
    );
    assert.equal(
      (
        await ds
          .getRepository(Customer)
          .update(customerB.id, { firstName: 'HACK' })
      ).affected,
      0,
    );
    assert.equal(
      (await ds.getRepository(Customer).delete(customerB.id)).affected,
      0,
    );
    await assert.rejects(
      ds
        .getRepository(Customer)
        .save({
          firstName: 'HACK',
          lastName: 'Test',
          customerType: 'OWNER',
          numberOfVehicles: 1,
          playaId: b.playaId,
        }),
    );
    await ds.transaction(async (manager) => {
      assert.equal(await manager.getRepository(Customer).count(), 1);
    });
    await assert.rejects(
      ds
        .getRepository(load('receipts/entities/receipt.entity', 'Receipt'))
        .save({
          customer: { id: customerB.id },
          receiptTypeKey: 'OWNER',
          status: 'PENDING',
        }),
    );
  });
  assert.equal(await scoped(a2, () => ds.getRepository(Customer).count()), 0);
  assert.equal(
    (await ds.getRepository(Customer).findOneBy({ id: customerB.id }))
      .firstName,
    'Customer B',
  );
});

test('editar historial conserva un autor que pasó a ser superadministrador', async () => {
  const Note = load('notes/entities/note.entity', 'Note');
  const note = await ds
    .getRepository(Note)
    .save({
      description: 'Anterior',
      user: superUser,
      playaId: a.playaId,
      date: '2026-09-18',
      hours: '10:00:00',
    });
  await scoped(a, async () => {
    await ds
      .getRepository(Note)
      .update(note.id, { description: 'Historial actualizado' });
    assert.equal(
      (await ds.getRepository(Note).findOneBy({ id: note.id })).description,
      'Historial actualizado',
    );
  });
});

test('toda tabla con playa tiene RLS forzada o carece de permisos para el rol operativo', async () => {
  for (const meta of ds.entityMetadatas.filter(m => m.columns.some(c => c.propertyName === 'playaId'))) {
    const [policy] = await ds.query(`SELECT relrowsecurity, relforcerowsecurity, has_table_privilege('parking_scoped', oid, 'SELECT') AS readable FROM pg_class WHERE oid=$1::regclass`, ['"' + meta.tableName + '"']);
    assert.ok(!policy.readable || (policy.relrowsecurity && policy.relforcerowsecurity), meta.tableName);
    if (policy.readable) {
      const rows = await scoped(a, () => ds.query('SELECT "playaId" FROM "' + meta.tableName + '"'));
      assert.ok(rows.every(row => row.playaId === a.playaId), meta.tableName);
    }
  }
});

test('concurrencia y reutilización del pool no mezclan contexto', async () => {
  await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      scoped(i % 2 ? a : b, async () => {
        const rows = await ds.getRepository(Customer).find();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].playaId, (i % 2 ? a : b).playaId);
      }),
    ),
  );
  assert.equal(await ds.getRepository(Customer).count(), 2);
});

test('HTTP: rechaza playa ajena, contexto ausente y token estático operativo; lista solo la empresa propia', async () => {
  await call('get', 'empresas', adminA).expect(403);
  await request(app.getHttpServer())
    .get('/customers/customer/OWNER')
    .set('Authorization', 'Bearer test-static-secret')
    .expect(401);
  await request(app.getHttpServer())
    .get('/customers/customer/OWNER')
    .set('Authorization', 'Bearer ' + token(adminA))
    .expect(403);
  await request(app.getHttpServer())
    .get('/customers/customer/OWNER')
    .set('Authorization', 'Bearer ' + token(adminA))
    .set('X-Playa-Id', b.playaId)
    .expect(403);
  const response = await request(app.getHttpServer())
    .get('/users')
    .set('Authorization', 'Bearer ' + token(adminA))
    .set('X-Playa-Id', a.playaId)
    .expect(200);
  assert.equal(response.body.data.length, 1);
  assert.equal(response.body.data[0].id, adminA.id);
  const context = await request(app.getHttpServer())
    .get('/tenant/context')
    .set('Authorization', 'Bearer ' + token(adminA))
    .expect(200);
  assert.deepEqual(
    context.body.playas.map((p) => p.id).sort(),
    [a.playaId, a2.playaId].sort(),
  );
});

test('tipos de vehículo y precios nuevos independientes; alta de usuario asigna empresa y playa actual', async () => {
  const api = (method, path, who, scope) =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', 'Bearer ' + token(who))
      .set('X-Playa-Id', scope.playaId);
  await api('post', '/tickets/vehicle-types', adminA, a)
    .send({ code: 'AUTO', name: 'Auto A' })
    .expect(201);
  await api('post', '/tickets/vehicle-types', adminB, b)
    .send({ code: 'AUTO', name: 'Auto B' })
    .expect(201);
  const rows = (
    await api('get', '/tickets/vehicle-types', adminA, a).expect(200)
  ).body;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Auto A');
  const u = (
    await api('post', '/users', adminA, a)
      .send({
        firstName: 'Operador',
        lastName: 'A',
        username: 'opA',
        email: 'opA@example.test',
        password: 'password123',
        role: 'USER',
      })
      .expect(201)
  ).body;
  assert.equal(u.empresaId, a.empresaId);
  assert.equal(u.password, undefined);
  const result = await request(app.getHttpServer())
    .get('/tenant/context')
    .set('Authorization', 'Bearer ' + token(u))
    .expect(200);
  assert.deepEqual(
    result.body.playas.map((p) => p.id),
    [a.playaId],
  );
  await api('get', '/users', u, a).expect(403);
  await api('get', '/tickets/vehicle-types', u, a2).expect(403);
});

test('ADMIN y SUPER_ADMIN asignan una única playa; el operador no puede elegirla', async () => {
  const user = await ds.getRepository(User).findOneBy({ username: 'opA' });
  await request(app.getHttpServer())
    .patch(`/tenant/operators/${user.id}/playa`)
    .set('Authorization', 'Bearer ' + token(user))
    .send({ playaId: a.playaId })
    .expect(403);
  await request(app.getHttpServer())
    .patch(`/tenant/operators/${user.id}/playa`)
    .set('Authorization', 'Bearer ' + token(adminB))
    .send({ playaId: b.playaId })
    .expect(403);
  await request(app.getHttpServer())
    .patch(`/tenant/operators/${user.id}/playa`)
    .set('Authorization', 'Bearer ' + token(adminA))
    .send({ playaId: a2.playaId })
    .expect(200);
  let context = await request(app.getHttpServer())
    .get('/tenant/context')
    .set('Authorization', 'Bearer ' + token(user))
    .expect(200);
  assert.equal(context.body.role, 'USER');
  assert.deepEqual(
    context.body.playas.map((p) => p.id),
    [a2.playaId],
  );
  await request(app.getHttpServer())
    .get('/customers/customer/OWNER')
    .set('Authorization', 'Bearer ' + token(user))
    .set('X-Playa-Id', a.playaId)
    .expect(403);
  await request(app.getHttpServer())
    .patch(`/tenant/operators/${user.id}/playa`)
    .set('Authorization', 'Bearer ' + token(superUser))
    .send({ playaId: a.playaId })
    .expect(200);
  context = await request(app.getHttpServer())
    .get('/tenant/context')
    .set('Authorization', 'Bearer ' + token(user))
    .expect(200);
  assert.deepEqual(
    context.body.playas.map((p) => p.id),
    [a.playaId],
  );
});

test('tickets: misma patente en empresas diferentes, precios y cobros separados', async () => {
  const service = app.get(TicketsService);
  const registrations = [];
  for (const [scope, price] of [
    [a, 1000],
    [b, 2000],
  ]) {
    await scoped(scope, async () => {
      await service.createPriceBracket({
        vehicleType: 'AUTO',
        label: 'Hora',
        uptoMinutes: 60,
        price,
      });
      const registration = await service.createRegistrationByPlate({
        vehicleType: 'AUTO',
        licensePlate: 'ABC123',
      });
      const entry = dayjs()
        .tz('America/Argentina/Buenos_Aires')
        .subtract(30, 'minute');
      await ds
        .getRepository(Registration)
        .update(registration.id, {
          entryDay: entry.format('YYYY-MM-DD'),
          entryTime: entry.format('HH:mm:ss'),
        });
      const summary = await service.getCloseSummary(registration.id);
      assert.equal(summary.previewBracket.price, price);
      registrations.push(registration);
      await service.closeRegistrationByPlate(
        registration.id,
        {
          closeType: 'PAYMENT',
          metodo: 'TRANSFER',
          expectedPrice: price,
          expectedCollected: 0,
        },
        scope.userId,
      );
      const rows = await ds.getRepository(Movimiento).find();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].playaId, scope.playaId);
    });
  }
  await scoped(a, async () => {
    await assert.rejects(service.getCloseSummary(registrations[1].id));
    assert.equal(await ds.getRepository(Registration).count(), 1);
  });
});

test('todos los endpoints rechazan acceso anónimo y el secreto interno no permite escribir usuarios', async (t) => {
  const { ModulesContainer } = require('@nestjs/core');
  const methods = ['get', 'post', 'put', 'delete', 'patch'];
  let checked = 0;
  for (const module of app.get(ModulesContainer).values()) for (const wrapper of module.controllers.values()) {
    const ctor = wrapper.metatype;
    const prefix = Reflect.getMetadata('path', ctor);
    for (const name of Object.getOwnPropertyNames(ctor.prototype)) {
      const handler = ctor.prototype[name];
      if (typeof handler !== 'function') continue;
      const method = methods[Reflect.getMetadata('method', handler)];
      if (!method || (ctor.name === 'AuthController' && name === 'login')) continue;
      const suffix = Reflect.getMetadata('path', handler);
      const route = ('/' + prefix + '/' + suffix).replace(/\/+/g, '/').replace(/:[^/]+/g, '11111111-1111-4111-8111-111111111111');
      await request(app.getHttpServer())[method](route).send({}).expect(401);
      checked++;
    }
  }
  assert.ok(checked > 90, `Only ${checked} routes checked`);
  t.diagnostic(`${checked} endpoints protegidos verificados sin credenciales`);
  for (const method of ['post', 'patch', 'delete']) {
    const path = method === 'post' ? '/users' : `/users/${adminB.id}`;
    await request(app.getHttpServer())[method](path).set('Authorization', 'Bearer test-static-secret').send({ role: 'ADMIN' }).expect(401);
  }
});

test('operador: tarifas, usuarios e historial protegidos incluso con mayúsculas y barra final', async () => {
  const user = await ds.getRepository(User).save({ username: 'limited', email: 'limited@example.test', firstName: 'Limited', lastName: 'Test', role: 'USER', empresaId: b.empresaId });
  await ds.getRepository(load('tenancy/entities/usuario-playa.entity', 'UsuarioPlaya')).save({ usuarioId: user.id, playaId: b.playaId, rolPlaya: 'OPERADOR' });
  for (const [method, route] of [['get', '/USERS/'], ['patch', '/TICKETS/schedule-settings/'], ['post', '/tickets/vehicle-types'], ['get', '/turnos'], ['get', '/turnos/operadores'], ['post', '/customers'], ['post', '/parking/owner-types'], ['post', '/box-lists'], ['delete', '/receipts/' + customerB.id]]) {
    await request(app.getHttpServer())[method](route).set('Authorization', 'Bearer ' + token(user)).send({}).expect(403);
  }
  await request(app.getHttpServer()).get('/tickets/vehicle-types').set('Authorization', 'Bearer ' + token(user)).expect(200);
  await request(app.getHttpServer()).get('/turnos/caja').set('Authorization', 'Bearer ' + token(user)).expect(200);
  await request(app.getHttpServer()).post(`/notes/users/${adminB.id}`).set('Authorization', 'Bearer ' + token(user)).send({ description: 'Spoofed author' }).expect(403);
  await request(app.getHttpServer()).get('/customers/' + customerA.id).set('Authorization', 'Bearer ' + token(user)).expect(404);
  await request(app.getHttpServer()).get('/tickets/vehicle-types').set('Authorization', 'Bearer ' + token(user)).set('X-Playa-Id', a.playaId).expect(403);
});

test('login y recuperación: sin hashes, consumo único del enlace y revocación de JWT anterior', async () => {
  const password = 'safe-test-pass-123';
  const hash = await require('bcryptjs').hash(password, 10);
  const user = await ds.getRepository(User).save({ username: 'login-test', email: 'login@example.test', firstName: 'Login', lastName: 'Test', role: 'ADMIN', empresaId: b.empresaId, password: hash });
  const login = await request(app.getHttpServer()).post('/auth/login').send({ identifier: user.email, password }).expect(201);
  assert.equal(login.body.password, undefined);
  const oldToken = token(user);
  await request(app.getHttpServer()).post('/auth/login').send({ identifier: user.email, password: 'wrong-password' }).expect(401);
  await request(app.getHttpServer()).post('/auth/login').send({ identifier: 'missing@example.test', password }).expect(401);
  const generated = await request(app.getHttpServer()).post('/auth/password-reset-token').set('Authorization', 'Bearer test-static-secret').send({ email: user.email }).expect(201);
  const resets = await Promise.all([1, 2].map(() => request(app.getHttpServer()).post('/auth/reset-password').set('Authorization', 'Bearer test-static-secret').send({ token: generated.body.token, password: 'new-safe-test-pass' })));
  assert.deepEqual(resets.map(r => r.status).sort(), [201, 401]);
  await request(app.getHttpServer()).get('/tenant/context').set('Authorization', 'Bearer ' + oldToken).expect(401);
  const fresh = (await request(app.getHttpServer()).post('/auth/login').send({ identifier: user.email, password: 'new-safe-test-pass' }).expect(201)).body;
  assert.equal(fresh.authVersion, 1);
  const update = await request(app.getHttpServer()).patch(`/users/${user.id}/password`).set('Authorization', 'Bearer ' + token(fresh)).send({ currentPassword: 'new-safe-test-pass', newPassword: password, repeatNewPassword: password }).expect(200);
  assert.equal(update.body.password, undefined);
  const modified = await request(app.getHttpServer()).patch(`/users/${user.id}`).set('Authorization', 'Bearer ' + token(adminB)).send({ password: 'admin-changed-pass' }).expect(200);
  assert.equal(modified.body.password, undefined);
  await request(app.getHttpServer()).get('/tenant/context').set('Authorization', 'Bearer ' + jwt.sign({ id: user.id })).expect(401);
  await request(app.getHttpServer()).get('/tenant/context').set('Authorization', 'Bearer ' + jwt.sign({ id: user.id }, { expiresIn: -1 })).expect(401);
  await ds.getRepository(Empresa).update(b.empresaId, { estado: 'SUSPENDIDA' });
  await request(app.getHttpServer()).get('/tenant/context').set('Authorization', 'Bearer ' + token(adminB)).expect(403);
  await request(app.getHttpServer()).post('/auth/login').send({ identifier: user.email, password: 'admin-changed-pass' }).expect(401);
  await ds.getRepository(Empresa).update(b.empresaId, { estado: 'ACTIVA' });
});

test('login limita intentos repetidos', async () => {
  for (let i = 0; i < 15; i++) await request(app.getHttpServer()).post('/auth/login').send({ identifier: 'limit@example.test', password: 'wrong-password' }).expect(401);
  await request(app.getHttpServer()).post('/auth/login').send({ identifier: 'limit@example.test', password: 'wrong-password' }).expect(429);
});

test('sockets autenticados: eventos solo a su playa y revocación de acceso efectiva', async () => {
  const {
    io,
  } = require('../../estacionamiento-front-demo/node_modules/socket.io-client');
  const gateway = app.get(load('tickets/register-gateway', 'TicketGateway'));
  const url = await app.getUrl();
  const connections = [];
  const connect = async (who, scope) => {
    const socket = io(url, {
      transports: ['websocket'],
      auth: { token: token(who), playaId: scope.playaId },
      reconnection: false,
    });
    connections.push(socket);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    for (let i = 0; i < 100; i++) {
      if (
        gateway.server.sockets.adapter.rooms
          .get(`playa:${scope.playaId}`)
          ?.has(socket.id)
      )
        return socket;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error('Socket did not join its authenticated room');
  };
  try {
    const sa = await connect(adminA, a),
      sb = await connect(adminB, b);
    const receivedA = [],
      receivedB = [];
    sa.on('new-registration', (d) => receivedA.push(d));
    sb.on('new-registration', (d) => receivedB.push(d));
    await scoped(a, () => gateway.emitNewRegistration({ id: 'only-A' }));
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(receivedA, [{ id: 'only-A' }]);
    assert.deepEqual(receivedB, []);
    await ds.getRepository(User).softDelete(adminA.id);
    await scoped(a, () => gateway.emitNewRegistration({ id: 'not-delivered' }));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(sa.connected, false);
    assert.equal(receivedA.length, 1);
  } finally {
    connections.forEach((s) => s.disconnect());
  }
});
