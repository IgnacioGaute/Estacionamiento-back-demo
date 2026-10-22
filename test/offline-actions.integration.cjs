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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-actions-pg-test-'));
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
    assert.ok(path.basename(resolved).startsWith('offline-actions-pg-test-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

const { randomUUID: uuid } = require('node:crypto');
const dayjs = require('dayjs');
const OfflineService = load('tickets/offline.service', 'OfflineService');
const TicketsService = load('tickets/tickets.service', 'TicketsService');
const TurnosService = load('turnos/turnos.service', 'TurnosService');
const { offlineVehicleState } = require('../dist/tickets/offline-actions.service');
const calculate = load('tickets/pricing/stay-pricing', 'calculateStayPrice');
let scope, offline, service, shifts, session, deviceId, time;
const run = fn => tenantContext.run(scope, fn);
const operation = (action, id, data, extra = {}) => ({ id: uuid(), deviceId, sessionId: session.sessionId, registrationId: id, kind: 'ACTION', action, data, occurredAt: new Date(time += 1000).toISOString(), shiftId: session.shift?.id ?? null, ...extra });
async function expected(id) {
  const r = await ds.getRepository(Registration).findOneByOrFail({ id });
  const [discount] = await ds.query('SELECT COALESCE(SUM(monto),0) AS total FROM movimientos WHERE "ticketRegistrationId"=$1 AND tipo=\'DESCUENTO\'', [id]);
  return offlineVehicleState({ plate: r.licensePlateOriginal || r.codeBarTicket || r.lastNameCustomer || 'Sin patente', vehicleType: r.vehicleType, entry: dayjs.tz(`${r.entryDay} ${r.entryTime}`, 'America/Argentina/Buenos_Aires').toISOString(), collected: await service.collectedAmount(r), discount: Number(discount.total) });
}
test('prepara una playa y la copia completa con caja, tarjetas y abonos', async () => {
  const empresa = await ds.getRepository(Empresa).save({ nombre:'Offline' });
  const playa = await ds.getRepository(Playa).save({ nombre:'Prueba', empresaId:empresa.id });
  const user = await ds.getRepository(User).save({ username:'offline',email:'offline@example.test',firstName:'Ana',lastName:'Offline',role:'ADMIN',empresaId:empresa.id });
  scope = { empresaId:empresa.id,playaId:playa.id,userId:user.id,role:'ADMIN' };
  offline = app.get(OfflineService); service = app.get(TicketsService); shifts = app.get(TurnosService);
  await run(async () => {
    await service.createVehicleType({code:'AUTO',name:'Auto'});
    await service.createPriceBracket({vehicleType:'AUTO',label:'Hora',uptoMinutes:null,price:1000});
    await ds.getRepository(load('tickets/entities/ticket-price.entity','TicketPrice')).save({vehicleType:'AUTO',ticketTimeType:'DIA',ticketTimePrice:500});
    await service.updateSchedule({ shiftsEnabled:true });
    session = await offline.prepare(deviceId = uuid());
    assert.equal(session.operationVersion,3); assert.equal(session.role,'ADMIN'); assert.ok(session.cash.cajas.length); assert.equal(session.passPrices[0].ticketTimePrice,500);
    time = Math.floor(Date.now()/1000)*1000 - 60000;
  });
});
test('apertura, anticipo, descuento, pago parcial y mixto conservan hora y se cobran una vez', async () => run(async () => {
  const shiftId=uuid(), cashSessionId=uuid(), caja=session.cash.cajas[0];
  const opening=operation('SHIFT_OPEN',shiftId,{cajaId:caja.id,fondoInicial:100,cambioAgregado:0,motivoApertura:'Fondo recibido'},{cashSessionId});
  await offline.synchronize(opening); await offline.synchronize(opening);
  session.shift={id:shiftId};
  const id=uuid(), entry=operation('PLATE_ENTRY',id,{licensePlate:'OFFNEW',vehicleType:'AUTO',casilleroNumber:'4',lastNameCustomer:'Pérez'});
  await offline.synchronize(entry);
  await offline.synchronize({...entry,data:{vehicleType:'AUTO',casilleroNumber:'4',lastNameCustomer:'Pérez',licensePlate:'OFFNEW'}});
  const advance=operation('ADVANCE',id,{advancePaidAmount:300,metodo:'CASH'},{expectedState:await expected(id)});
  await offline.synchronize(advance); await offline.synchronize(advance);
  await offline.synchronize(operation('DISCOUNT',id,{monto:100,motivo:'Acuerdo con cliente',expectedPrice:1000,expectedCollected:300},{expectedState:await expected(id)}));
  await offline.synchronize(operation('PARTIAL_CASH',id,{importe:200,expectedPrice:900,expectedCollected:300},{expectedState:await expected(id)}));
  const closing=operation('CLOSE',id,{closeType:'PAYMENT',expectedPrice:900,expectedCollected:500,pagos:[{metodo:'CASH',importe:100},{metodo:'TRANSFER',importe:300}]},{expectedState:await expected(id)});
  await Promise.all([offline.synchronize(closing),offline.synchronize(closing)]);
  const r=await ds.getRepository(Registration).findOneByOrFail({id});
  assert.equal(r.price,900); assert.equal(r.casilleroNumber,'4'); assert.equal(r.departureTime,dayjs(closing.occurredAt).tz('America/Argentina/Buenos_Aires').format('HH:mm:ss'));
  const rows=await ds.getRepository(load('movimientos/entities/movimiento.entity','Movimiento')).find({where:{ticketRegistration:{id}}});
  assert.equal(rows.length,5); assert.equal(rows.filter(m=>m.tipo==='SALDO').length,3); assert.equal((await shifts.getCashContext()).active.efectivoDisponible,700);
  assert.ok(rows.every(m=>m.fechaHora.getTime()<=time));
  await assert.rejects(offline.synchronize({...closing,id:uuid()}),/cerró/);
  await assert.rejects(offline.synchronize({...advance,data:{advancePaidAmount:900,metodo:'CASH'}}),/otros datos/);
}));
test('devolución, cortesía, cambios de datos y hora, y eliminación respetan las reglas normales', async () => run(async () => {
  const id=uuid(); await offline.synchronize(operation('PLATE_ENTRY',id,{noPlate:true,lastNameCustomer:'Sin patente',vehicleType:'AUTO'}));
  await offline.synchronize(operation('EDIT',id,{licensePlate:'CORREGIDA'},{expectedState:await expected(id)}));
  await offline.synchronize(operation('EDIT_ENTRY',id,{entrada:new Date(time-3600000).toISOString()},{expectedState:await expected(id)}));
  await offline.synchronize(operation('ADVANCE',id,{advancePaidAmount:1200,metodo:'CASH'},{expectedState:await expected(id)}));
  await offline.synchronize(operation('CLOSE',id,{closeType:'NO_CHARGE',expectedPrice:1000,expectedCollected:1200,refundMetodo:'CASH'},{expectedState:await expected(id)}));
  const courtesy=uuid(); await offline.synchronize(operation('PLATE_ENTRY',courtesy,{licensePlate:'CORTESIA',vehicleType:'AUTO'}));
  await offline.synchronize(operation('CLOSE',courtesy,{closeType:'COURTESY',expectedPrice:1000,expectedCollected:0,motivo:'Visita autorizada'},{expectedState:await expected(courtesy)}));
  const mistaken=uuid(); await offline.synchronize(operation('PLATE_ENTRY',mistaken,{licensePlate:'ERROR',vehicleType:'AUTO'}));
  const deletion=operation('DELETE',mistaken,{}, {expectedState:await expected(mistaken)});
  await assert.rejects(tenantContext.run({...scope,role:'USER'},()=>offline.synchronize(deletion)),/administrador/);
  await offline.synchronize(deletion); assert.equal(await ds.getRepository(Registration).existsBy({id:mistaken}),false);
}));
test('abono, gasto, aporte y cierre de caja se confirman sin duplicarse', async () => run(async () => {
  const id=uuid(); await offline.synchronize(operation('PASS_ENTRY',id,{vehiclePlateCustomer:'ABONO',vehicleType:'AUTO',ticketTimeType:'DIA',days:1,paid:false,paymentMetodo:'CASH'}));
  const passState=JSON.stringify([500,false,false,'CASH']);
  await offline.synchronize(operation('PASS_UPDATE',id,{paid:true,retired:true,paymentMetodo:'CASH'},{expectedState:passState}));
  await offline.synchronize(operation('BOX_MOVEMENT',uuid(),{type:'EGRESOS',price:100,paymentMethod:'CASH',description:'Insumos'}));
  let cash=(await shifts.getCashContext()).active;
  await offline.synchronize(operation('CASH_MOVEMENT',cash.cashSessionId,{tipo:'APORTE',importe:50,motivo:'Cambio',efectivoEsperado:cash.efectivoDisponible}));
  cash=(await shifts.getCashContext()).active;
  const close=operation('SHIFT_CLOSE',cash.id,{cerrarCaja:true,efectivoContado:cash.efectivoDisponible,efectivoEsperado:cash.efectivoDisponible,efectivoParaSiguiente:200,sueldoEsperado:0});
  await offline.synchronize(close); await offline.synchronize(close);
  const saved=await ds.getRepository(load('turnos/entities/turno.entity','Turno')).findOneByOrFail({id:cash.id});
  assert.equal(saved.estado,'CERRADO'); assert.equal(saved.efectivoParaSiguiente,200); assert.equal(saved.fechaCierre.toISOString(),close.occurredAt);
}));

test('tarifas descargadas, conflictos de estado y validación no dejan asientos parciales', async () => run(async () => {
  await service.updateSchedule({shiftsEnabled:false});
  deviceId=uuid(); session=await offline.prepare(deviceId);time=Math.floor(Date.now()/1000)*1000-60000;
  const bracket=await ds.getRepository(load('tickets/entities/ticket-price-bracket.entity','TicketPriceBracket')).findOneByOrFail({vehicleType:'AUTO'});
  await ds.getRepository(load('tickets/entities/ticket-price-bracket.entity','TicketPriceBracket')).update(bracket.id,{price:2000});
  const id=uuid(),entry=operation('PLATE_ENTRY',id,{licensePlate:'TARIFA',vehicleType:'AUTO'});
  await offline.synchronize(entry);
  const r=await ds.getRepository(Registration).findOneByOrFail({id});
  assert.equal(calculate(r.pricingSnapshot,'AUTO',new Date(entry.occurredAt),new Date(time+1000)).price,1000);
  const before=await expected(id);
  await assert.rejects(offline.synchronize(operation('ADVANCE',id,{advancePaidAmount:100,metodo:'MERCADOPAGO'},{expectedState:before})),/datos/);
  assert.equal(await service.collectedAmount(r),0);
  await assert.rejects(offline.synchronize(operation('EDIT',id,{licensePlate:'MOD',playaId:uuid()},{expectedState:before})),/datos/);
  assert.equal((await ds.getRepository(Registration).findOneByOrFail({id})).licensePlateOriginal,'TARIFA');
  await ds.getRepository(Registration).update(id,{licensePlateOriginal:'OTROEQUIPO'});
  await assert.rejects(offline.synchronize(operation('CLOSE',id,{closeType:'PAYMENT',expectedPrice:1000,expectedCollected:0,metodo:'CASH'},{expectedState:before})),/otro equipo/);
  assert.equal((await ds.getRepository(Registration).findOneByOrFail({id})).departureTime,null);
  await assert.rejects(offline.synchronize(operation('PLATE_ENTRY',id,{licensePlate:'COLISION',vehicleType:'AUTO'})),/identificador/);
  await assert.rejects(tenantContext.run({...scope,userId:uuid()},()=>offline.synchronize(entry)),/otro usuario/);
}));

test('compatibilidad de abonos sin retiro y registros anteriores a snapshots', async () => run(async () => {
  const passId=uuid();
  await offline.synchronize(operation('PASS_ENTRY',passId,{vehiclePlateCustomer:'SINRETIRAR',vehicleType:'AUTO',ticketTimeType:'DIA',days:1,paid:false,paymentMetodo:'CASH'}));
  const legacy=await service.createRegistrationByPlate({licensePlate:'ANTERIOR',vehicleType:'AUTO'},scope.userId);
  await ds.getRepository(Registration).update(legacy.id,{pricingSnapshot:null});
  deviceId=uuid();session=await offline.prepare(deviceId);
  assert.ok(session.passes.some(p=>p.id===passId));
  assert.ok(session.vehicles.find(v=>v.id===legacy.id).pricing);
  const op=operation('CLOSE',legacy.id,{closeType:'PAYMENT',metodo:'CASH',expectedPrice:2000,expectedCollected:0},{expectedState:await expected(legacy.id)});
  op.occurredAt=new Date(Math.floor(Date.now()/1000)*1000+1000).toISOString();
  await offline.synchronize(op);
  assert.equal((await ds.getRepository(Registration).findOneByOrFail({id:legacy.id})).price,2000);
}));

test('la API valida acciones anidadas y mantiene la idempotencia al perder una respuesta', async () => {
  const user=await ds.getRepository(User).findOneByOrFail({id:scope.userId});
  const jwt=new (require('@nestjs/jwt').JwtService)({secret:'modalidad-test-secret'});
  const token=jwt.sign({id:user.id,role:user.role,authVersion:user.authVersion??0},{expiresIn:'10m'});
  const request=require('supertest');
  const post=(route,body)=>request(app.getHttpServer()).post('/tickets/offline/'+route).set('Authorization','Bearer '+token).set('X-Playa-Id',scope.playaId).send(body);
  const deviceId=uuid(), prepared=await post('prepare',{deviceId}).expect(201);
  const op={deviceId,sessionId:prepared.body.sessionId,id:uuid(),registrationId:uuid(),kind:'ACTION',action:'PLATE_ENTRY',occurredAt:new Date(Math.floor(Date.now()/1000)*1000).toISOString(),shiftId:null,data:{licensePlate:'HTTP123',vehicleType:'AUTO'}};
  await post('sync',{...op,data:{...op.data,empresaId:uuid()}}).expect(400);
  assert.equal(await ds.getRepository(Registration).existsBy({id:op.registrationId}),false);
  await post('sync',op).expect(201);await post('sync',op).expect(201);
  assert.equal(await ds.getRepository(Registration).countBy({id:op.registrationId}),1);
});

test('el flujo gratuito nuevo admite tarjeta, correcciones y salida sin producir caja', async () => {
  const playa=await ds.getRepository(Playa).save({nombre:'Gratuita offline',empresaId:scope.empresaId,modalidad:'GRATUITO'});
  await tenantContext.run({...scope,playaId:playa.id},async()=>{
    await service.createVehicleType({code:'AUTO',name:'Auto'});
    const card=await ds.getRepository(Ticket).save({codeBar:'FREE1',vehicleType:'AUTO'});
    const deviceId=uuid(),s=await offline.prepare(deviceId),id=uuid();
    assert.equal(s.cash,null);assert.equal(s.pricing,null);
    const base={deviceId,sessionId:s.sessionId,registrationId:id,kind:'ACTION',shiftId:null,occurredAt:new Date(Math.floor(Date.now()/1000)*1000).toISOString()};
    await offline.synchronize({...base,id:uuid(),action:'CARD_ENTRY',data:{ticketId:card.id}});
    const state=await expected(id);
    await assert.rejects(offline.synchronize({...base,id:uuid(),action:'ADVANCE',data:{advancePaidAmount:100,metodo:'CASH'},expectedState:state}),/gratuita|Gratuita|gratuito/);
    const close={...base,id:uuid(),action:'CLOSE',data:{},expectedState:state};
    await offline.synchronize(close);await offline.synchronize(close);
    assert.equal((await ds.getRepository(Registration).findOne({where:{id},relations:['ticket']})).ticket,null);
    assert.equal(Number((await ds.query('SELECT count(*) AS n FROM cash_entries WHERE "playaId"=$1',[playa.id]))[0].n),0);
    assert.equal(Number((await ds.query('SELECT count(*) AS n FROM movimientos WHERE "playaId"=$1',[playa.id]))[0].n),0);
  });
});

