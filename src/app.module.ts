import { DataSource } from 'typeorm';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { installTenantConnections } from './tenancy/tenant-context';
import { TenantGuard, TenantInterceptor } from './tenancy/tenant-access';
import { AuditInterceptor } from './tenancy/audit-interceptor';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AppConfig, DatabaseConfig } from './config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReceiptsModule } from './receipts/receipts.module';
import { ScannerModule } from './scanner/scanner.module';
import { TicketsModule } from './tickets/tickets.module';
import { BoxListsModule } from './box-lists/box-lists.module';
import { CustomersModule } from './customers/customers.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { ScheduleModule } from '@nestjs/schedule';
import { NotesModule } from './notes/notes.module';
import { ParkingModule } from './parking/parking.module';
import { TurnosModule } from './turnos/turnos.module';
import { MovimientosModule } from './movimientos/movimientos.module';
import { PlateRecognitionModule } from './plate-recognition/plate-recognition.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { SaasModule } from './saas/saas.module';
import { AssistantModule } from './assistant/assistant.module';

@Module({
  imports: [ConfigModule.forRoot({
    isGlobal: true,
    cache: true,
    load: [AppConfig, DatabaseConfig],
  }),
  TypeOrmModule.forRootAsync({
    imports: [ConfigModule],
    useFactory: (configService: ConfigService) => ({
      ...configService.get('database'),
    }),
    inject: [ConfigService],
    dataSourceFactory: async (options) => {
      const ds = await new DataSource(options).initialize();
      installTenantConnections(ds);
      return ds;
    },
  }),
  ScheduleModule.forRoot(),
  ReceiptsModule,
  ScannerModule,
  TicketsModule,
  BoxListsModule,
  CustomersModule,
  UsersModule,
  AuthModule,
  NotesModule,
  ParkingModule,
  TurnosModule,
  MovimientosModule,
  PlateRecognitionModule,
  TenancyModule,
  SaasModule,
  AssistantModule
],
  controllers: [],
  providers: [
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
    // Después del de tenant: necesita el scope de empresa y playa ya resuelto.
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
