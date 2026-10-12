import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Playa } from 'src/tenancy/entities/playa.entity';
import { User } from 'src/users/entities/user.entity';

@Entity({ name: 'notes' })
export class Note {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid', { array: true, default: () => "'{}'", select: false })
  readBy: string[];

  @Index()
  @Column('uuid', { nullable: true })
  playaId: string | null;

  @ManyToOne(() => Playa, { nullable: true })
  @JoinColumn({ name: 'playaId' })
  playa: Playa | null;
  
  @Column('text')
  description: string;

  @Index('IDX_notes_sourceKey', { unique: true })
  @Column('varchar', { length: 255, nullable: true })
  sourceKey: string | null;

  @Column('varchar', { length: 120, nullable: true })
  origin: string | null;

  @Column('varchar', { length: 32, nullable: true })
  sourceType: string | null;

  @Column('uuid', { nullable: true })
  sourceId: string | null;

  @Column('text', { nullable: true })
  context: string | null;

  @Column('date', { nullable: true })
  date: string | null;
  
  @Column('time', { nullable: true })
  hours: string | null;
  
  @ManyToOne(() => User, (user) => user.notes, {onDelete: 'CASCADE'})
  user: User;

  @CreateDateColumn()
  createdAt: Date;

}
