import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Raw, Repository } from 'typeorm';
import { FilterOperator, paginate, Paginated, PaginateQuery } from 'nestjs-paginate';
import { ParkingOwner } from './entities/parking-owner.entity';
import { ParkingRenter } from './entities/parking-renter.entity';
import { OwnerParkingType } from './entities/owner-parking-type.entity';
import { Customer } from 'src/customers/entities/customer.entity';
import { Receipt } from 'src/receipts/entities/receipt.entity';
import { CreateParkingOwnerDto } from './dto/create-parking-owner.dto';
import { UpdateParkingOwnerDto } from './dto/update-parking-owner.dto';
import { CreateOwnerParkingTypeDto } from './dto/create-owner-parking-type.dto';
import { UpdateOwnerParkingTypeDto } from './dto/update-owner-parking-type.dto';

@Injectable()
export class ParkingOwnersService {
  private readonly logger = new Logger(ParkingOwnersService.name);

  constructor(
    @InjectRepository(ParkingOwner)
    private readonly parkingOwnerRepository: Repository<ParkingOwner>,
    @InjectRepository(ParkingRenter)
    private readonly parkingRenterRepository: Repository<ParkingRenter>,
    @InjectRepository(OwnerParkingType)
    private readonly ownerParkingTypeRepository: Repository<OwnerParkingType>,
    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,
    @InjectRepository(Receipt)
    private readonly receiptRepository: Repository<Receipt>,
  ) {}

  private async assertGarageNumberAvailable(
    garageNumber: string,
    ownerRepo: Repository<ParkingOwner>,
    renterRepo: Repository<ParkingRenter>,
  ): Promise<void> {
    if (!garageNumber) return;
    const normalized = garageNumber.replace(/\s/g, '').toLowerCase();

    const [existingOwner, existingRenter] = await Promise.all([
      ownerRepo.findOne({
        where: { garageNumber: Raw((alias) => `LOWER(REPLACE(${alias}, ' ', '')) = :normalized`, { normalized }) },
      }),
      renterRepo.findOne({
        where: { garageNumber: Raw((alias) => `LOWER(REPLACE(${alias}, ' ', '')) = :normalized`, { normalized }) },
      }),
    ]);

    if (existingOwner || existingRenter) {
      throw new NotFoundException({
        code: 'GARAGE_NUMBER_ALREADY_EXIST',
        message: `El número de garage ${garageNumber} ya se encuentra en uso`,
      });
    }
  }

