import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'ticket_schedule_settings' })
export class TicketScheduleSettings {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('int')
  dayStartHour: number;

  @Column('int')
  dayEndHour: number;

  // Tolerancia (en minutos) antes de saltar a cobrar la franja de precio siguiente.
  @Column('int', { default: 5 })
  graceMinutes: number;

  // Si está apagado, la pantalla de operación no muestra nada del flujo por código de barras
  // (escáner, grilla de tickets, ni esos tickets en "Activos ahora") — queda solo el flujo
  // por patente. No borra ni bloquea nada del lado del servidor, es puramente de interfaz.
  @Column('boolean', { default: true })
  barcodeTicketsEnabled: boolean;

  @UpdateDateColumn()
  updatedAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}
