import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Playa } from 'src/tenancy/entities/playa.entity';

// Libro de efectivo físico. Los relevos no son ingresos de venta.
@Entity({ name: 'cash_entries' })
export class CashEntry {
  @PrimaryGeneratedColumn('uuid') id: string;

  @Index()
  @Column('uuid', { nullable: true })
  playaId: string | null;

  @ManyToOne(() => Playa, { nullable: true })
  @JoinColumn({ name: 'playaId' })
  playa: Playa | null;
  @Index() @Column('uuid', { nullable: true }) turnoId: string | null;
  @Index() @Column('uuid') boxId: string;
  @Column('int') amount: number;
  @Column('varchar') description: string;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
