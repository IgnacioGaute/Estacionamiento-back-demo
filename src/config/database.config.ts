import { TenantIsolation1790000001000 } from '../database/migrations/1790000001000-tenant-isolation';
import { ParkingReceipts1790000004000 } from '../database/migrations/1790000004000-parking-receipts';
import { RegistrationPhone1790000005000 } from '../database/migrations/1790000005000-registration-phone';
import { AuditDetalle1790000007000 } from '../database/migrations/1790000007000-audit-detalle';
import { AuditPermisos1790000008000 } from '../database/migrations/1790000008000-audit-permisos';
import { MercadoPagoCuentas1790000009000 } from '../database/migrations/1790000009000-mercadopago-cuentas';
import { CobrosMercadoPago1790000011000 } from '../database/migrations/1790000011000-cobros-mercadopago';
import { CobrosAbonos1790000012000 } from '../database/migrations/1790000012000-cobros-abonos';
import { OfflineSessions1790000010000 } from '../database/migrations/1790000010000-offline-sessions';
import { OperationSettings1790000006000 } from '../database/migrations/1790000006000-operation-settings';
import { AuthVersion1790000002000 } from '../database/migrations/1790000002000-auth-version';
import { registerAs } from '@nestjs/config';
import { NoteReaders1790000003000 } from '../database/migrations/1790000003000-note-readers';
import { FlexibleVehicleTypes1790000000000 } from '../database/migrations/1790000000000-flexible-vehicle-types';
import { type TypeOrmModuleOptions } from '@nestjs/typeorm';

/**
 * Arranque sobre una base vacía.
 *
 * Todas las migraciones de este repo son de actualización: hacen ALTER sobre
 * tablas que asumen existentes, porque el esquema original lo creó `synchronize`
 * cuando el proyecto arrancó. En una base nueva —un Postgres recién creado en
 * Railway, por ejemplo— no hay ninguna tabla, así que la primera migración
 * revienta con «relation "customers" does not exist» y la app no levanta.
 *
 * Con DB_BOOTSTRAP=true el primer arranque crea el esquema desde las entidades y
 * NO corre migraciones. Después se saca la variable y el arranque siguiente
 * aplica las migraciones sobre lo ya creado: todas usan IF NOT EXISTS, así que
 * las columnas que `synchronize` ya puso no molestan, y lo que `synchronize` no
 * sabe hacer (RLS, triggers, el rol parking_scoped) queda aplicado ahí.
 *
 * Es para el primer arranque y nada más: dejarlo prendido significa que el
 * esquema de producción lo maneja `synchronize`, que borra columnas cuando se
 * borra una propiedad de una entidad.
 */
const bootstrap = process.env.DB_BOOTSTRAP === 'true';

export default registerAs(
  'database',
  () =>
    ({
      type: 'postgres',
      host: process.env.POSTGRES_HOST || '',
      port: parseInt(process.env.POSTGRES_PORT as string, 10) || 5430,
      database: process.env.POSTGRES_NAME || '',
      username: process.env.POSTGRES_USER || '',
      password: process.env.POSTGRES_PASSWORD || '',
      entities: [`${__dirname}/../**/*.entity{.ts,.js}`],
      // RLS and tenant constraints are managed by migrations; synchronize only
      // runs on the very first boot of an empty database (see DB_BOOTSTRAP above).
      synchronize: bootstrap,
      logging: false,
      migrations: [OfflineSessions1790000010000, FlexibleVehicleTypes1790000000000, TenantIsolation1790000001000, AuthVersion1790000002000, NoteReaders1790000003000, ParkingReceipts1790000004000, RegistrationPhone1790000005000, OperationSettings1790000006000, AuditDetalle1790000007000, AuditPermisos1790000008000, MercadoPagoCuentas1790000009000, CobrosMercadoPago1790000011000, CobrosAbonos1790000012000],
      migrationsRun: !bootstrap,
      migrationsTableName: 'migrations',
    }) as TypeOrmModuleOptions,
);
