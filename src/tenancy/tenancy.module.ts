import { TenantSocketAccess } from './tenant-socket';
import { TenantAccessService, TenantContextController } from './tenant-access';
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Empresa } from './entities/empresa.entity';
import { Playa } from './entities/playa.entity';
import { UsuarioPlaya } from './entities/usuario-playa.entity';
import { AuditLog } from './entities/audit-log.entity';
import { User } from 'src/users/entities/user.entity';
import { TenancyService } from './tenancy.service';
import { TenancyController } from './tenancy.controller';
import { SaasModule } from 'src/saas/saas.module';
import { PlateRecognizerCuentasModule } from 'src/plate-recognition/plate-recognizer-cuentas.module';

// Empresas, playas y el acceso de cada usuario a cada playa. Se exporta TypeOrmModule para que
// los guards y servicios de otros módulos puedan resolver el contexto de playa sin duplicar el
// registro de los repositorios.
@Global()
@Module({
  // SaasModule: la ficha, el contexto y el alta de empresas leen y escriben la cuenta de cada
  // empresa con la plataforma. PlateRecognizerCuentasModule: la ficha carga el token de
  // reconocimiento de patentes de cada playa y muestra su consumo.
  imports: [
    TypeOrmModule.forFeature([Empresa, Playa, UsuarioPlaya, AuditLog, User]),
    SaasModule,
    PlateRecognizerCuentasModule,
  ],
  controllers: [TenancyController, TenantContextController],
  providers: [TenancyService, TenantAccessService, TenantSocketAccess],
  exports: [TypeOrmModule, TenancyService, TenantAccessService, TenantSocketAccess],
})
export class TenancyModule {}
