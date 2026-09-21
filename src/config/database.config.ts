import { TenantIsolation1790000001000 } from '../database/migrations/1790000001000-tenant-isolation';
import { AuthVersion1790000002000 } from '../database/migrations/1790000002000-auth-version';
import { registerAs } from '@nestjs/config';
import { NoteReaders1790000003000 } from '../database/migrations/1790000003000-note-readers';
import { FlexibleVehicleTypes1790000000000 } from '../database/migrations/1790000000000-flexible-vehicle-types';
import { type TypeOrmModuleOptions } from '@nestjs/typeorm';

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
      synchronize: false, // RLS and tenant constraints are managed by migrations.
      logging: false,
      migrations: [FlexibleVehicleTypes1790000000000, TenantIsolation1790000001000, AuthVersion1790000002000, NoteReaders1790000003000],
      migrationsRun: true,
      migrationsTableName: 'migrations',
    }) as TypeOrmModuleOptions,
);
