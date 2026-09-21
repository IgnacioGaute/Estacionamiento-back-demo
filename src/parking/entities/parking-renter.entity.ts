import {
  Column,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Playa } from 'src/tenancy/entities/playa.entity';
import { Customer } from 'src/customers/entities/customer.entity';
import { ParkingOwner } from './parking-owner.entity';
import { RenterParkingType } from './renter-parking-type.entity';

  @Entity({ name: 'vehicle_renters' })
  export class ParkingRenter {
    @PrimaryGeneratedColumn('uuid')
    id: string;

  @Index()
  @Column('uuid', { nullable: true })
  playaId: string | null;

  @ManyToOne(() => Playa, { nullable: true })
  @JoinColumn({ name: 'playaId' })
  playa: Playa | null;

    @Column('varchar',{nullable:true})
    garageNumber: string;

    @Column('varchar', { length: 255, nullable:true })
    licensePlate: string;

    @Column('int',{nullable:true})
    amount: number;

    @Column('varchar')
    owner: string;

    @ManyToOne(() => ParkingOwner, (parkingOwner) => parkingOwner.parkingRenters)
    @JoinColumn({ name: 'vehicleId' })
    parkingOwner: ParkingOwner;

    @ManyToOne(() => Customer, (customer) => customer.parkingRenters, { onDelete: 'CASCADE' })
    customer: Customer;

    // Se setea cuando `owner` matchea el nombre de un RenterParkingType en vez
    // de un ParkingOwner.id real (el caso "dueño sin spot real", ej. Ricardo,
    // Aldo, Nidia, Carlos) — ahí `amount` se copia del tipo. Para renters
    // ligados a un ParkingOwner real queda null y `amount` sale de ahí.
    @ManyToOne(() => RenterParkingType, (parkingType) => parkingType.parkingRenters, { nullable: true, onDelete: 'SET NULL' })
    parkingType: RenterParkingType | null;

    @DeleteDateColumn()
    deletedAt: Date;
  }
