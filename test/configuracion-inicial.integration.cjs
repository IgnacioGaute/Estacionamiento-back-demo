// Configuración inicial de una playa nueva. Ejecutar después de pnpm build.
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
const User = load('users/entities/user.entity', 'User');
const Empresa = load('tenancy/entities/empresa.entity', 'Empresa');
const Playa = load('tenancy/entities/playa.entity', 'Playa');
const { tenantContext } = require('../dist/tenancy/tenant-context');

let ds, root, app, pgStarted = false, existente;
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'configuracion-pg-test-'));
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
  // Una playa que ya funcionaba antes de la migración. synchronize creó la columna desde la
  // entidad: se quita para que la base quede como estaba antes de este cambio.
  const empresaVieja = await ds.getRepository(Empresa).save({ nombre: 'Empresa con playa vieja' });
  existente = await ds.getRepository(Playa).save({ nombre: 'Existente', empresaId: empresaVieja.id });
  await ds.query('ALTER TABLE playas DROP COLUMN "configuracionInicial"');
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
      ['1790000044000-datos-cliente-estadia', 'DatosClienteEstadia1790000044000'],
      ['1790000045000-qr-plan', 'QrPlan1790000045000'],
      ['1790000046000-origen-registro', 'OrigenRegistro1790000046000'],
      ['1790000047000-configuracion-inicial', 'ConfiguracionInicial1790000047000'],
    ]) await new (load('database/migrations/' + file, name))().up(runner);
  } finally { await runner.release(); }
  installTenantConnections(ds);
  const options = { ...ds.options, synchronize: false, migrationsRun: false };
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ NEXTAUTH_SECRET: 'configuracion-test-secret', API_SECRET_TOKEN: 'test-static-secret' })] }),
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
    assert.ok(path.basename(resolved).startsWith('configuracion-pg-test-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

const request = require('supertest');
const { JwtService } = require('@nestjs/jwt');
const jwt = new JwtService({ secret: 'configuracion-test-secret' });
const token = (u) => jwt.sign({ id: u.id, role: u.role, authVersion: u.authVersion ?? 0 }, { expiresIn: '10m' });
const http = (method, route, who, playaId) => {
  const r = request(app.getHttpServer())[method](route).set('Authorization', 'Bearer ' + token(who));
  return playaId ? r.set('X-Playa-Id', playaId) : r;
};
const pendiente = async (who, playaId) => (await http('get', '/tenant/context', who).expect(200)).body.playas.find((p) => p.id === playaId)?.configuracionPendiente;

let superAdmin, adminA, adminB, operador, nueva, otra;

test('la migración marca terminadas las playas que ya existían y las nuevas arrancan pendientes', async () => {
  const users = ds.getRepository(User);
  superAdmin = await users.save({ username: 'root', email: 'root@example.test', firstName: 'Root', lastName: 'Test', role: 'SUPER_ADMIN' });
  const vieja = await ds.getRepository(Playa).findOneBy({ id: existente.id });
  assert.ok(vieja.configuracionInicial.terminadaEn);
  const eA = (await http('post', '/tenancy/empresas', superAdmin).send({ nombre: 'Empresa A' }).expect(201)).body;
  const eB = (await http('post', '/tenancy/empresas', superAdmin).send({ nombre: 'Empresa B' }).expect(201)).body;
  nueva = (await http('post', `/tenancy/empresas/${eA.id}/playas`, superAdmin).send({ nombre: 'Playa sin configurar' }).expect(201)).body;
  otra = (await http('post', `/tenancy/empresas/${eB.id}/playas`, superAdmin).send({ nombre: 'Otra empresa' }).expect(201)).body;
  adminA = await users.save({ username: 'adminA', email: 'a@example.test', firstName: 'Admin', lastName: 'A', role: 'ADMIN', empresaId: eA.id });
  adminB = await users.save({ username: 'adminB', email: 'b@example.test', firstName: 'Admin', lastName: 'B', role: 'ADMIN', empresaId: eB.id });
  operador = await users.save({ username: 'op', email: 'op@example.test', firstName: 'Ana', lastName: 'Operadora', role: 'USER', empresaId: eA.id });
  await ds.query(`INSERT INTO usuario_playas ("usuarioId","playaId","rolPlaya") VALUES ($1,$2,'OPERADOR')`, [operador.id, nueva.id]);
  assert.equal(await pendiente(adminA, nueva.id), true);
  assert.equal(await pendiente(superAdmin, existente.id), false);
  // Repetir la migración no rompe nada ni vuelve a tocar las pendientes.
  const runner = ds.createQueryRunner();
  try { await new (load('database/migrations/1790000047000-configuracion-inicial', 'ConfiguracionInicial1790000047000'))().up(runner); } finally { await runner.release(); }
  assert.equal(await pendiente(adminA, nueva.id), true);
});

test('el administrador guarda nombre y dirección; queda registrado el avance', async () => {
  const inicio = (await http('get', '/configuracion-inicial', adminA, nueva.id).expect(200)).body;
  assert.deepEqual(inicio, { playa: { id: nueva.id, nombre: 'Playa sin configurar', direccion: null }, configuracion: {} });
  const conNombre = (await http('patch', '/configuracion-inicial/playa', adminA, nueva.id).send({ nombre: '  Playa Centro  ' }).expect(200)).body;
  assert.equal(conNombre.playa.nombre, 'Playa Centro');
  assert.deepEqual(conNombre.configuracion.hechos, ['nombre']);
  const conDireccion = (await http('patch', '/configuracion-inicial/playa', adminA, nueva.id).send({ direccion: 'Av. San Martín 1234, Mendoza' }).expect(200)).body;
  assert.deepEqual(conDireccion.playa, { id: nueva.id, nombre: 'Playa Centro', direccion: 'Av. San Martín 1234, Mendoza' });
  assert.deepEqual(conDireccion.configuracion.hechos, ['nombre', 'ubicacion']);
  await http('patch', '/configuracion-inicial/playa', adminA, nueva.id).send({}).expect(400);
  await http('patch', '/configuracion-inicial/playa', adminA, nueva.id).send({ nombre: '   ' }).expect(400);
  await http('patch', '/configuracion-inicial/playa', adminA, nueva.id).send({ nombre: 'X', modalidad: 'GRATUITO' }).expect(400);
  assert.equal((await ds.getRepository(Playa).findOneBy({ id: nueva.id })).modalidad, 'CON_COBRO');
});

test('solo el administrador de esa empresa; el rol operativo sigue sin poder escribir playas', async () => {
  await http('get', '/configuracion-inicial', operador).expect(403);
  await http('patch', '/configuracion-inicial/playa', operador).send({ nombre: 'Del operador' }).expect(403);
  await http('patch', '/configuracion-inicial/avance', operador).send({ hecho: 'vehiculos' }).expect(403);
  await http('get', '/configuracion-inicial', adminB, nueva.id).expect(403);
  await http('patch', '/configuracion-inicial/playa', adminB, nueva.id).send({ nombre: 'Ajena' }).expect(403);
  // Sin elegir playa, el administrador de una empresa con una sola playa opera en esa.
  assert.equal((await http('get', '/configuracion-inicial', adminB).expect(200)).body.playa.id, otra.id);
  await assert.rejects(tenantContext.run({ empresaId: nueva.empresaId, playaId: nueva.id, userId: adminA.id }, () =>
    ds.query(`UPDATE playas SET nombre = 'Directo' WHERE id = $1`, [nueva.id])));
  assert.equal((await ds.getRepository(Playa).findOneBy({ id: nueva.id })).nombre, 'Playa Centro');
});

test('pasos obligatorios, omitibles y terminar', async () => {
  const avance = (body) => http('patch', '/configuracion-inicial/avance', adminA, nueva.id).send(body);
  assert.equal((await avance({ omitido: 'tarifas' }).expect(400)).body.code, 'PASO_OBLIGATORIO');
  await avance({ hecho: 'otro' }).expect(400);
  const incompleta = (await avance({ terminar: true }).expect(400)).body;
  assert.equal(incompleta.code, 'CONFIGURACION_INCOMPLETA');
  assert.deepEqual(incompleta.faltan, ['vehiculos', 'tarifas']);
  await avance({ hecho: 'vehiculos', paso: 'tarifas' }).expect(200);
  await avance({ hecho: 'tarifas', paso: 'pases' }).expect(200);
  await avance({ omitido: 'pases', paso: 'turnos' }).expect(200);
  await avance({ omitido: 'turnos', paso: 'mercadopago' }).expect(200);
  await avance({ omitido: 'mercadopago', paso: 'usuarios' }).expect(200);
  const intermedio = (await http('get', '/configuracion-inicial', adminA, nueva.id).expect(200)).body.configuracion;
  assert.deepEqual(intermedio, { paso: 'usuarios', hechos: ['nombre', 'ubicacion', 'vehiculos', 'tarifas'], omitidos: ['pases', 'turnos', 'mercadopago'] });
  assert.equal(await pendiente(adminA, nueva.id), true);
  const terminada = (await avance({ hecho: 'usuarios', terminar: true }).expect(200)).body.configuracion;
  assert.ok(terminada.terminadaEn);
  assert.equal(await pendiente(adminA, nueva.id), false);
  assert.equal(await pendiente(operador, nueva.id), false);
});
