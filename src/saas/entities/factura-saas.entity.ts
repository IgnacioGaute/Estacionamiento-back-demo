import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Suscripcion } from './suscripcion.entity';

export const FACTURA_SAAS_ESTADO = ['PENDIENTE', 'PAGADA', 'VENCIDA'] as const;
export type FacturaSaasEstado = (typeof FACTURA_SAAS_ESTADO)[number];

const aNumero = {
  to: (valor: number) => valor,
  from: (valor: string | null) => (valor === null ? null : Number(valor)),
};

// Lo que vos le cobrás a la empresa por usar el sistema. Nombre aparte a propósito: `receipts`
// ya significa el recibo que la playa le cobra a su abonado, que es lo contrario.
@Entity({ name: 'facturas_saas' })
export class FacturaSaas {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  suscripcionId: string;

  @ManyToOne(() => Suscripcion, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'suscripcionId' })
  suscripcion: Suscripcion;

  // "YYYY-MM": el período que cubre la factura, no la fecha de emisión.
  @Column('varchar', { length: 7 })
  periodo: string;

  @Column('numeric', { precision: 12, scale: 2, transformer: aNumero })
  importe: number;

  @Column('varchar', { length: 20, default: 'PENDIENTE' })
  estado: FacturaSaasEstado;

  // Id del cobro en la pasarela de pago, cuando haya una. Texto libre a propósito.
  @Column('varchar', { length: 255, nullable: true })
  referenciaProveedor: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
