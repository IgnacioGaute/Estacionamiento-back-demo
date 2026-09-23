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
}

@Entity('parking_receipts')
@Index(['playaId', 'registrationId', 'kind'], { unique: true })
export class ParkingReceipt {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column('uuid') playaId: string;
  @Column('uuid') registrationId: string;
  @Column('varchar') kind: 'ENTRY' | 'EXIT';
  @Index({ unique: true })
  @Column('varchar', { length: 64 })
  token: string;
  @Column('jsonb') snapshot: ParkingReceiptSnapshot;
  @CreateDateColumn() createdAt: Date;
}
