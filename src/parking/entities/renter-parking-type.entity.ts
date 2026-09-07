import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    OneToMany,
    Index,
  } from 'typeorm';
import { ParkingRenter } from './parking-renter.entity';

  @Entity({ name: 'renter_parking_types' })
  export class RenterParkingType {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('int')
    amount: number;

    @Column('varchar', { length: 255 })
    @Index({ unique: true })
    name: string;

    @OneToMany(() => ParkingRenter, (parkingRenter) => parkingRenter.parkingType, {cascade:true})
    parkingRenters: ParkingRenter[];
  }
