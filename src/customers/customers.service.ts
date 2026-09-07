import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, DataSource, ILike, In, QueryFailedError, Repository } from 'typeorm';
import { Customer, CustomerType } from './entities/customer.entity';
import { ReceiptsService } from 'src/receipts/receipts.service';
import { addMonths, startOfMonth } from 'date-fns';
import { PaymentStatusType, Receipt } from 'src/receipts/entities/receipt.entity';
import { InterestSettings } from './entities/interest-setting.entity';
import { CreateInterestSettingDto } from './dto/interest-setting.dto';
import { Cron } from '@nestjs/schedule';
import { isUUID } from 'class-validator';

import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import isBetween from 'dayjs/plugin/isBetween';
import { NotificationGateway } from 'src/notes/notification-gateway';
import { v4 as uuidv4 } from 'uuid';
import { NotificationInterestGateway } from './notification-interest-gateway';
import { ParkingOwnersService } from 'src/parking/parking-owners.service';
import { ParkingRentersService } from 'src/parking/parking-renters.service';
import { ParkingOwner } from 'src/parking/entities/parking-owner.entity';
import { ParkingRenter } from 'src/parking/entities/parking-renter.entity';


dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isBetween);

@Injectable()
export class CustomersService {
    private readonly logger = new Logger(CustomersService.name);

    constructor(
      @InjectRepository(Customer)
      private readonly customerRepository: Repository<Customer>,
      @InjectRepository(Receipt)
      private readonly receiptRepository: Repository<Receipt>,
      @InjectRepository(InterestSettings)
      private readonly interestSettingsRepository: Repository<InterestSettings>,
      private readonly receiptsService: ReceiptsService,
      private readonly notificationGateway: NotificationInterestGateway,
      private readonly dataSource: DataSource,
      private readonly parkingOwnersService: ParkingOwnersService,
      private readonly parkingRentersService: ParkingRentersService,
    ) {}

    async create(createCustomerDto: CreateCustomerDto) {
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      try {
        const customerRepo = queryRunner.manager.getRepository(Customer);

        const customer = customerRepo.create({
          ...createCustomerDto,
          parkingOwners: [],
          parkingRenters: []
        });

        const savedCustomer = await customerRepo.save(customer);

        let owners: ParkingOwner[] = [];
        let renters: ParkingRenter[] = [];

        if (customer.customerType === 'OWNER' && createCustomerDto.parkingOwners?.length > 0 ||
            customer.customerType !== 'OWNER' && createCustomerDto.parkingRenters?.length > 0) {

          if (customer.customerType === 'OWNER') {
            owners = await this.parkingOwnersService.createOwnersForCustomer(
              savedCustomer,
              createCustomerDto.parkingOwners,
              queryRunner.manager,
            );
          } else {
            renters = await this.parkingRentersService.createRentersForCustomer(
              savedCustomer,
              createCustomerDto.parkingRenters,
              queryRunner.manager,
            );
          }
        }

        const totalVehicleAmount =
          customer.customerType === 'OWNER'
            ? owners.reduce((acc, owner) => acc + (owner.amount || 0), 0)
            : renters.reduce((acc, renter) => acc + (renter.amount || 0), 0);

            let shouldCreateReceipt = true;

            if (customer.customerType !== 'OWNER') {
              // Si es RENTER, verificar si alguno de los parkingRenters tiene owner vacío
              shouldCreateReceipt = createCustomerDto.parkingRenters?.every(vr => vr.owner !== '');
            }

            if (shouldCreateReceipt) {
              await this.receiptsService.createReceipt(savedCustomer.id, queryRunner.manager, totalVehicleAmount);
            }

          if (createCustomerDto.hasDebt) {
            let parsedMonthsDebt: { month: string; amount?: number }[];

            try {
              parsedMonthsDebt = Array.isArray(createCustomerDto.monthsDebt)
                ? createCustomerDto.monthsDebt
                : JSON.parse(createCustomerDto.monthsDebt);
            } catch (err) {
              throw new BadRequestException('Formato inválido para monthsDebt');
            }

            // Validar formato de cada elemento
            for (const d of parsedMonthsDebt) {
              if (!d.month || typeof d.month !== 'string') {
                throw new BadRequestException('Cada elemento en monthsDebt debe tener un mes válido');
              }
            }
              const monthsDebtWithStatus = parsedMonthsDebt.map(debt => ({
                month: debt.month,
                amount: debt.amount,
                status: 'PENDING' as PaymentStatusType, // asumiendo que PaymentStatusType es un enum o tipo string
              }));

              // Ahora guardás este array en el cliente (save/update)
              savedCustomer.monthsDebt = monthsDebtWithStatus;
              if (owners.length > 0) {
                savedCustomer.parkingOwners = owners;
              }
              if (renters.length > 0) {
                savedCustomer.parkingRenters = renters;
              }
              await customerRepo.save(savedCustomer);

            for (const debt of parsedMonthsDebt) {

              await this.receiptsService.createReceipt(
                savedCustomer.id,
                queryRunner.manager,
                debt.amount,
                null,
                debt.month.length === 7 ? `${debt.month}-01` : debt.month,
              );
            }
          }


        await queryRunner.commitTransaction();
        return savedCustomer;
      } catch (error: any) {
        await queryRunner.rollbackTransaction();
        console.error(error.stack);
        this.logger.error(error.message, error.stack);
        throw error;
      } finally {
        await queryRunner.release();
      }
    }


async findAll(customerType: CustomerType) {
  try {
    const customers = await this.customerRepository.find({
      relations: [
        'receipts',
        'receipts.payments',
        'receipts.paymentHistoryOnAccount',
        'parkingOwners',
        'parkingOwners.parkingType',
        'parkingRenters',
        'parkingOwners.parkingRenters',
        'parkingRenters.customer',
        'parkingRenters.parkingOwner',
        'parkingRenters.parkingOwner.customer',
      ],
      where: { customerType },
      withDeleted: true,
    });
    return customers;
  } catch (error: any) {
    this.logger.error(error.message, error.stack);
    throw error;
  }
}


