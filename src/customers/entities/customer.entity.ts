import {
    Column,
    CreateDateColumn,
    DeleteDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    OneToMany,
    OneToOne,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
  } from 'typeorm';
import { PaymentStatusType, Receipt } from 'src/receipts/entities/receipt.entity';
import { ParkingOwner } from 'src/parking/entities/parking-owner.entity';
import { ParkingRenter } from 'src/parking/entities/parking-renter.entity';

export const CUSTOMER_TYPE = ['OWNER', 'RENTER', 'PRIVATE'] as const;
export type CustomerType = (typeof CUSTOMER_TYPE)[number];

  @Entity({ name: 'customers' })
  export class Customer {
  @Column('uuid', { nullable: true })
  playaId: string | null;

    @PrimaryGeneratedColumn('uuid')
    id: string;
    
    @Column('varchar', { length: 255 })
    firstName: string;
  
    @Column('varchar', { length: 255 })
    lastName: string;  

    @Column('varchar', {nullable:true, length: 255 })
    phone: string;

    @Column('varchar', { length: 650, nullable: true })
    comments: string;

    @Column('int', {nullable:true})
    customerNumber: number;

    @Column('int')
    numberOfVehicles: number;

    @Column('date', { nullable: true })
    startDate: string | null;

    @Column('date', { nullable: true })
    previusStartDate: string | null;

    @Column('enum', { enum: CUSTOMER_TYPE})
    customerType: CustomerType;

    @Column('bool', { nullable:true, default:false })
    hasDebt: boolean;
    
    @Column({ type: 'jsonb', nullable: true })
    monthsDebt?: {
      month: string;
      amount?: number;
      status?: PaymentStatusType;
    }[];

    @Column('int', { default: 0 })
    credit: number;

    @OneToMany(() => ParkingOwner, (parkingOwner) => parkingOwner.customer, { cascade: true})
    parkingOwners: ParkingOwner[];

    @OneToMany(() => Receipt, (receipts) => receipts.customer, {cascade: true})
    receipts: Receipt[];

    @OneToMany(() => ParkingRenter, (parkingRenter) => parkingRenter.customer,{ cascade: true})
    parkingRenters: ParkingRenter[];
  
    @DeleteDateColumn()
    deletedAt: Date;
  
    @CreateDateColumn()
    createdAt: Date;
  
    @UpdateDateColumn()
    updatedAt: Date;
  
  }
  
