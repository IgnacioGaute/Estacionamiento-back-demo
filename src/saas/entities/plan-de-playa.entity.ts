import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Playa } from 'src/tenancy/entities/playa.entity';
import { Plan } from './plan.entity';

// El plan de cada playa. El tamaño y las cocheras son de la playa, pero paga la empresa: lo que
// se le factura por mes es la suma de sus playas.
@Entity({ name: 'suscripcion_playas' })
export class PlanDePlaya {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Redundante con la playa, a propósito: la política de RLS filtra por empresa sin un JOIN.
  @Index()
  @Column('uuid')
  empresaId: string;

  @Index({ unique: true })
  @Column('uuid')
  playaId: string;

  @ManyToOne(() => Playa, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'playaId' })
  playa: Playa;

  @Column('uuid')
  planId: string;

  @ManyToOne(() => Plan)
  @JoinColumn({ name: 'planId' })
  plan: Plan;

  // Precio pactado, en pesos enteros. Arranca en el de lista y puede llevar un descuento; subir
  // la lista no lo toca.
  @Column('int')
  precio: number;

  // Desde cuándo tiene este plan.
  @Column('date')
  desde: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
