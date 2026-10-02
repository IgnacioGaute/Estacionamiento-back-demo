// Planes y cuentas de las empresas con la plataforma. Ejecutar después de pnpm build (carga desde
// dist/). PostgreSQL efímero: nunca lee .env ni usa la base del proyecto.
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

const Empresa = load('tenancy/entities/empresa.entity', 'Empresa');
const Playa = load('tenancy/entities/playa.entity', 'Playa');
const User = load('users/entities/user.entity', 'User');
const Registration = load('tickets/entities/ticket-registration.entity', 'TicketRegistration');
const SuscripcionesService = load('saas/suscripciones.service', 'SuscripcionesService');
const { CobrosPlataformaService, empresaDeReferencia } = require('../dist/saas/cobros-plataforma.service');
const MercadoPagoPlataforma = load('saas/mercadopago-plataforma', 'MercadoPagoPlataforma');
const reglas = require('../dist/saas/estado-cuenta');
const { tenantContext, installTenantConnections } = require('../dist/tenancy/tenant-context');

let ds, root, pgStarted = false, servicio, superUser;
const bin = process.env.PG_TEST_BIN || 'C:/Program Files/PostgreSQL/18/bin';
const pg = (name, args) => {
  const output = fs.openSync(path.join(root, 'commands.log'), 'a');
  try { return execFileSync(path.join(bin, name + (process.platform === 'win32' ? '.exe' : '')), args, { windowsHide: true, stdio: ['ignore', output, output], timeout: 60000 }); }
  finally { fs.closeSync(output); }
};
const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const hoy = reglas.hoyAR();
const dia = (n) => reglas.sumarDias(hoy, n);

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'suscripciones-pg-test-'));
  pg('initdb', ['-D', path.join(root, 'data'), '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--locale=C']);
  const port = await freePort();
  pgStarted = true;
  pg('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'postgres.log'), '-o', '-h 127.0.0.1 -p ' + port + ' -F', '-w', 'start']);
  ds = new DataSource({ type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: 'postgres', entities: [path.resolve('dist/**/*.entity.js')], migrations: [load('database/migrations/1790000000000-flexible-vehicle-types', 'FlexibleVehicleTypes1790000000000')], migrationsRun: true, synchronize: true });
  await ds.initialize();
  // Una empresa de antes de los planes: la migración tiene que dejarla sin activar, sin vencimiento.
  const vieja = await ds.getRepository(Empresa).save({ nombre: 'Empresa vieja' });
  const runner = ds.createQueryRunner();
  try {
    await new (load('database/migrations/1790000001000-tenant-isolation', 'TenantIsolation1790000001000'))().up(runner);
    // Dos arranques simultáneos pueden correrlas dos veces: no tienen que romper ni duplicar.
    for (let i = 0; i < 2; i++) {
      await new (load('database/migrations/1790000021000-suscripciones', 'Suscripciones1790000021000'))().up(runner);
      await new (load('database/migrations/1790000022000-cuenta-alta', 'CuentaAlta1790000022000'))().up(runner);
      await new (load('database/migrations/1790000023000-facturas-anticipadas', 'FacturasAnticipadas1790000023000'))().up(runner);
      await new (load('database/migrations/1790000024000-debito-automatico', 'DebitoAutomatico1790000024000'))().up(runner);
    }
  } finally {
    await runner.release();
  }
  installTenantConnections(ds);
  servicio = new SuscripcionesService(ds);
  superUser = await ds.getRepository(User).save({ username: 'root', email: 'root@example.test', firstName: 'Root', lastName: 'Test', role: 'SUPER_ADMIN' });
  const cuenta = await servicio.resumen(vieja.id);
  assert.equal(cuenta.estado, 'SIN_ACTIVAR');
  assert.equal(cuenta.alta, hoy, 'el alta sale del día en que se creó la empresa');
});

