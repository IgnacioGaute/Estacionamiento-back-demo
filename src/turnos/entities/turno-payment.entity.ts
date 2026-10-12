import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// Complementa el libro de tickets con los cobros digitales de abonos e inquilinos.
// Los importes son firmados: las correcciones se agregan, no reescriben cierres.
@Entity({ name: 'turno_payments' })
export class TurnoPayment {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid', { nullable: true }) playaId: string | null;
  @Index() @Column('uuid', { nullable: true }) turnoId: string | null;
  @Column('varchar') medio: string;
  @Column('int') amount: number;
  @Column('varchar') referencia: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