  async findOne(id: string) {
    try {
      const customer = await this.customerRepository.findOne({
        where: { id },
        relations: ['receipts','parkingOwners','parkingOwners.parkingType','parkingRenters', 'parkingOwners.parkingRenters',
          'parkingRenters.customer', 'parkingRenters.parkingOwner', 'parkingRenters.parkingOwner.customer', 'receipts.payments','receipts.paymentHistoryOnAccount'],
        withDeleted: true
      });

      if (!customer) {
        throw new NotFoundException(`Customer not found`);
      }

      // Ordenar los receipts para que "PENDING" siempre esté al final
      customer.receipts = customer.receipts.sort((a, b) => {
        if (a.status === 'PENDING' && b.status !== 'PENDING') return 1;
        if (a.status !== 'PENDING' && b.status === 'PENDING') return -1;
        return new Date(b.paymentDate).getTime() - new Date(a.paymentDate).getTime(); // Ordenar por fecha descendente
      });

      return customer;
    } catch (error: any) {
      if (!(error instanceof NotFoundException)) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
  }

  async update(id: string, updateCustomerDto: UpdateCustomerDto) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {

      const customerRepo = queryRunner.manager.getRepository(Customer);
      const receiptRepo = queryRunner.manager.getRepository(Receipt);

      const customer = await customerRepo.findOne({
        where: { id },
        relations: ['parkingOwners', 'receipts', 'parkingRenters'],
      });

      if (!customer) {
        throw new NotFoundException(`Customer ${id} not found`);
      }
       const receipts = await receiptRepo.find({
        where: { customer: { id: customer.id }, status: 'PENDING' },
      });

      // Desactivar rentActive de owners rentados / detectar reasignación de dueño-tipo
      if (customer.parkingRenters.length > 0) {
        const { newOwnerKey } = await this.parkingRentersService.resetRentersForCustomer(
          customer,
          updateCustomerDto.parkingRenters,
          queryRunner.manager,
        );

        if (newOwnerKey) {
          for (const receipt of receipts) {

            receipt.receiptTypeKey = newOwnerKey;
            receipt.receiptNumber = '';
            const lastReceipt = await queryRunner.manager
              .createQueryBuilder(Receipt, 'receipt')
              .setLock('pessimistic_write') // <-- esto evita que otras instancias lean al mismo tiempo
              .where('receipt.receiptTypeKey = :type', { type: newOwnerKey })
              .andWhere('receipt.receiptNumber IS NOT NULL')
              .orderBy('receipt.receiptNumber', 'DESC')
              .getOne()
              if (lastReceipt && lastReceipt.receiptNumber) {
              const [shortNumber, longNumber] = lastReceipt.receiptNumber.replace('N° ', '').split('-');
              const nextShort = parseInt(shortNumber).toString().padStart(4, '0');
              const nextLong = (parseInt(longNumber) + 1).toString().padStart(8, '0');
              receipt.receiptNumber = `N° ${nextShort}-${nextLong}`;
            } else {
              receipt.receiptNumber = 'N° 0000-00000001';
            }

            await queryRunner.manager.save(receipt);
          }
        }
      }

      if (
        (customer.customerType === 'OWNER' && updateCustomerDto.parkingOwners?.length > 0) ||
        (customer.customerType !== 'OWNER' && updateCustomerDto.parkingRenters?.length > 0)
      ) {
        if (customer.customerType === 'OWNER') {
          const owners = await this.parkingOwnersService.updateOwnersForCustomer(
            customer,
            updateCustomerDto.parkingOwners,
            queryRunner.manager,
          );
          customer.parkingOwners = owners;
        } else {
          const renters = await this.parkingRentersService.createRentersForCustomer(
            customer,
            updateCustomerDto.parkingRenters,
            queryRunner.manager,
          );
          customer.parkingRenters = renters;
        }
      }


      const totalVehicleAmount = customer.parkingOwners?.length
        ? customer.parkingOwners.reduce((acc, owner) => acc + (owner.amount || 0), 0)
        : customer.parkingRenters.reduce((acc, renter) => acc + (renter.amount || 0), 0);


      const price = totalVehicleAmount;
      const oldMonthsDebtCustoemr = customer.monthsDebt;
      const { parkingOwners, parkingRenters, ...customerData } = updateCustomerDto;

      customerRepo.merge(customer, customerData);
      const savedCustomer = await queryRunner.manager.save(customer);
      const isRenterCustomer = customer.customerType === "RENTER";

      if (isRenterCustomer) {
        // ✅ SOLO el último pending (más reciente) que NO esté en monthsDebt
        const monthsDebtSet = new Set(
          (customer.monthsDebt || []).map((d) => String(d.month).slice(0, 7))
        );

        const pendingReceipts = await receiptRepo.find({
          where: { customer: { id: customer.id }, status: "PENDING" },
          order: { startDate: "DESC" }, // ✅ más reciente primero
        });

        const lastPendingNotDebt = pendingReceipts.find((r) => {
          const m = String(r.startDate).slice(0, 7);
          return !monthsDebtSet.has(m);
        });

        if (lastPendingNotDebt) {
          await queryRunner.manager.update(
            Receipt,
            lastPendingNotDebt.id,
            { price, startAmount: price }
          );
        }
      } else {
        // ✅ comportamiento actual: actualizar todos los pendings que no estén en debt
        for (const receipt of receipts) {
          const receiptMonthStr = String(receipt.startDate).slice(0, 7);

          const hasDebt = (customer.monthsDebt || []).some((debt) => {
            const debtMonth = String(debt.month).slice(0, 7);
            return debtMonth === receiptMonthStr;
          });

          if (hasDebt) continue;

          await queryRunner.manager.update(
            Receipt,
            receipt.id,
            { price, startAmount: price }
          );
        }
      }



      if (
        updateCustomerDto.hasDebt &&
        JSON.stringify(updateCustomerDto.monthsDebt) !== JSON.stringify(oldMonthsDebtCustoemr)
      ) {
        let newMonthsDebt = Array.isArray(updateCustomerDto.monthsDebt)
          ? updateCustomerDto.monthsDebt
          : JSON.parse(updateCustomerDto.monthsDebt);

        newMonthsDebt = newMonthsDebt.map(debt => ({
          ...debt,
          status: debt.status ?? "PENDING",
        }));

        const receiptRepoTxn = queryRunner.manager.getRepository(Receipt);


        const formatMonth = (m: string) =>
          dayjs(m.length === 7 ? `${m}-01` : m).format('YYYY-MM-DD');

        for (const monthDebt of newMonthsDebt) {
          const formattedMonth = formatMonth(monthDebt.month);
          const incomingAmount = Number(monthDebt.amount ?? 0);

          const existing = await receiptRepoTxn.findOne({
            where: {
              customer: { id: customer.id },
              startDate: formattedMonth,
            },
          });

          if (existing) {
            if (existing.price !== incomingAmount) {
              existing.price = incomingAmount;
              await receiptRepoTxn.save(existing);
            }
          } else {
            await this.receiptsService.createReceipt(
              customer.id,
              queryRunner.manager,
              incomingAmount,
              null,
              formattedMonth
            );
          }
        }
      }


      await queryRunner.commitTransaction();
      return savedCustomer;
    } catch (error: any) {
      await queryRunner.rollbackTransaction();
      this.logger.error(error.message, error.stack);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async remove(id: string) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const customer = await this.customerRepository.findOne({
        where: { id },
        withDeleted: true,
        relations: ['parkingRenters', 'parkingRenters.parkingOwner', 'parkingOwners'],
      });

      if (!customer) {
        throw new NotFoundException('Customer not found');
      }

      // Primero marcamos todos los owners como no activos
      const ownerIdsToDeactivate = customer.parkingRenters
        .filter(renter => renter.parkingOwner)
        .map(renter => renter.parkingOwner.id);

      await this.parkingOwnersService.deactivateRentActive(ownerIdsToDeactivate, queryRunner.manager);

      // Ahora sí eliminamos el customer (hard delete)
      await queryRunner.manager.remove(this.customerRepository.target, customer);

      await queryRunner.commitTransaction();

      return { message: 'Customer removed successfully' };
    } catch (error: any) {
      await queryRunner.rollbackTransaction();
      this.logger.error(error.message, error.stack);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }


  async softDelete(id: string) {
    try{
      const customer = await this.customerRepository.findOne({
        where: { id },
        relations: ['parkingOwners', 'receipts', 'parkingRenters'],
      });

      if(!customer){
        throw new NotFoundException('Customer not found')
      }
      if(customer.customerType === 'OWNER'){
        await this.parkingOwnersService.softDeleteMany(customer.parkingOwners);
      }else{
        await this.parkingRentersService.softDeleteMany(customer.parkingRenters);
      }

      for(const receipt of customer.receipts){
        await this.receiptRepository.softDelete(receipt.id);
      }

      await this.customerRepository.softDelete(customer.id);

      return {message: 'Customer removed successfully'}
    } catch (error: any) {
      if (!(error instanceof NotFoundException)) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
  }

  async restoredCustomer(id: string) {
    try{
      const customer = await this.customerRepository.findOne({
        where: { id },
        relations: ['parkingOwners', 'receipts', 'parkingRenters'],
        withDeleted: true
      });

      if(!customer){
        throw new NotFoundException('Customer not found')
      }

      if(customer.customerType === 'OWNER'){
        await this.parkingOwnersService.restoreMany(customer.parkingOwners);
      }else{
        await this.parkingRentersService.restoreMany(customer.parkingRenters);
      }
      for(const receipt of customer.receipts){
        receipt.deletedAt = null;
        await this.receiptRepository.save(receipt);
      }
      customer.deletedAt = null;
      await this.customerRepository.save(customer);

      return {message: 'Customer restored successfully'}
    } catch (error: any) {
      if (!(error instanceof NotFoundException)) {
        this.logger.error(error.message, error.stack);
      }
      throw error;
    }
  }

  async createInterest(createInterestSettingDto: CreateInterestSettingDto) {
    try {
      await this.interestSettingsRepository.clear();
      const interest = this.interestSettingsRepository.create(createInterestSettingDto);
      await this.interestSettingsRepository.save(interest);
      return interest;
    } catch (error: any) {
      this.logger.error(error.message, error.stack);
      throw error;
    }
  }

  async findInterest() {
    try {
      const latestInterest = await this.interestSettingsRepository.find({
        order: { updatedAt: 'DESC' },
        take: 1,
      });

      return latestInterest // Retorna el primer elemento si existe
    } catch (error: any) {
      this.logger.error(`Error al buscar el interés: ${error.message}`);
      throw error;
    }
  }



//   @Cron('0 8 1,10,20,28,30 * *', { timeZone: 'America/Argentina/Buenos_Aires' }) // Se ejecutará el 2 de abril a las 17:31
//  // Todos los dias 1,10,30 de cada mes (28 de febrero) a las 8am '0 8 1,10,20,28,30 * *' */1 * * * *
//   async updateInterests() {
//     try {
//       const today = new Date();
//       if (today.getMonth() === 1 && today.getDate() === 30) {
//         this.logger.log('Febrero no tiene día 30, cancelando ejecución.');
//         return;
//       }

//       this.logger.log('⏳ Verificando y actualizando intereses de clientes...');

//       const customers = await this.customerRepository.find({ relations: ['receipts'] });

//       const latestInterest = await this.interestSettingsRepository.find({
//         order: { updatedAt: 'DESC' },
//         take: 1,
//       });

//       if (!latestInterest || latestInterest.length === 0) {
//         this.logger.error(`No hay configuración de intereses registrada. Cancelando tarea.`);
//         return;
//       }

//       const lastInterest = latestInterest[0];

//       for (const customer of customers) {
//         try {
//           const argentinaTime = dayjs().tz('America/Argentina/Buenos_Aires').startOf('day');
//           const hasPaid = customer.startDate ? argentinaTime.isBefore(dayjs(customer.startDate)) : false;

//           if (hasPaid) {
//             this.logger.warn(`Cliente ${customer.id} ya pagó este mes. Saltando...`);
//             continue; // Saltar este cliente y seguir con el siguiente
//           }

//           const pendingReceipt = customer.receipts?.find((receipt) => receipt.status === 'PENDING');

//           if (!pendingReceipt) {
//             this.logger.warn(`Cliente ${customer.id} no tiene recibo pendiente. Saltando...`);
//             continue;
//           }


//           const additionalInterest =
//             customer.customerType === 'OWNER' ? lastInterest.interestOwner : lastInterest.interestRenter;

//           pendingReceipt.price += additionalInterest;
//           pendingReceipt.interestPercentage += additionalInterest;
//           await this.receiptRepository.save(pendingReceipt);
//           const customerTypeMap = {
//             OWNER: 'Propietario',
//             RENTER: 'Inquilino',
//             PRIVATE: 'Estacionamiento privado',
//           };

//           const readableCustomerType = customerTypeMap[customer.customerType] || customer.customerType;

//           const notificationId = uuidv4();
//           this.notificationGateway.sendNotification({
//             id: notificationId,
//             type: 'INTEREST_PROCESSED',
//             title: 'Interes Aplicado',
//             message: `Se aplico un interes al cliente de tipo ${readableCustomerType} ${customer.lastName} ${customer.firstName} de $${additionalInterest}.`,
//             customerType: customer.customerType,
//             customer: customer,
//             lastName: customer.lastName,
//             customerId: customer.id,
//           });

//           this.logger.log(`Cliente ${customer.id} actualizado. Nuevo precio: ${pendingReceipt.price}`);

//         } catch (error: any) {
//           this.logger.error(`Error procesando cliente ${customer.id}: ${error.message}`);
//         }
//       }

//       this.logger.log('Intereses actualizados correctamente.');
//     } catch (error: any) {
//       this.logger.error('Error al actualizar intereses', error.stack);
//     }
//   }

async getCustomerthird() {
  try {
    const customers = await this.customerRepository.find({
      relations: ['receipts','receipts.payments','receipts.paymentHistoryOnAccount','parkingOwners','parkingOwners.parkingType','parkingRenters', 'parkingOwners.parkingRenters', 'parkingRenters.customer',
           'parkingRenters.parkingOwner', 'parkingRenters.parkingOwner.customer'],
    });

    const filteredCustomers = customers.filter(customer => {
      const receipts = customer.receipts || [];

      // Buscamos el recibo con la fecha más reciente
      const latestReceipt = receipts
        .filter(r => r.receiptTypeKey === 'GARAGE_MITRE')
        .sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime())[0];

      return !!latestReceipt;
    });

    return filteredCustomers;
  } catch (error: any) {
    if (!(error instanceof NotFoundException)) {
      this.logger.error(error.message, error.stack);
    }
    throw error;
  }
}

async getCustomersSummary(from?: string, to?: string) {
  try {
    const argentinaNow = dayjs().tz('America/Argentina/Buenos_Aires');
    const rangeFrom = from ?? argentinaNow.startOf('month').format('YYYY-MM-DD');
    const rangeTo = to ?? argentinaNow.format('YYYY-MM-DD');

    // Se pasan strings ISO (no objetos Date) como parámetros: el driver pg serializa
    // objetos Date usando la zona horaria local del proceso en vez de UTC al compararlos
    // contra una columna timestamp sin tz, lo que corría el límite superior del rango.
    const rangeStart = dayjs.tz(rangeFrom, 'America/Argentina/Buenos_Aires').startOf('day').toISOString();
    const rangeEnd = dayjs.tz(rangeTo, 'America/Argentina/Buenos_Aires').endOf('day').toISOString();

    const rows = await this.customerRepository
      .createQueryBuilder('customer')
      .select('customer.customerType', 'customerType')
      .addSelect('COUNT(*)', 'count')
      .where('customer.createdAt BETWEEN :from AND :to', { from: rangeStart, to: rangeEnd })
      .groupBy('customer.customerType')
      .getRawMany();

    return {
      from: rangeFrom,
      to: rangeTo,
      byCustomerType: rows.map((r) => ({ customerType: r.customerType as CustomerType, count: Number(r.count) })),
    };
  } catch (error: any) {
    this.logger.error(error.message, error.stack);
    throw error;
  }
}

}
