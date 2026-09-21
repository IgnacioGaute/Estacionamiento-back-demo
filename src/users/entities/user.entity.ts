import { Note } from 'src/notes/entities/note.entity';
import { Empresa } from 'src/tenancy/entities/empresa.entity';
import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

// SUPER_ADMIN es el dueño de la plataforma, no de una empresa: administra empresas, playas y
// usuarios, y es el único rol que vive con empresaId en null. ADMIN pasa a significar
// administrador DE una empresa, y USER es el operador.
export const USER_ROLES = ['USER', 'ADMIN', 'SUPER_ADMIN'] as const;
export type UserRole = (typeof USER_ROLES)[number];

@Entity({ name: 'users' })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // El usuario pertenece a una empresa; a qué playas entra lo define usuario_playas.
  // email y username siguen siendo únicos GLOBALMENTE, no por empresa: así lo fija el modelo
  // aprobado, y evita que la misma persona use el mismo mail en dos empresas distintas.
  @Index()
  @Column('uuid', { nullable: true })
  empresaId: string | null;

  @ManyToOne(() => Empresa, { nullable: true })
  @JoinColumn({ name: 'empresaId' })
  empresa: Empresa | null;

  @Column('varchar', { length: 255 })
  @Index({ unique: true })
  username: string;

  @Column('varchar', { length: 255 })
  firstName: string;

  @Column('varchar', { length: 255 })
  lastName: string;

  @Column('varchar', { length: 255, unique: true })
  @Index({ unique: true })
  email: string;

  @Column('varchar', { length: 255, nullable: true, select: false })
  password: string | null;

  @Column('int', { default: 0 })
  authVersion: number;

  @Column('enum', { enum: USER_ROLES, default: USER_ROLES[0] })
  role: UserRole;

  @OneToMany(() => Note, (notes) => notes.user, { cascade: true })
  notes: Note[]

  @DeleteDateColumn()
  deletedAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

