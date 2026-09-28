import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Raw, Repository } from 'typeorm';
import { FilterOperator, paginate, Paginated, PaginateQuery } from 'nestjs-paginate';
import { ParkingRenter } from './entities/parking-renter.entity';
import { ParkingOwner } from './entities/parking-owner.entity';
import { RenterParkingType } from './entities/renter-parking-type.entity';
import { Customer } from 'src/customers/entities/customer.entity';
import { Receipt } from 'src/receipts/entities/receipt.entity';
import { CreateParkingRenterDto } from './dto/create-parking-renter.dto';
import { UpdateParkingRenterDto } from './dto/update-parking-renter.dto';
import { UpdateAmountAllCustomerDto } from './dto/update-amount-all-customers.dto';
import { CreateRenterParkingTypeDto } from './dto/create-renter-parking-type.dto';
import { UpdateRenterParkingTypeDto } from './dto/update-renter-parking-type.dto';

@Injectable()
export class ParkingRentersService {
  private readonly logger = new Logger(ParkingRentersService.name);

  constructor(
    @InjectRepository(ParkingRenter)
    private readonly parkingRenterRepository: Repository<ParkingRenter>,
    @InjectRepository(ParkingOwner)
    private readonly parkingOwnerRepository: Repository<ParkingOwner>,
    @InjectRepository(RenterParkingType)
    private readonly renterParkingTypeRepository: Repository<RenterParkingType>,
    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,
    @InjectRepository(Receipt)
    private readonly receiptRepository: Repository<Receipt>,
  ) {}