  async getOwnersAvailableForRent(): Promise<ParkingOwner[]> {
    try {
      return await this.parkingOwnerRepository.find({
        where: { rent: true },
        relations: ['customer', 'parkingRenters', 'parkingRenters.customer'],
      });
    } catch (error: any) {
      if (!(error instanceof NotFoundException)) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
  }

  async getOccupancySummary(): Promise<{ offered: number; rented: number; available: number }> {
    try {
      const row = await this.parkingOwnerRepository
        .createQueryBuilder('vehicle')
        .select('COUNT(*) FILTER (WHERE vehicle.rent = true)', 'offered')
        .addSelect('COUNT(*) FILTER (WHERE vehicle.rent = true AND vehicle.rentActive = true)', 'rented')
        .getRawOne();

      const offered = Number(row?.offered ?? 0);
      const rented = Number(row?.rented ?? 0);

      return { offered, rented, available: offered - rented };
    } catch (error: any) {
      this.logger.error(error.message, error.stack);
      throw error;
    }
  }

  // Reemplaza el bloque OWNER de CustomersService.create().
  async createOwnersForCustomer(
    customer: Customer,
    ownerDtos: CreateParkingOwnerDto[],
    manager?: EntityManager,
  ): Promise<ParkingOwner[]> {
    const ownerRepo = manager ? manager.getRepository(ParkingOwner) : this.parkingOwnerRepository;
    const renterRepo = manager ? manager.getRepository(ParkingRenter) : this.parkingRenterRepository;
    const parkingTypeRepo = manager ? manager.getRepository(OwnerParkingType) : this.ownerParkingTypeRepository;

    const owners: ParkingOwner[] = [];

    for (const ownerDto of ownerDtos ?? []) {
      const parkingType = await parkingTypeRepo.findOne({ where: { id: ownerDto.ownerParkingTypeId } });
      if (!parkingType) {
        throw new NotFoundException({ code: 'PARKING_TYPE_NOT_FOUND', message: 'Parking type not found' });
      }

      await this.assertGarageNumberAvailable(ownerDto.garageNumber, ownerRepo, renterRepo);

      if (ownerDto.amountRenter < parkingType.amount) {
        throw new BadRequestException('El monto del alquiler debe ser mayor al monto de expensas');
      }

      const owner = ownerRepo.create({
        ...ownerDto,
        parkingType,
        amount: parkingType.amount,
        customer,
      });

      owners.push(owner);
    }

    if (owners.length) {
      await ownerRepo.save(owners);
    }

    return owners;
  }

  // Reemplaza el bloque OWNER de CustomersService.update() (patrón borrar y
  // recrear). Incluye el cascade que actualiza el recibo pendiente del renter
  // ligado cuando cambia amountRenter de su parking owner.
  async updateOwnersForCustomer(
    customer: Customer,
    ownerDtos: UpdateParkingOwnerDto[],
    manager: EntityManager,
  ): Promise<ParkingOwner[]> {
    const ownerRepo = manager.getRepository(ParkingOwner);
    const renterRepo = manager.getRepository(ParkingRenter);
    const parkingTypeRepo = manager.getRepository(OwnerParkingType);
    const receiptRepo = manager.getRepository(Receipt);

    const existingOwners = await ownerRepo.find({
      where: { customer: { id: customer.id } },
      relations: ['parkingRenters', 'parkingRenters.customer', 'parkingRenters.customer.receipts'],
    });
    const existingOwnersMap = new Map(existingOwners.map((owner) => [owner.id, owner]));

    const owners: ParkingOwner[] = [];

    for (const ownerDto of ownerDtos ?? []) {
      const parkingType = await parkingTypeRepo.findOne({ where: { id: ownerDto.ownerParkingTypeId } });
      if (!parkingType) {
        throw new NotFoundException({ code: 'PARKING_TYPE_NOT_FOUND', message: 'Parking type not found' });
      }

      if (!ownerDto.id) {
        await this.assertGarageNumberAvailable(ownerDto.garageNumber, ownerRepo, renterRepo);

        const newOwner = ownerRepo.create({
          garageNumber: ownerDto.garageNumber,
          rent: ownerDto.rent,
          parkingType,
          amount: parkingType.amount,
          amountRenter: ownerDto.amountRenter,
          customer,
        });

        await ownerRepo.save(newOwner);
        owners.push(newOwner);
        continue;
      }

      const oldOwner = existingOwnersMap.get(ownerDto.id);
      if (!oldOwner) {
        throw new NotFoundException({ code: 'VEHICLE_NOT_FOUND', message: 'Vehículo anterior no encontrado' });
      }

      if (oldOwner.garageNumber !== ownerDto.garageNumber) {
        await this.assertGarageNumberAvailable(ownerDto.garageNumber, ownerRepo, renterRepo);
      }

      if (oldOwner.rent === true && ownerDto.rent === false && oldOwner.parkingRenters?.length > 0) {
        throw new NotFoundException({
          code: 'CUSTOMER_RENTER_RELATIONSHIP',
          message: `El vehiculo del garage (${oldOwner.garageNumber}) ya tiene un inquilino relacionado. Porfavor si desea cambiar esta opcion cambie
                    el garage del inquilino de tercero relacionado o elimine al iniquilino de tercero`,
        });
      }

      if (oldOwner.parkingRenters?.length) {
        const pendingReceipts: Receipt[] = [];

        for (const renter of oldOwner.parkingRenters) {
          const renterCustomer = renter.customer;
          const monthsDebt = (renterCustomer.monthsDebt || []).map((debt) => debt.month.slice(0, 7));

          for (const receipt of renterCustomer.receipts) {
            const receiptMonth = receipt.startDate.slice(0, 7);
            if (receipt.status === 'PENDING' && !monthsDebt.includes(receiptMonth)) {
              pendingReceipts.push(receipt);
            }
          }
        }

        if (pendingReceipts.length > 0) {
          pendingReceipts.sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)));
          const lastPending = pendingReceipts[0];
          lastPending.price = ownerDto.amountRenter;
          lastPending.startAmount = ownerDto.amountRenter;
          await receiptRepo.save(lastPending);
        }
      }

      const newOwner = ownerRepo.create({
        garageNumber: ownerDto.garageNumber,
        rent: ownerDto.rent,
        parkingType,
        amount: parkingType.amount,
        amountRenter: ownerDto.amountRenter,
        customer,
      });

      await ownerRepo.save(newOwner);
      owners.push(newOwner);

      if (oldOwner.parkingRenters?.length > 0) {
        for (const renter of oldOwner.parkingRenters) {
          const foundRenter = await renterRepo.findOne({ where: { id: renter.id } });
          if (!foundRenter) {
            throw new NotFoundException('Vehicle renter not found');
          }

          foundRenter.amount = ownerDto.amountRenter;
          foundRenter.garageNumber = ownerDto.garageNumber;
          foundRenter.parkingOwner = newOwner;
          foundRenter.owner = newOwner.id;
          newOwner.rentActive = true;
          await ownerRepo.save(newOwner);

          await renterRepo.save(foundRenter);
        }
      }

