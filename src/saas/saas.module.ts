import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Plan } from './entities/plan.entity';
import { Suscripcion } from './entities/suscripcion.entity';
import { FacturaSaas } from './entities/factura-saas.entity';
import { PlanDePlaya } from './entities/plan-de-playa.entity';
import { User } from 'src/users/entities/user.entity';
import { SuscripcionesService } from './suscripciones.service';
import { SuscripcionesController } from './suscripciones.controller';
import { MiPlanController } from './mi-plan.controller';
import { SuscripcionesScheduler } from './suscripciones.scheduler';
import { MercadoPagoPlataforma } from './mercadopago-plataforma';
import { CobrosPlataformaService } from './cobros-plataforma.service';
import { AvisoMercadoPagoController } from './aviso-mercadopago.controller';

// El plan que cada empresa contrata y lo que se le factura por usar el sistema. Es lo que le
// cobrás vos a la empresa, no lo que la playa le cobra a sus abonados (eso es `receipts`).
//
// No depende de TenancyModule: es al revés, el contexto de cada pedido y la ficha de la empresa
// leen de acá el estado de la cuenta. User está para el SuperAdminGuard. El MercadoPago de acá es
// el de la plataforma, no el de `src/mercadopago` (que cobra en nombre de cada empresa).
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Plan,
      Suscripcion,
      FacturaSaas,
      PlanDePlaya,
      User,
    ]),
  ],
  controllers: [
    SuscripcionesController,
    MiPlanController,
    AvisoMercadoPagoController,
  ],
  providers: [
    SuscripcionesService,
    SuscripcionesScheduler,
    MercadoPagoPlataforma,
    CobrosPlataformaService,
  ],
  exports: [TypeOrmModule, SuscripcionesService, CobrosPlataformaService],
})
export class SaasModule {}
