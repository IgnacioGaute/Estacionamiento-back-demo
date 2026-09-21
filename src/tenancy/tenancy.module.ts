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

// Empresas, playas y el acceso de cada usuario a cada playa. Se exporta TypeOrmModule para que
// los guards y servicios de otros módulos puedan resolver el contexto de playa sin duplicar el
// registro de los repositorios.
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Empresa, Playa, UsuarioPlaya, AuditLog, User])],
  controllers: [TenancyController, TenantContextController],
  providers: [TenancyService, TenantAccessService, TenantSocketAccess],
  exports: [TypeOrmModule, TenancyService, TenantAccessService, TenantSocketAccess],
})
export class TenancyModule {}
