import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Playa } from 'src/tenancy/entities/playa.entity';
import { TICKET_DAY_TYPE, TicketDayType, TICKET_TYPE, TicketType } from './ticket.constants';

@Entity({ name: 'ticket_price_brackets' })
export class TicketPriceBracket {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid', { nullable: true })
  playaId: string | null;

  @ManyToOne(() => Playa, { nullable: true })
  @JoinColumn({ name: 'playaId' })
  playa: Playa | null;

  @Column('varchar', { length: 32 })
  vehicleType: TicketType;

  // null = aplica sin importar día/noche (recomendado para franjas largas).
  @Column('enum', { enum: TICKET_DAY_TYPE, nullable: true })
  ticketDayType: TicketDayType | null;

  @Column('varchar', { length: 255 })
  label: string;

  // Tiempo máximo (en minutos) que cubre esta franja; null = última franja, sin techo.
  @Column('int', { nullable: true })
  uptoMinutes: number | null;

  // Si uptoMinutes es null (última franja) y recurringUnitMinutes está seteado, `price` deja
  // de ser un monto fijo único y pasa a ser una tarifa que se repite cada recurringUnitMinutes
  // (ej. price=1500, recurringUnitMinutes=1440 => "$1500 por cada día adicional"). Si
  // recurringUnitMinutes es null, `price` se cobra fijo una sola vez sin importar cuánto más
  // dure la estadía.
  @Column('int')
  price: number;

  @Column('int', { nullable: true })
  recurringUnitMinutes: number | null;

  @Column('varchar', { default: 'DERIVED' })
  recurringPriceMode: 'FIXED' | 'DERIVED';

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