  private async assertGarageNumberAvailable(
    garageNumber: string | null | undefined,
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

  // Reemplaza la constante hardcodeada MANUAL_OWNERS: un renter sin ParkingOwner
  // real como dueño ahora referencia, por nombre, un RenterParkingType (ej. lo
  // que antes eran "JOSE_RICARDO_AZNAR" / "EXPENSES_RICARDO_AZNAR" pasa a ser
  // un único RenterParkingType con name="Ricardo Aznar" y su precio).
  private async getRenterParkingTypesByName(repo: Repository<RenterParkingType>): Promise<Map<string, RenterParkingType>> {
    const types = await repo.find();
    return new Map(types.map((t) => [t.name, t]));
  }

  // Usado tanto por CustomersService.create() como por update() (tras vaciar los
  // renters existentes vía resetRentersForCustomer). Antes existían dos copias
  // ligeramente distintas de esta lógica; se unifican acá aplicando siempre el
  // chequeo de unicidad de garage en la rama de dueño real (el flujo de update()
  // no lo hacía, era una inconsistencia respecto de create()).
  async createRentersForCustomer(
    customer: Customer,
    renterDtos: (CreateParkingRenterDto | UpdateParkingRenterDto)[],
    manager?: EntityManager,
  ): Promise<ParkingRenter[]> {
    const renterRepo = manager ? manager.getRepository(ParkingRenter) : this.parkingRenterRepository;
    const ownerRepo = manager ? manager.getRepository(ParkingOwner) : this.parkingOwnerRepository;
    const renterTypeRepo = manager ? manager.getRepository(RenterParkingType) : this.renterParkingTypeRepository;

    const renterTypesByName = await this.getRenterParkingTypesByName(renterTypeRepo);
    const dtos = renterDtos ?? [];
    const renters: ParkingRenter[] = [];

    for (const renterDto of dtos) {
      if (!renterDto.owner) {
        // Un inquilino tiene cocheras propias de la playa: número y precio mensual, sin
        // propietario. En Particulares una cochera sin propietario no significa nada y se
        // ignora, como antes.
        if (customer.customerType !== 'RENTER') continue;
        if (!Number.isInteger(renterDto.amount) || renterDto.amount < 1)
          throw new BadRequestException({
            code: 'COCHERA_SIN_PRECIO',
            message: 'Poné el precio mensual de cada cochera.',
          });
        const garageNumber = renterDto.garageNumber?.trim() || null;
        await this.assertGarageNumberAvailable(garageNumber, ownerRepo, renterRepo);
        renters.push(
          renterRepo.create({
            customer,
            garageNumber,
            licensePlate: renterDto.licensePlate,
            amount: renterDto.amount,
            owner: null,
            parkingType: null,
          }),
        );
        continue;
      }

      const matchedType = renterTypesByName.get(renterDto.owner);

      if (matchedType) {
        if (dtos.length > 1) {
          const firstOwner = dtos[0].owner;
          const allOwnersMatch = dtos.every((dto) => dto.owner === firstOwner);
          if (!allOwnersMatch) {
            throw new BadRequestException('Todos los Propietarios deben ser iguales');
          }
        }

        await this.assertGarageNumberAvailable(renterDto.garageNumber, ownerRepo, renterRepo);

        const renter = renterRepo.create({
          ...renterDto,
          parkingType: matchedType,
          amount: matchedType.amount,
          customer,
        });

        renters.push(renter);
      } else {
        const parkingOwner = await ownerRepo.findOne({
          where: { id: renterDto.owner },
          relations: ['customer'],
        });

        if (!parkingOwner) {
          throw new NotFoundException('Vehicle not found');
        }

        await this.assertGarageNumberAvailable(renterDto.garageNumber, ownerRepo, renterRepo);

        const renter = renterRepo.create({
          customer,
          parkingOwner,
          amount: parkingOwner.amountRenter || 0,
          garageNumber: parkingOwner.garageNumber,
          owner: renterDto.owner,
        });

        parkingOwner.rentActive = true;
        await ownerRepo.save(parkingOwner);

        renters.push(renter);
      }
    }

    if (renters.length) {
      await renterRepo.save(renters);
    }

    return renters;
  }

  // Reemplaza el bloque de update() que, para cada renter existente del cliente,
  // desactiva el rentActive del owner dueño (caso dueño real) o valida/detecta
  // una reasignación de dueño-tipo, y luego borra todos los renters viejos.
  // La reescritura de receiptTypeKey/receiptNumber sigue orquestada en
  // CustomersService (es un efecto de dominio de Receipts), por eso acá solo se
  // devuelve el nuevo owner detectado.
  async resetRentersForCustomer(
    customer: Customer,
    renterDtos: UpdateParkingRenterDto[],
    manager: EntityManager,
  ): Promise<{ newOwnerKey: string | null }> {
    const renterRepo = manager.getRepository(ParkingRenter);
    const ownerRepo = manager.getRepository(ParkingOwner);
    const renterTypeRepo = manager.getRepository(RenterParkingType);
    const renterTypeNames = new Set((await renterTypeRepo.find()).map((t) => t.name));

    let newOwnerKey: string | null = null;

    for (const renter of customer.parkingRenters ?? []) {
      // Cochera de inquilino sin propietario: no hay cochera ajena que liberar ni tipo que
      // reasignar. (Buscar un ParkingOwner con id null traería cualquiera.)
      if (!renter.owner) continue;
      if (!renterTypeNames.has(renter.owner)) {
        const parkingOwner = await ownerRepo.findOne({ where: { id: renter.owner } });

        if (!parkingOwner) {
          throw new NotFoundException('Vehicle not found');
        }

        if (parkingOwner.rent === true) {
          parkingOwner.rentActive = false;
          await ownerRepo.save(parkingOwner);
        }
      } else {
        if (renterDtos.length > 1) {
          const firstOwner = renterDtos[0].owner;
          const allOwnersMatch = renterDtos.every((dto) => dto.owner === firstOwner);
          if (!allOwnersMatch) {
            throw new BadRequestException('Todos los Propietarios deben ser iguales');
          }
        }

        const candidateNewOwner = renterDtos[0]?.owner;
        if (candidateNewOwner && candidateNewOwner !== renter.owner) {
          newOwnerKey = candidateNewOwner;
        }
      }
    }

    if (customer.parkingRenters?.length) {
      await renterRepo.remove(customer.parkingRenters);
    }
    customer.parkingRenters = [];

    return { newOwnerKey };
  }

  // Orquestador completo de PATCH /parking/renters/amount. Vive acá (no en
  // CustomersService) para que ParkingRentersController no dependa de
  // CustomersModule — CustomersModule ya depende de ParkingModule, así que la
  // dependencia inversa generaría un ciclo de módulos.
  async updateAmount(dto: UpdateAmountAllCustomerDto) {
    try {
      const customers = await this.customerRepository.find({
        where: { customerType: 'RENTER' },
        relations: ['parkingOwners', 'parkingRenters', 'parkingRenters.parkingOwner'],
      });

      if (!customers.length) {
        throw new NotFoundException(`No se encontraron clientes de tipo ${dto.customerType}`);
      }

      // El importe nuevo rige para los abonos que se carguen de acá en adelante. Los cargos ya
      // registrados no se tocan: antes se sumaba la diferencia a «algún» pendiente, sin pasar por
      // la cuenta corriente, y el saldo dejaba de coincidir con los cargos.
      await this.bulkAdjustAmounts(customers, dto);

      return { message: 'Monto actualizado correctamente', customers };
    } catch (error: any) {
      this.logger.error(error.message, error.stack);
      throw error;
    }
  }

  private async bulkAdjustAmounts(
    customers: Customer[],
    dto: UpdateAmountAllCustomerDto,
  ): Promise<Map<string, number>> {
    const renterTypeNames = new Set((await this.renterParkingTypeRepository.find()).map((t) => t.name));
    const isManualOwner = renterTypeNames.has(dto.ownerTypeOfRenter);
    const countsByCustomer = new Map<string, number>();

    for (const customer of customers) {
      const filteredRenters = (customer.parkingRenters ?? []).filter((renter) =>
        isManualOwner ? renterTypeNames.has(renter.owner) : !renterTypeNames.has(renter.owner),
      );

      for (const renter of filteredRenters) {
        if (!isManualOwner && renter.parkingOwner) {
          renter.parkingOwner.amountRenter += dto.amount;
          await this.parkingOwnerRepository.save(renter.parkingOwner);
        }
        renter.amount += dto.amount;
      }

      if (filteredRenters.length) {
        await this.parkingRenterRepository.save(filteredRenters);
      }

      countsByCustomer.set(customer.id, filteredRenters.length);
    }

    return countsByCustomer;
  }

  async softDeleteMany(renters: ParkingRenter[]): Promise<void> {
    for (const renter of renters) {
      await this.parkingRenterRepository.softDelete(renter.id);
    }
  }

  async restoreMany(renters: ParkingRenter[]): Promise<void> {
    for (const renter of renters) {
      renter.deletedAt = null;
      await this.parkingRenterRepository.save(renter);
    }
  }

  // Código muerto heredado: ningún controller lo invoca hoy. Se conserva tal
  // cual estaba (sin ruta nueva) porque no fue pedido eliminarlo.
  async changeCustomerOwner(parkingRenterId: string, newParkingOwnerId: string) {
    try {
      const renter = await this.parkingRenterRepository.findOne({
        where: { id: parkingRenterId },
        relations: ['customer', 'parkingOwner'],
      });

      renter.parkingOwner.rentActive = false;
      await this.parkingOwnerRepository.save(renter.parkingOwner);

      const newParkingOwner = await this.parkingOwnerRepository.findOne({
        where: { id: newParkingOwnerId },
        relations: ['customer'],
      });

      renter.owner = newParkingOwner.customer.id;
      renter.parkingOwner = newParkingOwner;
      renter.garageNumber = newParkingOwner.garageNumber;
      await this.parkingRenterRepository.save(renter);
    } catch (error: any) {
      if (!(error instanceof NotFoundException)) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
  }

  // --- RenterParkingType: catálogo dinámico de tipos/precios para inquilinos.
  // También cumple el rol de "dueño manual" (renter sin ParkingOwner real): su
  // `name` es lo que se guarda en ParkingRenter.owner / Receipt.receiptTypeKey
  // para ese caso (antes eran las constantes JOSE_RICARDO_AZNAR, etc.).

  async createRenterParkingType(dto: CreateRenterParkingTypeDto) {
    try {
      const existing = await this.renterParkingTypeRepository.findOne({ where: { name: dto.name } });
      if (existing) {
        throw new NotFoundException({ code: 'PARKING_TYPE_ALREDY_EXIST', message: 'El tipo de estacionamiento ya existe' });
      }
      const type = this.renterParkingTypeRepository.create(dto);
      return await this.renterParkingTypeRepository.save(type);
    } catch (error: any) {
      this.logger.error(error.message, error.stack);
      throw error;
    }
  }

  async findAllRenterParkingType(query: PaginateQuery): Promise<Paginated<RenterParkingType>> {
    try {
      return await paginate(query, this.renterParkingTypeRepository, {
        sortableColumns: ['id', 'name', 'amount'],
        nullSort: 'last',
        searchableColumns: ['name'],
        filterableColumns: { name: [FilterOperator.ILIKE, FilterOperator.EQ] },
        relations: ['parkingRenters'],
      });
    } catch (error: any) {
      this.logger.error(error.message, error.stack);
    }
  }

  async updateRenterParkingType(id: string, dto: UpdateRenterParkingTypeDto) {
    try {
      const type = await this.renterParkingTypeRepository.findOne({ where: { id } });
      if (!type) {
        throw new NotFoundException('RenterParkingType not found');
      }

      if (dto.name && dto.name !== type.name) {
        const existing = await this.renterParkingTypeRepository.findOne({ where: { name: dto.name } });
        if (existing) {
          throw new NotFoundException({ code: 'PARKING_TYPE_ALREDY_EXIST', message: 'El tipo de estacionamiento ya existe' });
        }

        // Los renters "manuales" guardan el nombre (no el id) en `owner` — al
        // renombrar el tipo, se actualiza ese texto para no dejarlos huérfanos.
        await this.parkingRenterRepository.update({ owner: type.name }, { owner: dto.name });
      }

      const newAmount = dto.amount;

      if (newAmount !== undefined) {
        const renterCustomers = await this.customerRepository.find({
          where: { customerType: 'RENTER' },
          relations: ['parkingRenters', 'parkingRenters.parkingType'],
        });

        // El precio nuevo rige para los abonos que se carguen de acá en adelante (`dto.month` ya
        // no reescribe el cargo de ese mes). Los cargos registrados conservan su importe; si hay
        // que corregir alguno, se hace con un ajuste en la cuenta corriente, que deja rastro.
        for (const renterCustomer of renterCustomers) {
          const rentersToUpdate = renterCustomer.parkingRenters.filter((r) => r.parkingType?.id === type.id);

          if (rentersToUpdate.length === 0) continue;

          for (const renter of rentersToUpdate) {
            renter.amount = newAmount;
            await this.parkingRenterRepository.save(renter);
          }
        }
      }

      const updated = this.renterParkingTypeRepository.merge(type, dto);
      return await this.renterParkingTypeRepository.save(updated);
    } catch (error: any) {
      if (!(error instanceof NotFoundException)) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
  }

  async removeRenterParkingType(id: string) {
    try {
      const type = await this.renterParkingTypeRepository.findOne({ where: { id } });
      if (!type) {
        throw new NotFoundException('RenterParkingType not found');
      }
      await this.renterParkingTypeRepository.remove(type);
      return { message: 'Renter Parking Type removed successfully' };
    } catch (error: any) {
      if (!(error instanceof NotFoundException)) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
  }
}
