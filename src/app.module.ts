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
  PlateRecognitionModule
],
  controllers: [],
  providers: [],
})
export class AppModule {}
