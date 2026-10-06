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

// Los adicionales que existen: funciones que la plataforma habilita por empresa, aparte del plan.
export const ADICIONALES = ['VERIFICACION_ALIAS'] as const;
export type CodigoAdicional = (typeof ADICIONALES)[number];

// Lo que la plataforma le habilita a una empresa por fuera del plan, con su precio pactado. Lo
// escribe solo el super admin; la empresa lo lee para saber si lo tiene.
//
// El precio queda guardado pero todavía NO entra en facturas ni débitos: cómo y desde cuándo se
// cobra se decide antes de sumarlo (ver docs/verificacion-transferencias.md).
@Entity({ name: 'empresa_adicionales' })
@Index('empresa_adicionales_codigo', ['empresaId', 'codigo'], { unique: true })
export class EmpresaAdicional {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  empresaId: string;

  @ManyToOne(() => Empresa, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'empresaId' })
  empresa?: Empresa;

  @Column('varchar', { length: 40 })
  codigo: CodigoAdicional;

  @Column('boolean', { default: false })
  habilitado: boolean;

  // Por mes, en pesos enteros.
  @Column('int', { default: 0 })
  precioMensual: number;

  @Column('uuid', { nullable: true })
  cambiadoPor: string | null;

  @Column('timestamptz', { nullable: true })
  habilitadoEl: Date | null;

  @Column('timestamptz', { nullable: true })
  deshabilitadoEl: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
