import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from 'src/users/entities/user.entity';
import { Playa } from './playa.entity';

export const ROL_PLAYA = ['ENCARGADO', 'OPERADOR'] as const;
export type RolPlaya = (typeof ROL_PLAYA)[number];

// A qué playas entra cada usuario. El operador suele tener una; el dueño, las dos. La PK
// compuesta es la que garantiza que no haya asignaciones repetidas.
//
// La regla "usuario y playa tienen que ser de la misma empresa" se valida en el servicio: para
// garantizarla en la base haría falta una FK compuesta, y synchronize borra ese tipo de
// restricción en cada arranque (ver la etapa 3 del plan).
@Entity({ name: 'usuario_playas' })
export class UsuarioPlaya {
  @PrimaryColumn('uuid')
  usuarioId: string;

  @PrimaryColumn('uuid')
  playaId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'usuarioId' })
  usuario: User;

  @Index()
  @ManyToOne(() => Playa, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'playaId' })
  playa: Playa;

  @Column('varchar', { length: 20, default: 'OPERADOR' })
  rolPlaya: RolPlaya;

  @CreateDateColumn()
  createdAt: Date;
}
