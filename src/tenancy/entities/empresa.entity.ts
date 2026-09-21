import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Playa } from './playa.entity';

// varchar y no enum de Postgres: agregarle un estado nuevo a un enum PG obliga a crear el tipo
// de nuevo y swapear la columna, porque ALTER TYPE ... ADD VALUE no corre dentro de la
// transacción de una migración. Mismo criterio que TicketScheduleSettings.pricingDayTypeBasis.
export const EMPRESA_ESTADO = ['ACTIVA', 'SUSPENDIDA', 'BAJA'] as const;
export type EmpresaEstado = (typeof EMPRESA_ESTADO)[number];

// La empresa es el cliente que paga el plan y el límite de aislamiento: nada de una empresa
// tiene que ser visible desde otra.
@Entity({ name: 'empresas' })
export class Empresa {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('varchar', { length: 255 })
  nombre: string;

  @Column('varchar', { length: 20, default: 'ACTIVA' })
  estado: EmpresaEstado;

  @OneToMany(() => Playa, (playa) => playa.empresa)
  playas: Playa[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
