import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Playa } from 'src/tenancy/entities/playa.entity';
import { User } from 'src/users/entities/user.entity';

export const TURNO_ESTADO = ['ABIERTO', 'CERRADO'] as const;
export type TurnoEstado = (typeof TURNO_ESTADO)[number];

// Los turnos nuevos representan relevos sucesivos de una caja compartida.
// cashVersion=1 conserva el cálculo de los turnos anteriores.
@Entity({ name: 'turnos' })
export class Turno {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid', { nullable: true })
  playaId: string | null;

  @ManyToOne(() => Playa, { nullable: true })
  @JoinColumn({ name: 'playaId' })
  playa: Playa | null;

  @Column('int', { default: 1 }) cashVersion: number;
  @Column('varchar', { default: 'Turno' }) nombre: string;
  @Column('int', { nullable: true }) duracionPrevistaHoras: number | null;
  @Index({ unique: true }) @Column('uuid', { nullable: true }) turnoAnteriorId: string | null;
  @Column('int', { default: 0 }) fondoRecibido: number;
  @Column('int', { nullable: true }) efectivoRetirado: number | null;
  @Column('int', { nullable: true }) efectivoParaSiguiente: number | null;
  @Column('uuid', { nullable: true }) recibidoPorTurnoId: string | null;

  @ManyToOne(() => User)
  @JoinColumn()
  usuarioApertura: User;

  @CreateDateColumn()
  fechaApertura: Date;

  @Column('int')
  fondoInicial: number;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn()
  usuarioCierre: User | null;

  @Column('timestamptz', { nullable: true })
  fechaCierre: Date | null;

  @Column('int', { nullable: true })
  efectivoContado: number | null;

  // Cierre hecho por un admin sobre el turno de otro operador (se fue sin cerrar, se enfermó).
  // Sin esto la caja quedaba trabada: nadie más podía cerrar ese turno ni abrir el siguiente.
  // El arqueo no se autocompleta — el admin cuenta los billetes igual, si no se perdería el
  // faltante, que es justo lo único que la caja sirve para detectar.
  @Column('boolean', { default: false })
  cierreForzado: boolean;

  @Column('varchar', { length: 255, nullable: true })
  motivoCierreForzado: string | null;

  // Congelados al cerrar el turno — nunca se recalculan después. Un error encontrado más
  // tarde se corrige con un Movimiento de tipo AJUSTE, no editando estos valores.
  @Column('int', { nullable: true })
  efectivoTeorico: number | null;

  @Column('int', { nullable: true })
  diferencia: number | null;

  @Column('text', { nullable: true })
  observaciones: string | null;

  @Column('enum', { enum: TURNO_ESTADO, default: 'ABIERTO' })
  estado: TurnoEstado;
}
