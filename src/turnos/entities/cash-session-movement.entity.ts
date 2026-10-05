import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Playa } from 'src/tenancy/entities/playa.entity';
import { CashSession } from './cash-session.entity';
import { User } from 'src/users/entities/user.entity';

@Entity({ name: 'cash_session_movements' })
export class CashSessionMovement {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column('uuid', { nullable: true }) playaId: string | null;
  @ManyToOne(() => Playa, { nullable: true }) @JoinColumn({ name: 'playaId' }) playa: Playa | null;
  @Column('uuid') sesionId: string;
  @ManyToOne(() => CashSession) @JoinColumn({ name: 'sesionId' }) sesion: CashSession;
  @Column('uuid') usuarioId: string;
  @ManyToOne(() => User) @JoinColumn({ name: 'usuarioId' }) usuario: User;
  @Column('int') amount: number;
  @Column('varchar') tipo: 'APORTE' | 'RETIRO';
  @Column('varchar', { length: 255 }) motivo: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
