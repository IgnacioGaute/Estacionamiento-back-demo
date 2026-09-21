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
import { ParkingOwner } from './parking-owner.entity';

  // El nombre del tipo es único DENTRO de la playa: si fuera global, la primera empresa que
  // cree «Mensual» se lo bloquea a todas las demás.
  @Index(['playaId', 'name'], { unique: true })
  @Entity({ name: 'parking_types' })
  export class OwnerParkingType {
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

    // Antes era un enum fijo en código (columna física "parkingType"); ahora es
    // texto libre que el cliente define. Se mantiene el nombre de columna físico
    // para no perder los datos existentes bajo synchronize: true.
    @Column('varchar', { name: 'parkingType', length: 255 })
    name: string;

    @OneToMany(() => ParkingOwner, (parkingOwner) => parkingOwner.parkingType, {cascade:true})
    parkingOwners: ParkingOwner[];
  }
