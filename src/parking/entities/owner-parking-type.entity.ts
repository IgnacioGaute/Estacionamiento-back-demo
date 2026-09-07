import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    OneToMany,
    Index,
  } from 'typeorm';
import { ParkingOwner } from './parking-owner.entity';

  @Entity({ name: 'parking_types' })
  export class OwnerParkingType {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('int')
    amount: number;

    // Antes era un enum fijo en código (columna física "parkingType"); ahora es
    // texto libre que el cliente define. Se mantiene el nombre de columna físico
    // para no perder los datos existentes bajo synchronize: true.
    @Column('varchar', { name: 'parkingType', length: 255 })
    @Index({ unique: true })
    name: string;

    @OneToMany(() => ParkingOwner, (parkingOwner) => parkingOwner.parkingType, {cascade:true})
    parkingOwners: ParkingOwner[];
  }
