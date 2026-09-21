// Run after building: node --env-file=.env scripts/assign-legacy-tenant.cjs <empresaId> <playaId>
// Explicit destination, backup first, transaction, only unassigned rows. Safe to rerun.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
require('reflect-metadata');
const { DataSource } = require('typeorm');
const { TenantIsolation1790000001000, PLAYA_TABLES } = require('../dist/database/migrations/1790000001000-tenant-isolation');
const [empresaId, playaId] = process.argv.slice(2);
if (![empresaId, playaId].every(id => /^[0-9a-f-]{36}$/i.test(id || ''))) throw Error('Pass explicit empresaId and playaId');
const e = process.env;
const ds = new DataSource({ type:'postgres', host:e.POSTGRES_HOST, port:Number(e.POSTGRES_PORT)||5430, username:e.POSTGRES_USER, password:e.POSTGRES_PASSWORD, database:e.POSTGRES_NAME, synchronize:false });
(async () => {
 await ds.initialize();
 try {
  const [target] = await ds.query('SELECT p.nombre AS playa,e.nombre AS empresa FROM playas p JOIN empresas e ON e.id=p."empresaId" WHERE p.id=$1 AND e.id=$2',[playaId,empresaId]);
  if (!target) throw Error('Destination company and parking lot do not match');
  const backupDir=path.join(os.homedir(),'.codex','backups'); fs.mkdirSync(backupDir,{recursive:true});
  const backup=path.join(backupDir,'parking-before-tenant-'+new Date().toISOString().replace(/[:.]/g,'-')+'.dump');
  execFileSync(path.join(e.PG_TEST_BIN || 'C:/Program Files/PostgreSQL/18/bin','pg_dump.exe'),['-Fc','-f',backup], { windowsHide:true, env:{...e,PGHOST:e.POSTGRES_HOST,PGPORT:e.POSTGRES_PORT||'5430',PGUSER:e.POSTGRES_USER,PGPASSWORD:e.POSTGRES_PASSWORD,PGDATABASE:e.POSTGRES_NAME},stdio:['ignore','pipe','pipe'] });
  console.log(JSON.stringify({backup,bytes:fs.statSync(backup).size,target}));
  const runner=ds.createQueryRunner(); await runner.connect(); await runner.startTransaction();
  try {
   await new TenantIsolation1790000001000().up(runner);
   const counts={};
   for(const table of PLAYA_TABLES) {
    const result=await runner.query('UPDATE "'+table+'" SET "playaId"=$1 WHERE "playaId" IS NULL RETURNING 1',[playaId]);
    counts[table]=Array.isArray(result[0]) ? result[1] : result.length;
   }
   await runner.query('UPDATE users SET "empresaId"=$1 WHERE "empresaId" IS NULL AND role <> $2',[empresaId,'SUPER_ADMIN']);
   await runner.query(`INSERT INTO usuario_playas ("usuarioId","playaId","rolPlaya") SELECT id,$1,CASE WHEN role='ADMIN' THEN 'ENCARGADO' ELSE 'OPERADOR' END FROM users WHERE "empresaId"=$2 AND "deletedAt" IS NULL AND role <> 'SUPER_ADMIN' ON CONFLICT DO NOTHING`,[playaId,empresaId]);
   // Every lot starts with its own editable catalogue, never another company's rates.
   await runner.query(`INSERT INTO ticket_vehicle_types ("playaId",code,name,enabled) SELECT p.id,v.code,v.name,true FROM playas p CROSS JOIN (VALUES ('AUTO','Auto'),('CAMIONETA','Camioneta')) v(code,name) WHERE NOT EXISTS (SELECT 1 FROM ticket_vehicle_types t WHERE t."playaId"=p.id AND t.code=v.code)`);
   await runner.commitTransaction(); console.log(JSON.stringify({assigned:counts}));
  } catch(error) { await runner.rollbackTransaction(); throw error; }
  finally { await runner.release(); }
 } finally { await ds.destroy(); }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
