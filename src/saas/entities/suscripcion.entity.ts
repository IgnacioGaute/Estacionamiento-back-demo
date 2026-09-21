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
import { Empresa } from 'src/tenancy/entities/empresa.entity';
import { Plan } from './plan.entity';

export const SUSCRIPCION_ESTADO = ['ACTIVA', 'VENCIDA', 'CANCELADA'] as const;
export type SuscripcionEstado = (typeof SUSCRIPCION_ESTADO)[number];

// Qué plan tiene contratado cada empresa y hasta cuándo. De acá sale la suspensión por falta
// de pago. Se guarda el historial: una empresa puede tener varias suscripciones a lo largo del
// tiempo, y la vigente es la que tiene estado ACTIVA.
@Entity({ name: 'suscripciones' })
export class Suscripcion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  empresaId: string;

  @ManyToOne(() => Empresa, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'empresaId' })
  empresa: Empresa;

  @Column('uuid')
  planId: string;

  @ManyToOne(() => Plan)
  @JoinColumn({ name: 'planId' })
  plan: Plan;

  @Column('varchar', { length: 20, default: 'ACTIVA' })
  estado: SuscripcionEstado;

  @Column('date')
  inicio: string;

  @Column('date', { nullable: true })
  fin: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
