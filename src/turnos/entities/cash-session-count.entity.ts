import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Playa } from 'src/tenancy/entities/playa.entity';
import { CashSession } from './cash-session.entity';
import { Turno } from './turno.entity';
import { User } from 'src/users/entities/user.entity';

// Un conteo de relevo en una caja compartida: quien se suma o quien se va cuenta el cajón. No
// mueve dinero ni cambia el saldo; deja escrito cuánto había en cada cambio de manos, así un
// faltante se ubica en el tramo en que apareció (antes solo contaba el último, al cerrar).
@Entity({ name: 'cash_session_counts' })
export class CashSessionCount {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column('uuid', { nullable: true }) playaId: string | null;
  @ManyToOne(() => Playa, { nullable: true }) @JoinColumn({ name: 'playaId' }) playa: Playa | null;
  @Index() @Column('uuid') sesionId: string;
  @ManyToOne(() => CashSession) @JoinColumn({ name: 'sesionId' }) sesion: CashSession;
  @Column('uuid', { nullable: true }) turnoId: string | null;
  @ManyToOne(() => Turno, { nullable: true }) @JoinColumn({ name: 'turnoId' }) turno: Turno | null;
  @Column('uuid') usuarioId: string;
  @ManyToOne(() => User) @JoinColumn({ name: 'usuarioId' }) usuario: User;
  // INGRESO: se suma a la caja abierta. SALIDA: deja la caja y otros siguen.
  @Column('varchar') momento: 'INGRESO' | 'SALIDA';
  @Column('int') contado: number;
  @Column('int') esperado: number;
  // esperado − contado, igual que el arqueo: positivo = falta.
  @Column('int') diferencia: number;
  @Column('text', { nullable: true }) motivo: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
