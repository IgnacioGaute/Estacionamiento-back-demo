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

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
