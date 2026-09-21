import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Playa } from 'src/tenancy/entities/playa.entity';
import { Ticket } from './ticket.entity';
import { TICKET_TYPE, TicketType } from './ticket.constants';
import { BoxList } from 'src/box-lists/entities/box-list.entity';
import { PricingSnapshot, PricingDayType, PricingLine } from '../pricing/pricing.types';
import { Movimiento } from 'src/movimientos/entities/movimiento.entity';
@Entity({ name: 'ticket_registrations' })
export class TicketRegistration {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid', { nullable: true })
  playaId: string | null;

  @ManyToOne(() => Playa, { nullable: true })
  @JoinColumn({ name: 'playaId' })
  playa: Playa | null;

  @Column('jsonb', { nullable: true })
  pricingBreakdown: PricingLine[] | null;

  @Column('jsonb', { nullable: true })
  pricingSnapshot: PricingSnapshot | null;

  // Saldo inicial de registros anteriores al libro de movimientos, sin inventar un cobro nuevo.
  @Column('int', { nullable: true })
  legacyCollectedOffset: number | null;

  @Column('varchar', { nullable: true })
  appliedPricingDayType: PricingDayType | null;

  @Column('varchar', { nullable: true })
  entryMode: 'BARCODE' | 'PLATE' | null;

  
  @Column('varchar', { length: 255 })
  description: string;

  @Column('int')
  price: number;

  @Column('varchar', {nullable: true})
  codeBarTicket: string;
  
  @Column('date', { nullable: true })
  entryDay: string | null;
  
  @Column('date', { nullable: true })
  departureDay: string | null;
  
  @Column('time', { nullable: true })
  entryTime: string | null;
  
  @Column('time', { nullable: true })
  departureTime: string | null;

  @Column('date', { nullable: true })
  dateNow: string | null;

  // Monto cobrado por adelantado (opcional, para estadías largas planificadas). Al cerrar el
  // registro solo se acredita a caja la diferencia entre el precio final y este monto.
  @Column('int', { nullable: true })
  advancePaidAmount: number | null;

  @Column('varchar', { length: 100, nullable: true })
  firstNameCustomer: string | null;

  @Column('varchar', { length: 100, nullable: true })
  lastNameCustomer: string | null;

  // @deprecated — reemplazado por licensePlateOriginal/Normalized/Search. Se deja de escribir
  // pero no se borra la columna (con synchronize:true, borrar el @Column borra los datos).
  @Column('varchar', { length: 50, nullable: true })
  vehiclePlateCustomer: string | null;

  // Patente tal cual la tipeó el operador — para mostrar en pantalla y en listados.
  @Column('varchar', { length: 20, nullable: true })
  licensePlateOriginal: string | null;

  // Mayúsculas, solo alfanumérico — para detectar patentes duplicadas activas.
  @Index()
  @Column('varchar', { length: 20, nullable: true })
  licensePlateNormalized: string | null;

  // Normalizada + sustitución de caracteres confundibles (O→0, I→1, S→5, B→8) — para buscar.
  @Index()
  @Column('varchar', { length: 20, nullable: true })
  licensePlateSearch: string | null;

  @Column('varchar', { length: 20, nullable: true })
  casilleroNumber: string | null;

  // "Sin patente" — motos sin chapa, patente rota, chapa provisoria.
  @Column('boolean', { default: false })
  noPlate: boolean;

  // Tipo de vehículo para los registros del flujo por patente (sin Ticket/código de barras
  // del que leerlo) — los del flujo por escaneo lo siguen leyendo de `ticket.vehicleType`.
  @Column('varchar', { length: 32, nullable: true })
  vehicleType: TicketType | null;

  // Motivo obligatorio cuando se fuerza un alta con una patente que ya tiene un ingreso activo.
  @Column('varchar', { length: 255, nullable: true })
  duplicatePlateOverrideReason: string | null;

  // Referencia informativa al registro activo con el que compartía patente (sin FK).
  @Column('uuid', { nullable: true })
  duplicateOfRegistrationId: string | null;

  // Nombre de la franja de precio (TicketPriceBracket) aplicada al cerrar el registro.
  @Column('varchar', { length: 255, nullable: true })
  priceBracketLabel: string | null;

  // true si el tiempo transcurrido superó todas las franjas configuradas y se cobró la
  // última como catch-all (no había ninguna franja "sin límite" que cubriera el caso).
  @Column('boolean', { default: false })
  priceBracketFallbackUsed: boolean;

  // Duración que el operador avisó que el cliente iba a quedarse (ej. "3 días"), cargada
  // opcionalmente desde "Cobrar por adelantado" — no implica que se haya cobrado nada.
  @Column('varchar', { length: 255, nullable: true })
  expectedBracketLabel: string | null;

  @Column('int', { nullable: true })
  expectedUptoMinutes: number | null;

  // true si, al cerrar, la estadía real superó la duración avisada.
  @Column('boolean', { default: false })
  exceededExpectedStay: boolean;

  @OneToOne(() => Ticket, (ticket) => ticket.ticketRegistration)
  @JoinColumn()
  ticket: Ticket;

  @ManyToOne(() => BoxList, (boxList) => boxList.ticketRegistrations, {onDelete: 'CASCADE'})
  boxList: BoxList;

  @OneToMany(() => Movimiento, (movimiento) => movimiento.ticketRegistration)
  movimientos: Movimiento[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

}
