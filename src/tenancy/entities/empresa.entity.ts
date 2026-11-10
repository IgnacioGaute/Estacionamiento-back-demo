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

// Condición frente al IVA, como la pide una factura argentina.
export const CONDICIONES_IVA = ['RESPONSABLE_INSCRIPTO', 'MONOTRIBUTO', 'EXENTO', 'CONSUMIDOR_FINAL'] as const;
export type CondicionIva = (typeof CONDICIONES_IVA)[number];

// La empresa es el cliente que paga el plan y el límite de aislamiento: nada de una empresa
// tiene que ser visible desde otra.
@Entity({ name: 'empresas' })
export class Empresa {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('varchar', { length: 255 })
  nombre: string;

  @Column('numeric', { precision: 5, scale: 2, default: 0 })
  comisionQrPorcentaje: number;

  @Column('numeric', { precision: 5, scale: 2, default: 0 })
  comisionTransferenciaPorcentaje: number;

  @Column('jsonb', { nullable: true })
  comisionesMp: import('src/box-lists/comisiones').ComisionesCaja | null;

  @Column('varchar', { length: 20, default: 'ACTIVA' })
  estado: EmpresaEstado;

  // Datos para cobrarle y contactarla (migración 1790000048000). Opcionales: las empresas de
  // antes no los tienen y la ficha los muestra «sin cargar».
  @Column('varchar', { length: 255, nullable: true })
  razonSocial: string | null;

  // Solo los 11 números; se muestra con guiones.
  @Column('varchar', { length: 11, nullable: true })
  cuit: string | null;

  @Column('varchar', { length: 30, nullable: true })
  condicionIva: CondicionIva | null;

  @Column('varchar', { length: 255, nullable: true })
  contactoNombre: string | null;

  @Column('varchar', { length: 255, nullable: true })
  contactoEmail: string | null;

  // Se usa para escribirle por WhatsApp.
  @Column('varchar', { length: 30, nullable: true })
  contactoTelefono: string | null;

  @Column('varchar', { length: 120, nullable: true })
  ciudad: string | null;

  @Column('varchar', { length: 60, nullable: true })
  provincia: string | null;

  @OneToMany(() => Playa, (playa) => playa.empresa)
  playas: Playa[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
