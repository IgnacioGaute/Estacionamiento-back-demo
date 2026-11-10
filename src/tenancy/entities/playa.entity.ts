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
import { Empresa } from './empresa.entity';
import type { Modalidad } from '../modalidad';
import type { ConfiguracionInicial } from '../configuracion-inicial';

export type ModulosPlaya = { inquilinos?: boolean };

// La playa es el scope operativo: todo lo que pasa en el mostrador (tickets, caja, turnos,
// cocheras) cuelga de acá. Una empresa tiene una o dos.
@Entity({ name: 'playas' })
export class Playa {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  empresaId: string;

  @ManyToOne(() => Empresa, (empresa) => empresa.playas, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'empresaId' })
  empresa: Empresa;

  @Column('varchar', { length: 255 })
  nombre: string;

  @Column('varchar', { length: 255, nullable: true })
  direccion: string | null;

  // Cuántos vehículos entran a la vez. Con esto el super admin ve la ocupación; sin cargar, solo
  // los vehículos adentro.
  @Column('int', { nullable: true })
  capacidad: number | null;

  // Secciones opcionales que el super admin prende por playa. Ausente = apagada.
  @Column('jsonb', { default: () => "'{}'::jsonb" })
  modulos: ModulosPlaya;

  // Con cobro o gratuito (ver src/tenancy/modalidad.ts). Solo la cambia el super admin con
  // TenancyService.cambiarModalidad, que valida pendientes; nunca por updatePlaya.
  @Column('varchar', { length: 20, default: 'CON_COBRO' })
  modalidad: Modalidad;

  // El avance del recorrido de configuración de una playa nueva (ver configuracion-inicial.ts).
  // Sin `terminadaEn`, a su administrador se le muestran los pasos antes de entrar.
  @Column('jsonb', { default: () => "'{}'::jsonb" })
  configuracionInicial: ConfiguracionInicial;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
