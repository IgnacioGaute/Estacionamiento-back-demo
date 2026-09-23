import { PricingOptions } from '../pricing/pricing.types';
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
import { Playa } from 'src/tenancy/entities/playa.entity';

// Una sola configuración por playa. Antes era un singleton de hecho, sin nada que lo
// garantizara, y updateSchedule insertaba una fila nueva en cada guardado.
@Index(['playaId'], { unique: true })
@Entity({ name: 'ticket_schedule_settings' })
export class TicketScheduleSettings {
  @Column('jsonb', { default: () => `'{"whatsapp":false,"qr":false,"print":false,"paperWidth":80}'::jsonb` })
  receiptDelivery: { whatsapp: boolean; qr: boolean; print: boolean; paperWidth: 58 | 80 };

  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Sin @Index() propio: el unique de clase ya indexa (playaId), y TypeORM le generaría el
  // mismo nombre a los dos índices por ser el mismo conjunto de columnas.
  @Column('uuid', { nullable: true })
  playaId: string | null;

  @ManyToOne(() => Playa, { nullable: true })
  @JoinColumn({ name: 'playaId' })
  playa: Playa | null;

  @Column('int')
  dayStartHour: number;

  @Column('int')
  dayEndHour: number;

  // Tolerancia (en minutos) antes de saltar a cobrar la franja de precio siguiente.
  @Column('int', { default: 5 })
  graceMinutes: number;

  @Column('varchar', { default: 'EXIT' })
  pricingDayTypeBasis: 'ENTRY' | 'EXIT';

  // Si está apagado, la pantalla de operación no muestra nada del flujo por código de barras
  // (escáner, grilla de tickets, ni esos tickets en "Activos ahora") — queda solo el flujo
  // por patente. No borra ni bloquea nada del lado del servidor, es puramente de interfaz.
  @Column('boolean', { default: true })
  barcodeTicketsEnabled: boolean;

  @Column('jsonb', { nullable: true })
  pricingOptions: PricingOptions | null;

  @UpdateDateColumn()
  updatedAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}