after(async () => {
  if (ds?.isInitialized) await ds.destroy();
  if (pgStarted && fs.existsSync(path.join(root, 'data', 'postmaster.pid'))) pg('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'immediate', '-w', 'stop']);
  if (root) {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('suscripciones-pg-test-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// Empresa con alta hoy y `diasPrueba` días de prueba (null = sin activar).
async function nuevaEmpresa(nombre, { playas = 1, diasPrueba = 7, alta = hoy } = {}) {
  const empresa = await ds.getRepository(Empresa).save({ nombre });
  const lista = [];
  for (let i = 0; i < playas; i++)
    lista.push(await ds.getRepository(Playa).save({ empresaId: empresa.id, nombre: `${nombre} ${i + 1}` }));
  if (diasPrueba !== null) await servicio.activar(empresa.id, { alta, diasPrueba }, superUser.id);
  return { empresa, playas: lista };
}
const plan = async (codigo) => (await servicio.planes()).find((p) => p.codigo === codigo);
const estadoEmpresa = async (id) => (await ds.getRepository(Empresa).findOneBy({ id })).estado;
const fijar = (empresaId, campos) => ds.query(
  `UPDATE suscripciones SET ${Object.keys(campos).map((c, i) => `"${c}" = $${i + 2}`).join(', ')} WHERE "empresaId" = $1`,
  [empresaId, ...Object.values(campos)],
);

test('reglas: alta y prueba, factura el día del vencimiento, más de 5 días de atraso suspende', () => {
  assert.equal(reglas.sumarMeses('2026-01-31', 1), '2026-02-28');
  assert.equal(reglas.sumarMeses('2026-02-28', 1), '2026-03-31', 'el fin de mes sigue siendo fin de mes');
  assert.equal(reglas.finDePrueba('2026-03-01', 7), '2026-03-07', 'el alta es el primer día de prueba');
  assert.equal(reglas.finDePrueba('2026-03-01', 0), '2026-02-28', 'sin prueba, la primera factura vence el día del alta');
  const base = { empresaEstado: 'ACTIVA', alta: '2026-03-01', bonificada: false, pruebaHasta: '2026-03-07', pagadoHasta: null, prorrogaHasta: null, motivoSuspension: null };
  const s = (dia, extra = {}) => reglas.situacionDeCuenta({ ...base, ...extra }, dia);
  assert.equal(s('2026-03-07').estado, 'PRUEBA');
  assert.equal(s('2026-03-07').proximoVencimiento, '2026-03-08');
  assert.equal(reglas.correspondeFactura(base, '2026-03-07'), false, 'durante la prueba no hay factura');
  assert.equal(reglas.correspondeFactura(base, '2026-03-08'), true, 'al terminar la prueba se emite la del primer mes');
  assert.equal(s('2026-03-08').estado, 'VENCIDA');
  assert.equal(s('2026-03-08').diasDeAtraso, 0, 'vence hoy');
  assert.equal(s('2026-03-13').diasDeAtraso, 5);
  assert.equal(s('2026-03-13').debeSuspenderse, false, 'con 5 días de atraso sigue');
  assert.equal(s('2026-03-14').debeSuspenderse, true, 'con 6 se suspende');
  assert.equal(s('2026-03-08').suspendeEl, '2026-03-14');
  assert.equal(s('2026-03-16', { prorrogaHasta: '2026-03-20' }).debeSuspenderse, false, 'los días extra corren el corte');
  assert.equal(s('2026-03-16', { prorrogaHasta: '2026-03-20' }).diasDeAtraso, 8, 'pero el atraso se sigue contando');
  // Con débito automático MercadoPago reintenta la tarjeta varios días: se espera 10 en vez de 5.
  assert.equal(s('2026-03-18', { conDebito: true }).debeSuspenderse, false);
  assert.equal(s('2026-03-19', { conDebito: true }).debeSuspenderse, true);
  assert.equal(s('2026-03-08', { conDebito: true }).diasDeGracia, 10);
  assert.equal(s('2026-03-08', { conDebito: true }).suspendeEl, '2026-03-19');
  assert.equal(s('2026-09-01', { bonificada: true }).estado, 'BONIFICADA');
  assert.equal(s('2026-09-01', { pruebaHasta: null }).estado, 'SIN_ACTIVAR');
  // Pagó tarde pero siguió usando el sistema: el aniversario no se mueve.
  assert.deepEqual(reglas.periodoDelPago({ ...base, pagadoHasta: '2026-04-10' }, 1, '2026-04-13'), { desde: '2026-04-11', hasta: '2026-05-10' });
  // Estuvo cortado: el período arranca el día del pago.
  assert.deepEqual(reglas.periodoDelPago({ ...base, empresaEstado: 'SUSPENDIDA', motivoSuspension: 'FALTA_DE_PAGO', pagadoHasta: '2026-04-10' }, 3, '2026-05-20'), { desde: '2026-05-20', hasta: '2026-08-19' });
});

test('la migración carga los seis planes con los rangos de la landing, una sola vez', async () => {
  const planes = await servicio.planes();
  assert.equal(planes.length, 6);
  const mediana = planes.find((p) => p.codigo === 'MEDIANA_COCHERAS');
  assert.equal(mediana.precioMensual, 95000);
  assert.equal(mediana.maxActivos, 120);
  assert.equal(mediana.incluyeCocheras, true);
  assert.equal(mediana.nombre, 'Playa mediana + alquileres');
  assert.equal(planes.find((p) => p.codigo === 'CHICA').maxActivos, 50);
  assert.equal(planes.find((p) => p.codigo === 'GRANDE').maxActivos, null);
});

test('alta con prueba sin plan; el plan de cada playa, la playa adicional con 30% menos', async () => {
  const { empresa, playas } = await nuevaEmpresa('Prueba', { playas: 2 });
  let cuenta = await servicio.resumen(empresa.id);
  assert.equal(cuenta.estado, 'PRUEBA');
  assert.equal(cuenta.pruebaHasta, dia(6));
  assert.equal(cuenta.proximoVencimiento, dia(7), 'la primera factura, el día después de la prueba');
  assert.equal(cuenta.mensual, 0);
  assert.equal(cuenta.facturaPendiente, null, 'durante la prueba no hay factura');

  await servicio.asignarPlan(empresa.id, playas[0].id, { planId: (await plan('MEDIANA_COCHERAS')).id }, superUser.id);
  const detalle = await servicio.asignarPlan(empresa.id, playas[1].id, { planId: (await plan('CHICA')).id }, superUser.id);
  cuenta = detalle.cuenta;
  assert.equal(cuenta.mensual, 95000 + 35000, 'la segunda playa paga 30% menos');
  assert.equal(detalle.playas.find((p) => p.playaId === playas[1].id).adicional, true);
  assert.equal(detalle.playas.find((p) => p.playaId === playas[0].id).adicional, false);
  assert.equal((await ds.getRepository(Playa).findOneBy({ id: playas[0].id })).modulos.inquilinos, true);
  assert.equal(cuenta.facturaPendiente, null);

  // Cambiar el plan de la primera no le aplica el descuento; un precio pactado explícito manda.
  await servicio.asignarPlan(empresa.id, playas[0].id, { planId: (await plan('MEDIANA')).id }, superUser.id);
  await servicio.asignarPlan(empresa.id, playas[1].id, { planId: (await plan('CHICA')).id, precio: 40000 }, superUser.id);
  await servicio.editarPlan((await plan('CHICA')).id, { precioMensual: 60000 });
  cuenta = await servicio.resumen(empresa.id);
  assert.equal(cuenta.mensual, 70000 + 40000, 'subir la lista no toca lo pactado');
  assert.equal((await ds.getRepository(Playa).findOneBy({ id: playas[0].id })).modulos.inquilinos, false);
  assert.ok((await servicio.detalle(empresa.id)).historial.some((h) => h.accion === 'SUSCRIPCION_ALTA'));
});

test('termina la prueba: factura del primer mes, días de atraso y suspensión con más de 5', async () => {
  const { empresa, playas } = await nuevaEmpresa('Morosa');
  await servicio.asignarPlan(empresa.id, playas[0].id, { planId: (await plan('CHICA')).id }, superUser.id);
  // Prueba terminada ayer: hoy vence la primera factura.
  await fijar(empresa.id, { pruebaHasta: dia(-1) });
  assert.ok((await servicio.revisarVencimientos()).facturas >= 1);
  let cuenta = await servicio.resumen(empresa.id);
  assert.equal(cuenta.facturaPendiente.desde, hoy, 'la factura vence el día en que empieza el período');
  assert.equal(cuenta.diasDeAtraso, 0);

  // 5 días de atraso: sigue operando.
  await fijar(empresa.id, { pruebaHasta: dia(-6) });
  await servicio.revisarVencimientos();
  assert.equal(await estadoEmpresa(empresa.id), 'ACTIVA');
  cuenta = await servicio.resumen(empresa.id);
  assert.equal(cuenta.diasDeAtraso, 5);
  assert.equal(cuenta.facturaPendiente.desde, dia(-5), 'la pendiente sigue a la fecha real del vencimiento');

  // 6 días: se suspende.
  await fijar(empresa.id, { pruebaHasta: dia(-7) });
  assert.ok((await servicio.revisarVencimientos()).suspendidas >= 1);
  assert.equal(await estadoEmpresa(empresa.id), 'SUSPENDIDA');
  cuenta = await servicio.resumen(empresa.id);
  assert.equal(cuenta.motivoSuspension, 'FALTA_DE_PAGO');
  const pendiente = cuenta.facturaPendiente;
  assert.equal(pendiente.desde, dia(-6), 'suspendida, la factura no se corre: dice desde cuándo debe');
  await servicio.revisarVencimientos();
  assert.equal((await servicio.resumen(empresa.id)).facturaPendiente.desde, dia(-6));

  await servicio.registrarPago(empresa.id, { meses: 1, importe: 60000, medio: 'TRANSFERENCIA', fecha: hoy, referencia: 'TRF-1' }, superUser.id);
  assert.equal(await estadoEmpresa(empresa.id), 'ACTIVA');
  cuenta = await servicio.resumen(empresa.id);
  assert.equal(cuenta.estado, 'AL_DIA');
  assert.equal(cuenta.pagadoHasta, reglas.sumarDias(reglas.sumarMeses(hoy, 1), -1), 'estuvo cortada: el mes arranca hoy');
  assert.equal(cuenta.facturaPendiente, null);
  const [pagada] = (await servicio.detalle(empresa.id)).facturas;
  assert.equal(pagada.id, pendiente.id, 'pagó la factura pendiente, no creó otra');
  assert.equal(pagada.estado, 'PAGADA');

  // Anular el pago devuelve el vencimiento exacto y la próxima revisión la vuelve a suspender.
  await servicio.anularPago(empresa.id, pagada.id, 'Transferencia rechazada por el banco', superUser.id);
  assert.equal((await servicio.resumen(empresa.id)).pagadoHasta, null);
  await servicio.revisarVencimientos();
  assert.equal(await estadoEmpresa(empresa.id), 'SUSPENDIDA');
});

test('pago atrasado sin cortar: sigue desde su vencimiento; varios meses en una factura', async () => {
  const { empresa, playas } = await nuevaEmpresa('Tardía');
  await servicio.asignarPlan(empresa.id, playas[0].id, { planId: (await plan('GRANDE')).id }, superUser.id);
  await fijar(empresa.id, { pagadoHasta: dia(-2) });
  await servicio.registrarPago(empresa.id, { meses: 3, importe: 330000, medio: 'EFECTIVO', fecha: hoy }, superUser.id);
  const cuenta = await servicio.resumen(empresa.id);
  assert.equal(cuenta.pagadoHasta, reglas.sumarMeses(dia(-2), 3));
  const [factura] = (await servicio.detalle(empresa.id)).facturas;
  assert.equal(factura.desde, dia(-1));
  assert.equal(factura.meses, 3);
  await assert.rejects(
    servicio.registrarPago(empresa.id, { meses: 1, importe: 1, medio: 'EFECTIVO', fecha: dia(1) }, superUser.id),
    /futura/,
  );
});

test('días extra: alargan la prueba si nunca pagó, o corren la suspensión si ya paga', async () => {
  const prueba = await nuevaEmpresa('Prueba larga');
  await assert.rejects(servicio.diasExtra(prueba.empresa.id, dia(3), 'Cargando tarifas', superUser.id), /posterior/);
  let d = await servicio.diasExtra(prueba.empresa.id, dia(12), 'Está cargando las tarifas', superUser.id);
  assert.equal(d.cuenta.pruebaHasta, dia(12));
  assert.equal(d.cuenta.prorrogaHasta, null);
  assert.equal(d.historial[0].detalle.como, 'PRUEBA');

  const pagando = await nuevaEmpresa('Pagando');
  await servicio.asignarPlan(pagando.empresa.id, pagando.playas[0].id, { planId: (await plan('CHICA')).id }, superUser.id);
  await fijar(pagando.empresa.id, { pagadoHasta: dia(-10) });
  await servicio.revisarVencimientos();
  assert.equal(await estadoEmpresa(pagando.empresa.id), 'SUSPENDIDA');
  d = await servicio.diasExtra(pagando.empresa.id, dia(3), 'Paga el viernes', superUser.id);
  assert.equal(await estadoEmpresa(pagando.empresa.id), 'ACTIVA', 'los días extra la reactivan');
  assert.equal(d.cuenta.prorrogaHasta, dia(3));
  assert.equal(d.cuenta.pagadoHasta, dia(-10), 'el vencimiento no se mueve');
  assert.equal(d.cuenta.diasDeAtraso, 9, 'y el atraso se sigue contando');
  await servicio.revisarVencimientos();
  assert.equal(await estadoEmpresa(pagando.empresa.id), 'ACTIVA', 'la tarea diaria los respeta');

  const sinActivar = await nuevaEmpresa('Sin activar', { diasPrueba: null });
  await assert.rejects(servicio.diasExtra(sinActivar.empresa.id, dia(5), 'Algo', superUser.id), /alta/);
});

test('fecha de alta editable: mientras no pagó, la prueba se corre con ella', async () => {
  const { empresa, playas } = await nuevaEmpresa('Alta corrida', { diasPrueba: 10 });
  assert.equal((await servicio.resumen(empresa.id)).pruebaHasta, dia(9));
  let d = await servicio.editar(empresa.id, { alta: dia(-15) }, superUser.id);
  assert.equal(d.cuenta.alta, dia(-15));
  assert.equal(d.cuenta.pruebaHasta, dia(-6), 'conserva sus 10 días desde el alta nueva');
  assert.equal(d.cuenta.estado, 'VENCIDA');
  assert.equal(d.cuenta.diasDeAtraso, 5);
  // Con pagos, el alta es solo un dato.
  await servicio.asignarPlan(empresa.id, playas[0].id, { planId: (await plan('CHICA')).id }, superUser.id);
  await servicio.registrarPago(empresa.id, { meses: 1, importe: 60000, medio: 'TRANSFERENCIA', fecha: hoy }, superUser.id);
  const pagado = (await servicio.resumen(empresa.id)).pagadoHasta;
  d = await servicio.editar(empresa.id, { alta: dia(-30) }, superUser.id);
  assert.equal(d.cuenta.pagadoHasta, pagado);
  assert.equal(d.cuenta.alta, dia(-30));
  // Ya pagó: no se puede volver a dar de alta con prueba.
  await assert.rejects(servicio.activar(empresa.id, { alta: hoy, diasPrueba: 7 }, superUser.id), /Días extra/);
});

test('activar sin prueba: la primera factura vence el día del alta', async () => {
  const { empresa, playas } = await nuevaEmpresa('Sin prueba', { diasPrueba: null });
  await servicio.asignarPlan(empresa.id, playas[0].id, { planId: (await plan('MEDIANA')).id }, superUser.id);
  assert.equal((await servicio.resumen(empresa.id)).estado, 'SIN_ACTIVAR');
  const d = await servicio.activar(empresa.id, { alta: hoy, diasPrueba: 0 }, superUser.id);
  assert.equal(d.cuenta.estado, 'VENCIDA');
  assert.equal(d.cuenta.diasDeAtraso, 0);
  assert.equal(d.cuenta.facturaPendiente.desde, hoy);
  assert.equal(d.cuenta.facturaPendiente.importe, 70000);
});

test('suspensión manual: ni el pago ni la tarea diaria la levantan; bonificar anula la pendiente', async () => {
  const manual = await nuevaEmpresa('Manual');
  await ds.getRepository(Empresa).update(manual.empresa.id, { estado: 'SUSPENDIDA' });
  await servicio.cambioManualDeEstado(manual.empresa.id, 'SUSPENDIDA');
  await servicio.registrarPago(manual.empresa.id, { meses: 1, importe: 1000, medio: 'OTRO', fecha: hoy }, superUser.id);
  assert.equal(await estadoEmpresa(manual.empresa.id), 'SUSPENDIDA');

  const bonificada = await nuevaEmpresa('Bonificada');
  await servicio.asignarPlan(bonificada.empresa.id, bonificada.playas[0].id, { planId: (await plan('CHICA')).id }, superUser.id);
  await fijar(bonificada.empresa.id, { pruebaHasta: dia(-2) });
  await servicio.revisarVencimientos();
  assert.ok((await servicio.resumen(bonificada.empresa.id)).facturaPendiente);
  await servicio.editar(bonificada.empresa.id, { bonificada: true }, superUser.id);
  await fijar(bonificada.empresa.id, { pruebaHasta: dia(-30) });
  await servicio.revisarVencimientos();
  const cuenta = await servicio.resumen(bonificada.empresa.id);
  assert.equal(cuenta.estado, 'BONIFICADA');
  assert.equal(cuenta.facturaPendiente, null, 'la pendiente se anuló al bonificarla');
});

test('dos revisiones a la vez no duplican facturas', async () => {
  const { empresa, playas } = await nuevaEmpresa('Concurrente');
  await servicio.asignarPlan(empresa.id, playas[0].id, { planId: (await plan('CHICA')).id }, superUser.id);
  await fijar(empresa.id, { pruebaHasta: dia(-1) });
  await Promise.all([servicio.revisarVencimientos(), servicio.revisarVencimientos(), servicio.revisarVencimientos()]);
  const [{ n }] = await ds.query(`SELECT COUNT(*)::int AS n FROM facturas_saas WHERE "empresaId" = $1 AND estado = 'PENDIENTE'`, [empresa.id]);
  assert.equal(n, 1);
});

test('pico de estadías a la vez para el super admin; la empresa ve su plan pero no su uso', async () => {
  const a = await nuevaEmpresa('Con uso');
  const b = await nuevaEmpresa('Ajena');
  await servicio.asignarPlan(a.empresa.id, a.playas[0].id, { planId: (await plan('CHICA')).id }, superUser.id);
  await servicio.asignarPlan(b.empresa.id, b.playas[0].id, { planId: (await plan('GRANDE')).id }, superUser.id);
  const repo = ds.getRepository(Registration);
  const ayer = dia(-1);
  // Tres a la vez ayer entre las 10:30 y las 11; una sigue adentro.
  for (const [entra, sale] of [['10:00:00', '11:00:00'], ['10:30:00', '12:00:00'], ['10:15:00', null], ['12:00:00', '13:00:00']])
    await repo.save({ playaId: a.playas[0].id, description: 'x', price: 0, entryDay: ayer, entryTime: entra, departureDay: sale ? ayer : null, departureTime: sale });
  const detalle = await servicio.detalle(a.empresa.id);
  const uso = detalle.playas[0];
  assert.equal(uso.activos, 1);
  assert.equal(uso.pico, 3, 'a las 12:00 sale una y entra otra: no suma cuatro');

  const scopeA = { empresaId: a.empresa.id, playaId: a.playas[0].id, userId: superUser.id, role: 'ADMIN' };
  const miPlan = await tenantContext.run(scopeA, () => servicio.miPlan(a.empresa.id));
  assert.equal(miPlan.uso, undefined, 'la empresa no ve su uso contra el límite');
  assert.equal(miPlan.playas[0].plan.codigo, 'CHICA');
  assert.equal(miPlan.catalogo.length, 6, 've la lista de planes para ubicarse');
  assert.ok(miPlan.facturas.every((f) => f.nota === undefined), 'sin notas internas');
  const visibles = await tenantContext.run(scopeA, () => ds.query('SELECT DISTINCT "empresaId" FROM suscripcion_playas'));
  assert.deepEqual(visibles.map((f) => f.empresaId), [a.empresa.id], 'la empresa solo ve lo suyo');
  const ajena = await tenantContext.run(scopeA, () => ds.query('SELECT * FROM suscripciones WHERE "empresaId" = $1', [b.empresa.id]));
  assert.equal(ajena.length, 0);
  await assert.rejects(
    tenantContext.run(scopeA, () => ds.query(`INSERT INTO facturas_saas ("empresaId", desde, hasta, importe, estado) VALUES ($1, CURRENT_DATE, CURRENT_DATE, 1, 'PAGADA')`, [a.empresa.id])),
    /permission denied/,
  );
});

// MercadoPago en memoria: lo que respondería la API, sin red ni plata de verdad.
function mercadoPagoFalso() {
  const mp = {
    llamadas: [],
    pagos: new Map(),
    debitos: new Map(),
    cobros: new Map(),
    configurado: () => true,
    async crearPago(datos) {
      mp.llamadas.push(['crearPago', datos]);
      return { id: 'pref-' + mp.llamadas.length, url: 'https://mp.test/pagar' };
    },
    async pagosConReferencia(referencia) {
      return [...mp.pagos.values()].filter((p) => p.referencia === referencia);
    },
    async pago(id) {
      return mp.pagos.get(id);
    },
    async crearSuscripcion(datos) {
      mp.llamadas.push(['crearSuscripcion', datos]);
      const id = 'deb-' + (mp.debitos.size + 1);
      // Con la tarjeta del formulario queda autorizada en el acto; sin ella, a confirmar en MercadoPago.
      mp.debitos.set(id, datos.tarjeta
        ? { id, estado: 'authorized', referencia: datos.referencia, importe: datos.importe, url: null }
        : { id, estado: 'pending', referencia: datos.referencia, importe: datos.importe, url: 'https://mp.test/debito/' + id });
      return { ...mp.debitos.get(id) };
    },
    async suscripcion(id) {
      return { ...mp.debitos.get(id) };
    },
    async actualizarSuscripcion(id, cambios) {
      mp.llamadas.push(['actualizarSuscripcion', id, cambios]);
      const debito = mp.debitos.get(id);
      if (cambios.estado) debito.estado = cambios.estado;
      if (cambios.importe !== undefined) debito.importe = cambios.importe;
    },
    async cobrosDeSuscripcion(id) {
      return [...mp.cobros.values()].filter((c) => c.suscripcionId === id);
    },
    async cobroDeSuscripcion(id) {
      return mp.cobros.get(id);
    },
  };
  return mp;
}
const pagadas = async (empresaId) => (await servicio.detalle(empresaId)).facturas.filter((f) => f.estado === 'PAGADA');

test('pago con MercadoPago: se asienta una sola vez, llegue por el aviso, al volver o en la revisión', async () => {
  const mp = mercadoPagoFalso();
  const cobros = new CobrosPlataformaService(servicio, mp);
  const { empresa, playas } = await nuevaEmpresa('Paga con link', { diasPrueba: 0, alta: dia(-2) });
  await servicio.asignarPlan(empresa.id, playas[0].id, { planId: (await plan('CHICA')).id }, superUser.id);
  await servicio.revisarVencimientos();
  let cuenta = await servicio.resumen(empresa.id);
  assert.equal(cuenta.facturaPendiente.desde, dia(-2));

  // Con deuda el débito espera: primero se paga lo pendiente, así arranca en el próximo vencimiento.
  await assert.rejects(
    cobros.activarDebito(empresa.id, 'duenio@example.test', superUser.id),
    (e) => e.getResponse().code === 'PAGO_PENDIENTE',
  );

  assert.equal((await cobros.pagar(empresa.id)).url, 'https://mp.test/pagar');
  const referencia = `plan:${empresa.id}:${dia(-2)}`;
  const [, pedido] = mp.llamadas.find(([q]) => q === 'crearPago');
  assert.equal(pedido.referencia, referencia);
  assert.equal(pedido.importe, cuenta.facturaPendiente.importe);

  // Eligió pagar en efectivo en un local: MercadoPago lo informa pendiente y todavía no cuenta.
  mp.pagos.set('700', { id: '700', estado: 'pending', monto: cuenta.mensual, fecha: hoy, referencia });
  await cobros.procesarAviso('payment', '700');
  assert.ok((await servicio.resumen(empresa.id)).facturaPendiente);

  // Se aprueba: el aviso, la vuelta del cliente y la revisión periódica llegan a la vez.
  mp.pagos.set('701', { id: '701', estado: 'approved', monto: cuenta.mensual, fecha: hoy, referencia });
  await Promise.all([cobros.procesarAviso('payment', '701'), cobros.conciliar(empresa.id), cobros.conciliarTodas()]);
  const [pagada, ...otras] = await pagadas(empresa.id);
  assert.equal(otras.length, 0, 'un solo pago');
  assert.equal(pagada.id, cuenta.facturaPendiente.id, 'pagó la factura que veía en su panel');
  assert.equal(pagada.medio, 'MERCADOPAGO');
  assert.equal(pagada.referencia, '701');
  assert.equal(pagada.nota, 'Pago con MercadoPago');
  assert.equal(pagada.importe, cuenta.mensual);
  assert.equal(pagada.registradaPor, null, 'nadie lo cargó a mano');
  const asiento = (await servicio.detalle(empresa.id)).historial.find((h) => h.accion === 'SUSCRIPCION_PAGO');
  assert.equal(asiento.detalle.automatico, true);
  cuenta = await servicio.resumen(empresa.id);
  assert.equal(cuenta.estado, 'AL_DIA');
  assert.equal(cuenta.facturaPendiente, null);
  assert.equal((await cobros.conciliar(empresa.id)).acreditados, 0);

  // Un pago con una referencia que no es nuestra no toca ninguna cuenta.
  mp.pagos.set('702', { id: '702', estado: 'approved', monto: 1, fecha: hoy, referencia: 'pedido-12' });
  await cobros.procesarAviso('payment', '702');
  assert.equal((await pagadas(empresa.id)).length, 1);

  // Al día, el link sirve para adelantar el mes que viene.
  await cobros.pagar(empresa.id);
  const ultimo = mp.llamadas.filter(([q]) => q === 'crearPago').at(-1)[1];
  assert.equal(ultimo.referencia, `plan:${empresa.id}:${cuenta.proximoVencimiento}`);
});

test('débito automático: arranca en el próximo vencimiento, se asienta solo y estira la gracia a 10 días', async () => {
  const mp = mercadoPagoFalso();
  const cobros = new CobrosPlataformaService(servicio, mp);
  const { empresa, playas } = await nuevaEmpresa('Con débito');
  await assert.rejects(cobros.activarDebito(empresa.id, 'duenio@example.test', superUser.id), /plan elegido/);
  await servicio.asignarPlan(empresa.id, playas[0].id, { planId: (await plan('CHICA')).id }, superUser.id);
  const mensual = (await servicio.resumen(empresa.id)).mensual;

  const primero = await cobros.activarDebito(empresa.id, 'duenio@example.test', superUser.id);
  assert.equal(primero.url, 'https://mp.test/debito/deb-1');
  assert.deepEqual(
    mp.llamadas.find(([q]) => q === 'crearSuscripcion')[1],
    { referencia: `debito:${empresa.id}`, motivo: 'Plan del sistema de estacionamiento', email: 'duenio@example.test', importe: mensual, inicio: dia(7), tarjeta: undefined },
    'el primer cobro, el día después de la prueba',
  );
  let cuenta = await servicio.resumen(empresa.id);
  assert.deepEqual(cuenta.debito, { estado: 'pending', email: 'duenio@example.test', url: primero.url });
  assert.equal(cuenta.diasDeGracia, 5, 'mientras no lo confirme no cambia nada');

  // Lo reintenta con otro email: el que quedó a medio confirmar se cancela en MercadoPago.
  await cobros.activarDebito(empresa.id, 'otro@example.test', superUser.id);
  assert.deepEqual(mp.llamadas.find(([q]) => q === 'actualizarSuscripcion').slice(1), ['deb-1', { estado: 'cancelled' }]);

  // Lo confirma con su tarjeta. El aviso del cancelado llega después y no pisa nada.
  mp.debitos.get('deb-2').estado = 'authorized';
  await cobros.procesarAviso('subscription_preapproval', 'deb-2');
  await cobros.procesarAviso('subscription_preapproval', 'deb-1');
  cuenta = await servicio.resumen(empresa.id);
  assert.deepEqual(cuenta.debito, { estado: 'authorized', email: 'otro@example.test', url: null });
  assert.equal(cuenta.diasDeGracia, 10);
  assert.ok((await servicio.detalle(empresa.id)).historial.some((h) => h.accion === 'SUSCRIPCION_DEBITO' && h.detalle.estado === 'authorized'));
  await assert.rejects(cobros.activarDebito(empresa.id, 'otro@example.test', superUser.id), /Ya tenés/);

  // Terminó la prueba y la tarjeta todavía no pasó: con 7 días de atraso sigue operando.
  await fijar(empresa.id, { pruebaHasta: dia(-8) });
  await servicio.revisarVencimientos();
  assert.equal(await estadoEmpresa(empresa.id), 'ACTIVA');
  cuenta = await servicio.resumen(empresa.id);
  assert.equal(cuenta.diasDeAtraso, 7);
  assert.equal(cuenta.suspendeEl, dia(4));

  // Un intento rechazado no cuenta; el aprobado se asienta solo.
  mp.cobros.set('c-1', { id: 'c-1', suscripcionId: 'deb-2', pago: { id: '9001', estado: 'rejected', monto: mensual, fecha: hoy, referencia: null } });
  await cobros.procesarAviso('subscription_authorized_payment', 'c-1');
  assert.equal((await pagadas(empresa.id)).length, 0);
  mp.cobros.set('c-2', { id: 'c-2', suscripcionId: 'deb-2', pago: { id: '9002', estado: 'approved', monto: mensual, fecha: hoy, referencia: null } });
  await cobros.procesarAviso('subscription_authorized_payment', 'c-2');
  cuenta = await servicio.resumen(empresa.id);
  assert.equal(cuenta.estado, 'AL_DIA');
  const [pagada] = await pagadas(empresa.id);
  assert.equal(pagada.nota, 'Débito automático');
  assert.equal(pagada.referencia, '9002');
  assert.equal(pagada.desde, dia(-7), 'no estuvo cortada: el mes sigue desde su vencimiento');
  assert.equal((await cobros.conciliar(empresa.id)).acreditados, 0, 'la revisión no lo vuelve a asentar');

  // Cambia de plan: MercadoPago cobra lo nuevo desde el próximo débito.
  await servicio.asignarPlan(empresa.id, playas[0].id, { planId: (await plan('GRANDE')).id }, superUser.id);
  const nuevo = (await servicio.resumen(empresa.id)).mensual;
  assert.notEqual(nuevo, mensual);
  await cobros.sincronizarImporte(empresa.id);
  assert.equal(mp.debitos.get('deb-2').importe, nuevo);
  const llamadas = mp.llamadas.length;
  await cobros.sincronizarImporte(empresa.id);
  assert.equal(mp.llamadas.length, llamadas, 'si ya está igual no vuelve a llamar');

  // El aviso del mes siguiente no llegó (servidor caído): la revisión lo encuentra igual.
  mp.cobros.set('c-3', { id: 'c-3', suscripcionId: 'deb-2', pago: { id: '9003', estado: 'approved', monto: nuevo, fecha: hoy, referencia: null } });
  assert.equal((await cobros.conciliar(empresa.id)).acreditados, 1);
  assert.equal((await servicio.resumen(empresa.id)).pagadoHasta, reglas.sumarMeses(cuenta.pagadoHasta, 1));

  // Lo da de baja: se cancela en MercadoPago y vuelve la gracia de siempre.
  await cobros.desactivarDebito(empresa.id, superUser.id);
  assert.equal(mp.debitos.get('deb-2').estado, 'cancelled');
  cuenta = await servicio.resumen(empresa.id);
  assert.equal(cuenta.debito, null);
  assert.equal(cuenta.diasDeGracia, 5);
});

test('débito con la tarjeta en el panel: sin cuenta de MercadoPago, queda activo en el acto', async () => {
  const mp = mercadoPagoFalso();
  const cobros = new CobrosPlataformaService(servicio, mp);
  const { empresa, playas } = await nuevaEmpresa('Débito con tarjeta');
  await servicio.asignarPlan(empresa.id, playas[0].id, { planId: (await plan('MEDIANA')).id }, superUser.id);
  const r = await cobros.activarDebito(empresa.id, 'caja@example.test', superUser.id, 'tok1234567890abcdef');
  assert.deepEqual(r, { estado: 'authorized', url: null }, 'no hay que ir a MercadoPago');
  const [, pedido] = mp.llamadas.find(([q]) => q === 'crearSuscripcion');
  assert.equal(pedido.tarjeta, 'tok1234567890abcdef');
  assert.equal(pedido.inicio, dia(7), 'igual arranca en el próximo vencimiento');
  const cuenta = await servicio.resumen(empresa.id);
  assert.deepEqual(cuenta.debito, { estado: 'authorized', email: 'caja@example.test', url: null });
  assert.equal(cuenta.diasDeGracia, 10);
  assert.ok((await servicio.detalle(empresa.id)).historial.some((h) => h.accion === 'SUSCRIPCION_DEBITO' && h.detalle.estado === 'authorized'));
});

test('cliente de MercadoPago: firma de los avisos, pedidos a la API y errores sin mostrar el token', async () => {
  const { createHmac } = require('node:crypto');
  const env = { MERCADOPAGO_PLATAFORMA_ACCESS_TOKEN: 'APP_USR-token-de-prueba', PLATAFORMA_URL_FRONT: 'https://panel.example.test/' };
  const mp = new MercadoPagoPlataforma({ get: (k) => env[k] });
  assert.equal(mp.urlDeVuelta('pago'), 'https://panel.example.test/admin/plan/pagar?mp=pago');
  assert.equal(mp.clavePublica(), null, 'sin clave pública, el débito se confirma en MercadoPago');
  env.MERCADOPAGO_PLATAFORMA_PUBLIC_KEY = 'APP_USR-clave-publica';
  assert.equal(mp.clavePublica(), 'APP_USR-clave-publica');

  assert.equal(mp.firmaValida({ firma: undefined, requestId: 'r', dataId: '1' }), true, 'sin clave configurada no hay con qué validar');
  env.MERCADOPAGO_PLATAFORMA_WEBHOOK_SECRET = 'clave-del-webhook';
  const firmar = (id, req, ts) => `ts=${ts},v1=${createHmac('sha256', 'clave-del-webhook').update(`id:${id};request-id:${req};ts:${ts};`).digest('hex')}`;
  assert.equal(mp.firmaValida({ firma: firmar('123', 'req-1', '1700000000'), requestId: 'req-1', dataId: '123' }), true);
  assert.equal(mp.firmaValida({ firma: firmar('123', 'req-1', '1700000000'), requestId: 'req-2', dataId: '123' }), false);
  assert.equal(mp.firmaValida({ firma: firmar('124', 'req-1', '1700000000'), requestId: 'req-1', dataId: '123' }), false);
  assert.equal(mp.firmaValida({ firma: undefined, requestId: 'req-1', dataId: '123' }), false);
  assert.equal(mp.firmaValida({ firma: firmar('abc9', 'r', '1'), requestId: 'r', dataId: 'ABC9' }), true, 'los ids alfanuméricos se firman en minúscula');

  const pedidos = [];
  let respuesta;
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    pedidos.push({ url: String(url), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(respuesta.body), { status: respuesta.status });
  };
  try {
    respuesta = { status: 201, body: { id: 'pre-1', status: 'pending', init_point: 'https://mp.test/x', external_reference: 'debito:x', auto_recurring: { transaction_amount: 50000 } } };
    const debito = await mp.crearSuscripcion({ referencia: 'debito:x', motivo: 'Plan', email: 'a@example.test', importe: 50000, inicio: '2026-03-10' });
    assert.deepEqual(debito, { id: 'pre-1', estado: 'pending', referencia: 'debito:x', importe: 50000, url: 'https://mp.test/x' });
    const [p] = pedidos;
    assert.equal(p.url, 'https://api.mercadopago.com/preapproval');
    assert.equal(p.method, 'POST');
    assert.equal(p.headers.authorization, 'Bearer APP_USR-token-de-prueba');
    assert.equal(p.body.status, 'pending');
    assert.equal(p.body.payer_email, 'a@example.test');
    assert.equal(p.body.auto_recurring.start_date, '2026-03-10T12:00:00.000Z', 'a las 9 de la mañana de Argentina');
    assert.equal(p.body.back_url, 'https://panel.example.test/admin/plan/pagar?mp=debito');
    assert.equal(p.body.card_token_id, undefined);

    // Con la tarjeta del formulario: autorizada en el acto, con el token y nada más de la tarjeta.
    respuesta = { status: 201, body: { id: 'pre-2', status: 'authorized', external_reference: 'debito:x', auto_recurring: { transaction_amount: 50000 } } };
    const conTarjeta = await mp.crearSuscripcion({ referencia: 'debito:x', motivo: 'Plan', email: 'a@example.test', importe: 50000, inicio: '2026-03-10', tarjeta: 'tok123456789' });
    assert.equal(conTarjeta.estado, 'authorized');
    assert.equal(conTarjeta.url, null);
    assert.equal(pedidos.at(-1).body.card_token_id, 'tok123456789');
    assert.equal(pedidos.at(-1).body.status, 'authorized');
    respuesta = { status: 400, body: { message: 'CC_VAL_433 Credit card validation has failed' } };
    await assert.rejects(
      mp.crearSuscripcion({ referencia: 'debito:x', motivo: 'Plan', email: 'a@example.test', importe: 1, inicio: null, tarjeta: 'tok123456789' }),
      /no aceptó la tarjeta/,
    );

    respuesta = { status: 200, body: { results: [{ id: 55, status: 'approved', transaction_amount: 50000.4, date_approved: '2026-03-01T01:30:00.000-00:00', external_reference: 'plan:x:2026-02-28' }] } };
    assert.deepEqual(
      await mp.pagosConReferencia('plan:x:2026-02-28'),
      [{ id: '55', estado: 'approved', monto: 50000, fecha: '2026-02-28', referencia: 'plan:x:2026-02-28' }],
      'el día del pago es el de Argentina',
    );
    assert.equal(new URL(pedidos.at(-1).url).searchParams.get('external_reference'), 'plan:x:2026-02-28');

    respuesta = { status: 201, body: { id: 'pref-1', init_point: 'https://mp.test/pagar' } };
    await mp.crearPago({ referencia: 'plan:x:2026-03-01', titulo: 'Plan', importe: 50000, vence: new Date('2026-03-04T00:00:00Z') });
    assert.equal(pedidos.at(-1).body.notification_url, undefined, 'sin dirección pública, sin aviso');
    env.MERCADOPAGO_PLATAFORMA_WEBHOOK_URL = 'https://api.example.test/mercadopago/plataforma/aviso';
    await mp.crearPago({ referencia: 'plan:x:2026-03-01', titulo: 'Plan', importe: 50000, vence: new Date('2026-03-04T00:00:00Z') });
    assert.equal(pedidos.at(-1).body.notification_url, env.MERCADOPAGO_PLATAFORMA_WEBHOOK_URL);
    assert.equal(pedidos.at(-1).body.external_reference, 'plan:x:2026-03-01');
    assert.equal(pedidos.at(-1).body.auto_return, 'approved');

    respuesta = { status: 400, body: { message: 'payer_email invalid' } };
    await assert.rejects(mp.crearSuscripcion({ referencia: 'debito:x', motivo: 'Plan', email: 'a@example.test', importe: 1, inicio: null }), (e) => {
      assert.match(e.message, /MercadoPago no aceptó/);
      assert.doesNotMatch(JSON.stringify(e.getResponse()), /APP_USR|payer_email/);
      return true;
    });
    respuesta = { status: 503, body: {} };
    await assert.rejects(mp.pago('1'), /no está respondiendo/);
  } finally {
    globalThis.fetch = fetchOriginal;
  }

  delete env.MERCADOPAGO_PLATAFORMA_ACCESS_TOKEN;
  assert.equal(mp.configurado(), false);
  await assert.rejects(mp.pago('1'), /todavía no están configurados/);

  const id = '6f0c2a1e-0000-4000-8000-00000000abcd';
  assert.equal(empresaDeReferencia(`plan:${id.toUpperCase()}:2026-03-01`), id);
  assert.equal(empresaDeReferencia(`debito:${id}`), id);
  assert.equal(empresaDeReferencia(`plan:${id}x`), null);
  assert.equal(empresaDeReferencia('pedido-12'), null);
  assert.equal(empresaDeReferencia(null), null);
});
