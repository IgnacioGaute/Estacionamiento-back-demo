import {
    Entity,
    Column,
    ManyToOne,
    PrimaryGeneratedColumn,
    DeleteDateColumn,
    OneToMany,
    UpdateDateColumn,
  } from 'typeorm';
  import { Customer } from 'src/customers/entities/customer.entity';
import { OwnerParkingType } from './owner-parking-type.entity';
import { ParkingRenter } from './parking-renter.entity';
  @Entity({ name: 'vehicles' })
  export class ParkingOwner {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('varchar',{nullable:true})
    garageNumber: string;

    @Column('varchar', { length: 255, nullable:true })
    licensePlate: string;

    @Column('bool', { nullable:true, default:false })
    rent: boolean;

    @Column('bool', { nullable:true, default:false })
    rentActive: boolean;

    @Column('int',{nullable:true})
    amount: number;

    @Column('int',{nullable:true})
    amountRenter: number;

    @ManyToOne(() => OwnerParkingType, (parkingType) => parkingType.parkingOwners, { onDelete: 'CASCADE' })
    parkingType: OwnerParkingType;

    @ManyToOne(() => Customer, (customer) => customer.parkingOwners, { onDelete: 'CASCADE' })
    customer: Customer;

    @OneToMany(() => ParkingRenter, (parkingRenter) => parkingRenter.parkingOwner)
    parkingRenters: ParkingRenter[];

    @DeleteDateColumn()
    deletedAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

  }
