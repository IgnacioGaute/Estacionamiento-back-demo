import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Plan } from './entities/plan.entity';
import { Suscripcion } from './entities/suscripcion.entity';
import { FacturaSaas } from './entities/factura-saas.entity';

// El plan que cada empresa contrata y lo que se le factura por usar el sistema. Es lo que le
// cobrás vos a la empresa, no lo que la playa le cobra a sus abonados (eso es `receipts`).
@Module({
  imports: [TypeOrmModule.forFeature([Plan, Suscripcion, FacturaSaas])],
  exports: [TypeOrmModule],
})
export class SaasModule {}
