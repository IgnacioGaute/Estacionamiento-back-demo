import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from 'src/users/entities/user.entity';

export const TURNO_ESTADO = ['ABIERTO', 'CERRADO'] as const;
export type TurnoEstado = (typeof TURNO_ESTADO)[number];

// Un turno es por usuario, no una caja única del sistema — puede haber varios turnos
// ABIERTO al mismo tiempo, uno por cada operador registrando en simultáneo. Un mismo
// usuario no puede tener dos turnos ABIERTO a la vez (ver TurnosService.open).
@Entity({ name: 'turnos' })
export class Turno {
  @PrimaryGeneratedColumn('uuid')
  id: string;

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
