import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export interface ParkingReceiptSnapshot {
  kind: 'ENTRY' | 'EXIT';
  parkingName: string;
  address: string | null;
  plate: string;
  vehicleType: string;
  entryDay: string | null;
  entryTime: string | null;
  departureDay: string | null;
  departureTime: string | null;
  total: number | null;
  collected: number | null;
  operatorName?: string | null;
}

// El recibo de un pago de inquilino (cuenta corriente). Documenta la plata recibida, no la
// operación: por eso lleva la leyenda de documento no válido como factura. Tampoco expone nada
// interno: ni usuarios, ni ids, ni movimientos, solo lo que el inquilino tiene que ver.
export interface ReciboPagoSnapshot {
  kind: 'PAGO';
  parkingName: string;
  address: string | null;
  numero: string;
  fecha: string;
  cliente: string;
  total: number;
  medios: { medio: string; importe: number }[];
  aplicado: { concepto: string; importe: number; queda: number }[];
  aFavor: number;
  saldo: number;
  // Solo en la lectura pública: si después de emitido el pago se anuló.
  anulado?: boolean;
}

@Entity('parking_receipts')
@Index(['playaId', 'registrationId', 'kind'], { unique: true })
export class ParkingReceipt {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') playaId: string;
  // Para ENTRY/EXIT, la estadía; para PAGO, el asiento del pago en la cuenta corriente.
  @Column('uuid') registrationId: string;
  @Column('varchar') kind: 'ENTRY' | 'EXIT' | 'PAGO';
  @Index({ unique: true })
  @Column('varchar', { length: 64 })
  token: string;
  @Column('jsonb') snapshot: ParkingReceiptSnapshot | ReciboPagoSnapshot;
  @CreateDateColumn() createdAt: Date;
}
