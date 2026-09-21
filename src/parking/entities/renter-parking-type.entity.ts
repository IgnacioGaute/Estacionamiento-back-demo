import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Playa } from 'src/tenancy/entities/playa.entity';
import { ParkingRenter } from './parking-renter.entity';

  @Index(['playaId', 'name'], { unique: true })
  @Entity({ name: 'renter_parking_types' })
  export class RenterParkingType {
    @PrimaryGeneratedColumn('uuid')
    id: string;

  @Index()
  @Column('uuid', { nullable: true })
  playaId: string | null;

  @ManyToOne(() => Playa, { nullable: true })
  @JoinColumn({ name: 'playaId' })
  playa: Playa | null;

    @Column('int')
    amount: number;

    @Column('varchar', { length: 255 })
    name: string;

    @OneToMany(() => ParkingRenter, (parkingRenter) => parkingRenter.parkingType, {cascade:true})
    parkingRenters: ParkingRenter[];
  }