      const fullOldOwner = await ownerRepo.findOne({ where: { id: oldOwner.id }, relations: ['parkingRenters'] });
      await ownerRepo.remove(fullOldOwner);
    }

    return owners;
  }

  async deactivateRentActive(ownerIds: string[], manager?: EntityManager): Promise<void> {
    if (!ownerIds.length) return;
    const repo = manager ? manager.getRepository(ParkingOwner) : this.parkingOwnerRepository;
    await repo.update(ownerIds, { rentActive: false });
  }

  async softDeleteMany(owners: ParkingOwner[]): Promise<void> {
    for (const owner of owners) {
      await this.parkingOwnerRepository.softDelete(owner.id);
    }
  }

  async restoreMany(owners: ParkingOwner[]): Promise<void> {
    for (const owner of owners) {
      owner.deletedAt = null;
      await this.parkingOwnerRepository.save(owner);
    }
  }

  async createOwnerParkingType(createOwnerParkingTypeDto: CreateOwnerParkingTypeDto) {
    try {
      const existType = await this.ownerParkingTypeRepository.findOne({ where: { name: createOwnerParkingTypeDto.name } });
      if (existType) {
        throw new NotFoundException({
          code: 'PARKING_TYPE_ALREDY_EXIST',
          message: `El tipo de estacionamiento ya existe`,
        });
      }
      const parkingType = this.ownerParkingTypeRepository.create(createOwnerParkingTypeDto);
      return await this.ownerParkingTypeRepository.save(parkingType);
    } catch (error: any) {
      this.logger.error(error.message, error.stack);
      throw error;
    }
  }

  async findAllOwnerParkingType(query: PaginateQuery): Promise<Paginated<OwnerParkingType>> {
    try {
      return await paginate(query, this.ownerParkingTypeRepository, {
        sortableColumns: ['id', 'name', 'amount'],
        nullSort: 'last',
        searchableColumns: ['name'],
        filterableColumns: {
          name: [FilterOperator.ILIKE, FilterOperator.EQ],
        },
        relations: ['parkingOwners'],
      });
    } catch (error: any) {
      this.logger.error(error.message, error.stack);
    }
  }

  async updateOwnerParkingType(parkingTypeId: string, updateOwnerParkingTypeDto: UpdateOwnerParkingTypeDto) {
    try {
      const parkingType = await this.ownerParkingTypeRepository.findOne({
        where: { id: parkingTypeId },
      });

      if (!parkingType) {
        throw new NotFoundException('ParkingType not found');
      }

      if (updateOwnerParkingTypeDto.name && updateOwnerParkingTypeDto.name !== parkingType.name) {
        const existType = await this.ownerParkingTypeRepository.findOne({ where: { name: updateOwnerParkingTypeDto.name } });
        if (existType) {
          throw new NotFoundException({
            code: 'PARKING_TYPE_ALREDY_EXIST',
            message: `El tipo de estacionamiento ya existe`,
          });
        }
      }

      const targetMonth = updateOwnerParkingTypeDto.month; // "YYYY-MM"
      const newAmount = updateOwnerParkingTypeDto.amount;

      if (newAmount !== undefined) {
        const owners = await this.customerRepository.find({
          where: { customerType: 'OWNER' },
          relations: ['parkingOwners', 'parkingOwners.parkingType', 'receipts'],
        });

        for (const owner of owners) {
          const ownersToUpdate = owner.parkingOwners.filter((o) => o.parkingType?.id === parkingType.id);

          if (ownersToUpdate.length === 0) continue;

          const count = ownersToUpdate.length;

          // Si tiene 1 owner, queda exacto. Si tiene más, multiplica.
          const exactReceiptTotal = count > 1 ? newAmount * count : newAmount;

          for (const receipt of owner.receipts) {
            const receiptMonthStr = receipt.startDate?.slice(0, 7); // "YYYY-MM"
            if (receiptMonthStr !== targetMonth) continue;
            if (receipt.status !== 'PENDING') continue;

            const hasDebtForMonth = owner.monthsDebt?.some((debt) => debt.month?.slice(0, 7) === receiptMonthStr);
            if (hasDebtForMonth) continue;

            receipt.price = exactReceiptTotal;
            receipt.startAmount = exactReceiptTotal;
            await this.receiptRepository.save(receipt);
          }

          for (const parkingOwner of ownersToUpdate) {
            parkingOwner.amount = newAmount;
            await this.parkingOwnerRepository.save(parkingOwner);
          }
        }
      }

      const updatedParkingType = this.ownerParkingTypeRepository.merge(parkingType, updateOwnerParkingTypeDto);
      return await this.ownerParkingTypeRepository.save(updatedParkingType);
    } catch (error: any) {
      if (!(error instanceof NotFoundException)) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
  }

  async removeOwnerParkingType(parkingTypeId: string) {
    try {
      const parkingType = await this.ownerParkingTypeRepository.findOne({ where: { id: parkingTypeId } });

      if (!parkingType) {
        throw new NotFoundException('ParkingType not found');
      }

      await this.ownerParkingTypeRepository.remove(parkingType);

      return { message: 'Parking Type list removed successfully' };
    } catch (error: any) {
      if (!(error instanceof NotFoundException)) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
  }
}
