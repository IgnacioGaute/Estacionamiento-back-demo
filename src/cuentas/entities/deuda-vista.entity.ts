import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Playa } from 'src/tenancy/entities/playa.entity';
import { Customer } from 'src/customers/entities/customer.entity';

// Una deuda de inquilino que una persona ya vio en Avisos → Inquilinos (ver la migración
// 1790000056000). Vuelve a ser nueva si cambia vencidoDesde (otro atraso) o el tramo (30/60 días).
@Entity({ name: 'deudas_vistas' })
@Index('deudas_vistas_unica', ['usuarioId', 'customerId', 'vencidoDesde', 'tramo'], { unique: true })
export class DeudaVista {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index('deudas_vistas_playa') @Column('uuid', { nullable: true }) playaId: string | null;
  @ManyToOne(() => Playa, { nullable: true }) @JoinColumn({ name: 'playaId' }) playa: Playa | null;
  // Sin relación: el super admin no es visible desde la empresa.
  @Column('uuid') usuarioId: string;
  @Column('uuid') customerId: string;
  @ManyToOne(() => Customer, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'customerId' }) customer: Customer;
  @Column('date') vencidoDesde: string;
  @Column('varchar', { length: 20 }) tramo: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
