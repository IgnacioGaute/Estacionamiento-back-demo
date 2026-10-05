import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Playa } from 'src/tenancy/entities/playa.entity';

@Entity({ name: 'cash_registers' })
export class CashRegister {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column('uuid', { nullable: true }) playaId: string | null;
  @ManyToOne(() => Playa, { nullable: true }) @JoinColumn({ name: 'playaId' }) playa: Playa | null;
  @Column('varchar', { length: 80 }) nombre: string;
  @Column('boolean', { default: true }) activa: boolean;
  @Column('boolean', { default: false }) principal: boolean;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
