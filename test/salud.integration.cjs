// Disponibilidad y correlación sobre HTTP real, con PostgreSQL temporal: /salud responde sin
// sesión (y nada más se abre por eso), devuelve X-Request-Id y dice 503 cuando la base no contesta.
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawnSync } = require('child_process');
require('reflect-metadata');
const { DataSource } = require('typeorm');

const load = (p, name) => require('../dist/' + p)[name];
const bin = process.env.PG_TEST_BIN;
const pg = (cmd, args) => {
  const exe = bin ? path.join(bin, cmd) : cmd;
  // PostgreSQL hereda stdout en Windows; un pipe mantendría spawnSync esperando aunque pg_ctl termine.
  const r = spawnSync(exe, args, { stdio: 'ignore', windowsHide: true });
  if (r.status !== 0) throw new Error(`${cmd} falló (${r.status})`);
};
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

let root, app, ds, base, pgStarted = false;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'salud-pg-test-'));
  pg('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--locale=C']);
  const port = await freePort();
  pg('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'postgres.log'), '-o', '-h 127.0.0.1 -p ' + port + ' -F', '-w', 'start']);
  pgStarted = true;
  ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: 'postgres', entities: [], synchronize: false });
  await ds.initialize();
  const { Test } = require('@nestjs/testing');
  const { TypeOrmModule } = require('@nestjs/typeorm');
  const { ConfigModule, ConfigService } = require('@nestjs/config');
  const { APP_GUARD } = require('@nestjs/core');
  const { Controller, Get } = require('@nestjs/common');
  // Una ruta cualquiera que exige sesión: abrir /salud no puede abrir otras.
  class PrivadoController { datos() { return { secreto: true }; } }
  Controller('privado')(PrivadoController);
  Get()(PrivadoController.prototype, 'datos', Object.getOwnPropertyDescriptor(PrivadoController.prototype, 'datos'));
  const module = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), TypeOrmModule.forRoot({ ...ds.options })],
    controllers: [load('common/salud.controller', 'SaludController'), PrivadoController],
    providers: [
      load('utils/strategies/jwt.strategy', 'JwtStrategy'),
      // Sin token la estrategia ni llega a buscar la cuenta.
      { provide: require('@nestjs/typeorm').getRepositoryToken(load('users/entities/user.entity', 'User')), useValue: { findOne: async () => null, findOneBy: async () => null } },
      { provide: ConfigService, useValue: { get: () => 'isolated-salud-test-secret', getOrThrow: () => 'isolated-salud-test-secret' } },
      { provide: APP_GUARD, useClass: load('tenancy/tenant-access', 'TenantGuard') },
    ],
  }).compile();
  app = module.createNestApplication();
  app.use(load('common/solicitud.middleware', 'solicitudMiddleware'));
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
});

after(async () => {
  if (app) await app.close().catch(() => {});
  if (ds?.isInitialized) await ds.destroy().catch(() => {});
  if (pgStarted && fs.existsSync(path.join(root, 'data', 'postmaster.pid'))) pg('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'immediate', '-w', 'stop']);
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test('/salud responde listo sin sesión, sin caché y con la versión', async () => {
  const r = await fetch(`${base}/salud`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const datos = await r.json();
  assert.equal(datos.estado, 'listo');
  assert.equal(typeof datos.version, 'string');
});

test('el id de correlación del frontend vuelve en la respuesta; uno inseguro se reemplaza', async () => {
  const propio = await fetch(`${base}/salud`, { headers: { 'X-Request-Id': 'front-req-12345678' } });
  assert.equal(propio.headers.get('x-request-id'), 'front-req-12345678');
  const inseguro = await fetch(`${base}/salud`, { headers: { 'X-Request-Id': 'a b<c>' } });
  assert.match(inseguro.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
});

test('abrir /salud no abre otras rutas: sin sesión siguen dando 401', async () => {
  const r = await fetch(`${base}/privado`);
  assert.equal(r.status, 401);
  assert.ok(r.headers.get('x-request-id'));
});

test('con la base caída responde 503 con código y sin detalles de la conexión', async () => {
  pg('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'immediate', '-w', 'stop']);
  const r = await fetch(`${base}/salud`);
  assert.equal(r.status, 503);
  const texto = await r.text();
  assert.match(texto, /BASE_NO_DISPONIBLE/);
  assert.doesNotMatch(texto, /127\.0\.0\.1|ECONNREFUSED|postgres/);
});
