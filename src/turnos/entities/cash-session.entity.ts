import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Playa } from 'src/tenancy/entities/playa.entity';
import { CashRegister } from './cash-register.entity';

@Entity({ name: 'cash_sessions' })
@Index('cash_session_abierta', ['cajaId'], { unique: true, where: "estado = 'ABIERTO'" })
export class CashSession {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index() @Column('uuid', { nullable: true }) playaId: string | null;
  @ManyToOne(() => Playa, { nullable: true }) @JoinColumn({ name: 'playaId' }) playa: Playa | null;
  @Column('uuid') cajaId: string;
  @ManyToOne(() => CashRegister) @JoinColumn({ name: 'cajaId' }) caja: CashRegister;
  @Column('varchar', { default: 'ABIERTO' }) estado: 'ABIERTO' | 'CERRADO';
  @CreateDateColumn({ type: 'timestamptz' }) fechaApertura: Date;
  @Column('timestamptz', { nullable: true }) fechaCierre: Date | null;
  @Column('int') fondoInicial: number;
  @Column('int', { default: 0 }) fondoEsperado: number;
  @Column('int', { default: 0 }) cambioAgregado: number;
  @Column('int', { default: 0 }) diferenciaApertura: number;
  @Column('text', { nullable: true }) motivoApertura: string | null;
  @Index({ unique: true }) @Column('uuid', { nullable: true }) sesionAnteriorId: string | null;
  @Column('int', { nullable: true }) efectivoTeorico: number | null;
  @Column('int', { nullable: true }) efectivoContado: number | null;
  @Column('int', { nullable: true }) efectivoParaSiguiente: number | null;
  @Column('int', { nullable: true }) efectivoRetirado: number | null;
  @Column('int', { nullable: true }) diferencia: number | null;
  @Column('text', { nullable: true }) observaciones: string | null;
  @Column('uuid', { nullable: true }) usuarioCierreId: string | null;
}
