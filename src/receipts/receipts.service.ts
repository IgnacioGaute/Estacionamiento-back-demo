import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, MoreThan, Not, Raw, Repository } from 'typeorm';
import { BoxListsService } from 'src/box-lists/box-lists.service';
import { BoxList } from 'src/box-lists/entities/box-list.entity';
import { addMonths, startOfMonth } from 'date-fns';
import { Customer, CustomerType } from 'src/customers/entities/customer.entity';
import { RenterParkingType } from 'src/parking/entities/renter-parking-type.entity';
import { Receipt } from './entities/receipt.entity';
import { UpdateReceiptDto } from './dto/update-receipt.dto';

import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import isBetween from 'dayjs/plugin/isBetween'; 
import { LessThan } from "typeorm";
import { ReceiptPayment } from './entities/receipt-payment.entity';
import { PaymentHistoryOnAccount } from './entities/payment-history-on-account.entity';
import { Movimiento } from 'src/movimientos/entities/movimiento.entity';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isBetween);

@Injectable()
export class ReceiptsService {
    private readonly logger = new Logger(ReceiptsService.name);
    
    constructor(
        @InjectRepository(Receipt)
        private readonly receiptRepository: Repository<Receipt>,
        @InjectRepository(Customer)
        private readonly customerRepository: Repository<Customer>,
        @InjectRepository(ReceiptPayment)
        private readonly receiptPaymentRepository: Repository<ReceiptPayment>,
        @InjectRepository(PaymentHistoryOnAccount)
        private readonly paymentHistoryOnAccountRepository: Repository<PaymentHistoryOnAccount>,
        @InjectRepository(Movimiento)
        private readonly movimientoRepository: Repository<Movimiento>,
        private readonly boxListsService: BoxListsService,
        private readonly dataSource: DataSource,
    ) {}

async createReceipt(customerId: string, manager: EntityManager, price?: number, dateNow?: string, dateNowForDebt?: string): Promise<Receipt> {
  try {

    const customer = await manager.findOne(Customer, {
      where: { id: customerId },
      relations: ['parkingOwners', 'parkingRenters', 'receipts'],
    });

    if (!customer) {
      throw new NotFoundException('Customer not found');
    }
    const argentinaTime = dayjs().tz('America/Argentina/Buenos_Aires');
    const nextMonthStartDate = argentinaTime
    .startOf('month')
    .add(1, 'day') 
    .tz('America/Argentina/Buenos_Aires')
    .format('YYYY-MM-DD');
    const actualStartDate = dateNow ?? dateNowForDebt ?? nextMonthStartDate;


    const length = Math.random() < 0.5 ? 11 : 15;
    const barcode = Array.from({ length }, () => Math.floor(Math.random() * 10)).join('');

    const lastReceiptForTypeKey = await manager.findOne(Receipt, {
        where: {
          customer: { id: customer.id },
          status: 'PENDING',
        },
        order: {
          dateNow: 'ASC',
        },
  });
    // TIPO DE RECIBO
    let receiptTypeKey = 'OWNER';
    const manualOwnerNames = lastReceiptForTypeKey
      ? [lastReceiptForTypeKey.receiptTypeKey]
      : (await manager.find(RenterParkingType)).map((t) => t.name);

    if (customer.customerType === 'RENTER') {
      const matchedOwner = customer.parkingRenters.find(renter =>
        manualOwnerNames.includes(renter.owner)
      );

      receiptTypeKey = matchedOwner ? matchedOwner.owner : 'GARAGE_MITRE';
    }

    // ÚLTIMO NÚMERO PARA ESTE receiptTypeKey
      const lastReceipt = await manager
        .createQueryBuilder(Receipt, 'receipt')
        .setLock('pessimistic_write') // <-- esto evita que otras instancias lean al mismo tiempo
        .where('receipt.receiptTypeKey = :type', { type: receiptTypeKey })
        .andWhere('receipt.receiptNumber IS NOT NULL')
        .orderBy('receipt.receiptNumber', 'DESC')
        .getOne();

        
    const receipt = manager.create(Receipt, {
      customer,
      price : price,
      startAmount: price,
      dateNow: actualStartDate,
      startDate: actualStartDate,
      barcode,
      receiptTypeKey,
    });


    // GENERAR receiptNumber
    if (lastReceipt && lastReceipt.receiptNumber) {
      const [shortNumber, longNumber] = lastReceipt.receiptNumber.replace('N° ', '').split('-');
      const nextShort = parseInt(shortNumber).toString().padStart(4, '0');
      const nextLong = (parseInt(longNumber) + 1).toString().padStart(8, '0');
      receipt.receiptNumber = `N° ${nextShort}-${nextLong}`;
    } else {
      receipt.receiptNumber = 'N° 0000-00000001';
    }

    return await manager.save(receipt);
  } catch (error: any) {
    if (!(error instanceof NotFoundException)) {
      this.logger.error(error.message, error.stack);
    }
    throw error;
  }
}

async updateReceipt(
  receiptId: string,
  customerId: string,
  updateReceiptDto?: UpdateReceiptDto
) {
  const queryRunner = this.dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();

  // =========================================================
  // ✅ Helper (solo EF/CH impacta en caja)
  // =========================================================
  const shouldAffectBox = (paymentType: string) =>
    paymentType === "CASH" || paymentType === "CHECK";

  // =========================================================
  // ✅ Helper: logs SOLO para PRIVATE
  // =========================================================
  const logPrivate = (customer: any, message: string, data?: any) => {
    if (customer?.customerType !== "PRIVATE") return;

    // ✅ si querés SOLO logger, borrá el console.log
    console.log(`🔎 [updateReceipt:PRIVATE] ${message}`, data ?? "");
    this.logger.log(
      `[updateReceipt:PRIVATE] ${message}${data ? ` | ${JSON.stringify(data)}` : ""}`
    );
  };

  // =========================================================
  // ✅ Helper: repartir leftover del PRIVATE en numberInBox
  // =========================================================
  const distributeLeftoverAcrossPrivatePayments = async (
    privatePaymentsToUpdate: ReceiptPayment[],
    leftover: number
  ) => {
    for (const p of privatePaymentsToUpdate) {
      p.numberInBox = 0;
    }

    let remaining = leftover;

    for (const p of privatePaymentsToUpdate) {
      if (remaining <= 0) break;

      const cap = Math.max(0, Number(p.price ?? 0));
      const applied = Math.min(cap, remaining);

      p.numberInBox = applied;
      remaining -= applied;
    }

    await queryRunner.manager.save(privatePaymentsToUpdate);
  };

  // =========================================================
  // ✅ FUNCIÓN APARTE:
  //    Compensa PRIVATE -> OWNER (FIFO, parcial, numberInBox)
  // =========================================================
  const applyPrivateOwnerCompensation = async (args: {
    now: string;
    privateHasFIX: boolean;
    sharedBoxList: BoxList | null;

    privatePaymentsCreated: ReceiptPayment[];
    ownerPendingReceipts: Receipt[];

    paymentTypeForOwner: "MIX" | "TP";

    // ✅ para logs
    customer: Customer;
    ownerId?: string | null;
  }) => {
    const {
      now,
      privateHasFIX,
      sharedBoxList,
      privatePaymentsCreated,
      ownerPendingReceipts,
      paymentTypeForOwner,
      customer,
      ownerId,
    } = args;

    logPrivate(customer, "Entró a applyPrivateOwnerCompensation()", {
      now,
      privateHasFIX,
      sharedBoxListId: sharedBoxList?.id ?? null,
      privatePaymentsCreatedCount: privatePaymentsCreated.length,
      ownerPendingReceiptsCount: ownerPendingReceipts.length,
      paymentTypeForOwner,
      ownerId,
    });

    if (privateHasFIX) {
      logPrivate(customer, "privateHasFIX=true => no compensa, numberInBox=0 en pagos private");
      for (const p of privatePaymentsCreated) p.numberInBox = 0;
      if (privatePaymentsCreated.length) await queryRunner.manager.save(privatePaymentsCreated);
      return;
    }

    if (!sharedBoxList) {
      logPrivate(customer, "No sharedBoxList => no compensa (return)");
      return;
    }

    if (!ownerPendingReceipts?.length) {
      logPrivate(customer, "Owner no tiene pendings => numberInBox del private = price");
      for (const p of privatePaymentsCreated) {
        p.numberInBox = Number(p.price ?? 0);
      }
      if (privatePaymentsCreated.length) await queryRunner.manager.save(privatePaymentsCreated);
      return;
    }

    const privateTotalPaid = privatePaymentsCreated.reduce(
      (sum, p) => sum + Number(p.price ?? 0),
      0
    );

    const ownerTotalDebt = ownerPendingReceipts.reduce(
      (sum, r) => sum + Number(r.price ?? 0),
      0
    );

    let toAllocateToOwner = Math.min(privateTotalPaid, ownerTotalDebt);
    const privateLeftover = Math.max(0, privateTotalPaid - toAllocateToOwner);

    logPrivate(customer, "Cálculos iniciales", {
      privateTotalPaid,
      ownerTotalDebt,
      toAllocateToOwner,
      privateLeftover,
      ownerPendingMonths: ownerPendingReceipts.map(r => String(r.startDate).slice(0, 7)),
    });

    await distributeLeftoverAcrossPrivatePayments(privatePaymentsCreated, privateLeftover);

    for (const ownerReceipt of ownerPendingReceipts) {
      if (toAllocateToOwner <= 0) break;

      const ownerCurrentDebt = Number(ownerReceipt.price ?? 0);
      if (ownerCurrentDebt <= 0) continue;

      const apply = Math.min(ownerCurrentDebt, toAllocateToOwner);
      toAllocateToOwner -= apply;

      logPrivate(customer, "Aplicando al OWNER (FIFO)", {
        ownerReceiptId: ownerReceipt.id,
        ownerReceiptMonth: String(ownerReceipt.startDate).slice(0, 7),
        ownerCurrentDebt,
        apply,
        remainingToAllocate: toAllocateToOwner,
      });

      const ownerPayment = this.receiptPaymentRepository.create({
        paymentType: paymentTypeForOwner as any,
        price: apply,
        paymentDate: now,
        receipt: ownerReceipt,
        boxList: { id: sharedBoxList.id } as BoxList,
        numberInBox: apply,
      });

      await this.receiptPaymentRepository.save(ownerPayment);

      const remainingDebt = ownerCurrentDebt - apply;

      if (remainingDebt <= 0) {
        ownerReceipt.price = 0;
        ownerReceipt.status = "PAID";
        ownerReceipt.paymentDate = now;
        logPrivate(customer, "OWNER receipt quedó PAID", {
          ownerReceiptId: ownerReceipt.id,
          month: String(ownerReceipt.startDate).slice(0, 7),
        });
      } else {
        ownerReceipt.price = remainingDebt;
        ownerReceipt.status = "PENDING";
        ownerReceipt.paymentDate = null;
        logPrivate(customer, "OWNER receipt quedó PENDING (parcial)", {
          ownerReceiptId: ownerReceipt.id,
          month: String(ownerReceipt.startDate).slice(0, 7),
          remainingDebt,
        });
      }

      await queryRunner.manager.save(ownerReceipt);
    }

    logPrivate(customer, "Fin applyPrivateOwnerCompensation()", {
      leftoverPrivate: privateLeftover,
    });
  };

  try {
    // =========================================================
    // 🧍 Buscar CUSTOMER y RECEIPT
    // =========================================================
    const customer = await queryRunner.manager.findOne(Customer, {
      where: { id: customerId },
      relations: ["receipts"],
    });
    if (!customer) throw new NotFoundException("Customer not found");

    logPrivate(customer, "Inicio updateReceipt()", { receiptId, customerId });

    const receipt = !updateReceiptDto.barcode
      ? await queryRunner.manager.findOne(Receipt, { where: { id: receiptId } })
      : await queryRunner.manager.findOne(Receipt, {
          where: { barcode: updateReceiptDto.barcode },
        });

    if (!receipt) throw new NotFoundException("Receipt not found");
    if (receipt.status === "PAID") throw new BadRequestException("Receipt already paid");

    const argentinaTime = dayjs().tz("America/Argentina/Buenos_Aires").startOf("day");
    const now = argentinaTime.format("YYYY-MM-DD");

    const tz = "America/Argentina/Buenos_Aires";
    // ✅ robusto: siempre toma el mes del receipt como YYYY-MM y construye el límite
    const privateReceiptMonth = dayjs(receipt.startDate).format("YYYY-MM"); // sin tz
    const privateNextMonthStartStr = dayjs(`${privateReceiptMonth}-01`)
      .add(1, "month")
      .format("YYYY-MM-DD");


    logPrivate(customer, "Fechas / límites", {
      now,
      privateReceiptStartDate: receipt.startDate,
      privateNextMonthStartStr,
      privateReceiptMonth: String(receipt.startDate).slice(0, 7),
    });

    // =========================================================
    // 🧭 Buscar recibos pendientes del OWNER si el customer es PRIVATE
    // =========================================================
    let ownerPendingReceiptsToAutoPay: Receipt[] = [];
    let ownerToLink: Customer | null = null;

    if (customer.customerType === "PRIVATE") {
      const receiptWithRelations = await queryRunner.manager.findOne(Receipt, {
        where: { id: receipt.id },
        relations: [
          "customer",
          "customer.parkingRenters",
          "customer.parkingRenters.parkingOwner",
          "customer.parkingRenters.parkingOwner.customer",
        ],
      });

      const owner = receiptWithRelations?.customer?.parkingRenters?.[0]?.parkingOwner?.customer;
      ownerToLink = owner ?? null;

      logPrivate(customer, "Owner relacionado detectado", {
        ownerId: owner?.id ?? null,
        ownerName: owner ? `${owner.lastName ?? ""} ${owner.firstName ?? ""}`.trim() : null,
      });

      if (owner) {
        const ownerPendings = await queryRunner.manager.find(Receipt, {
          where: {
            customer: { id: owner.id },
            status: "PENDING",
            startDate: Raw((alias) => `${alias} < :limit`, { limit: privateNextMonthStartStr }),
          },
          order: { startDate: "ASC" },
          take: 2,
        });

        ownerPendingReceiptsToAutoPay = ownerPendings ?? [];

        logPrivate(customer, "Owner pendings filtrados para autopago", {
          count: ownerPendingReceiptsToAutoPay.length,
          months: ownerPendingReceiptsToAutoPay.map(r => String(r.startDate).slice(0, 7)),
        });
      }
    }

    // =========================================================
    // 🧾 PAGOS MANUALES (efectivo / crédito)
    // =========================================================
    if (updateReceiptDto.onAccount === false) {
      logPrivate(customer, "Ruta: PAGOS MANUALES", {
        payments: (updateReceiptDto.payments ?? []).map(p => ({
          type: p.paymentType,
          price: p.price ?? 0,
        })),
      });

      const totalWithoutCredit = updateReceiptDto.payments
        .filter((p) => p.paymentType !== "CREDIT")
        .reduce((sum, p) => sum + (p.price ?? 0), 0);

      const creditToUse = updateReceiptDto.payments.some((p) => p.paymentType === "CREDIT")
        ? Math.min(customer.credit ?? 0, receipt.price)
        : 0;

      const totalToPay = totalWithoutCredit + creditToUse;
      if (totalToPay > receipt.price) {
        throw new BadRequestException("La suma de los montos no puede superar el total del recibo.");
      }

      const privateHasFIX = updateReceiptDto.payments.some((p) => p.paymentType === "FIX");

      logPrivate(customer, "Totales manuales", {
        totalWithoutCredit,
        creditToUse,
        totalToPay,
        privateHasFIX,
        receiptPriceBefore: receipt.price,
      });

      let sharedBoxList: BoxList | null = null;
      if (!privateHasFIX) {
        sharedBoxList = await this.boxListsService.findBoxByDate(now, queryRunner.manager);
        if (!sharedBoxList) {
          sharedBoxList = await this.boxListsService.createBox({
            date: now,
            totalPrice: 0,
          });
        }
      }

      logPrivate(customer, "BoxList compartida", {
        sharedBoxListId: sharedBoxList?.id ?? null,
      });

      const privatePaymentsCreatedForCompensation: ReceiptPayment[] = [];

      for (const payment of updateReceiptDto.payments) {
        if (payment.paymentType === "CREDIT") {
          // ... (sin cambios)
          const creditToApply = Math.min(customer.credit ?? 0, receipt.price);
          if (creditToApply <= 0) {
            throw new BadRequestException("El cliente no tiene crédito disponible.");
          }

          const newCredit = customer.credit - creditToApply;
          const newReceiptPrice = receipt.price - creditToApply;

          let boxList = await this.boxListsService.findBoxByDate(now, queryRunner.manager);
          if (!boxList) {
            boxList = await this.boxListsService.createBox({
              date: now,
              totalPrice: 0,
            });
          }

          const creditPayment = this.receiptPaymentRepository.create({
            paymentType: "CREDIT" as any,
            price: creditToApply,
            paymentDate: now,
            receipt,
            boxList: { id: boxList.id } as BoxList,
            numberInBox: creditToApply,
          });

          await this.receiptPaymentRepository.save(creditPayment);
          await queryRunner.manager.update(Customer, { id: customer.id }, { credit: newCredit });

          receipt.price = newReceiptPrice;
          if (newReceiptPrice === 0) {
            receipt.status = "PAID";
            receipt.paymentDate = now;
          }

          logPrivate(customer, "Aplicó CREDIT", {
            creditToApply,
            newCredit,
            receiptPriceAfter: receipt.price,
            receiptStatus: receipt.status,
          });

          continue;
        }

        const total = payment.price ?? 0;

        let boxListForThisPayment: BoxList | null = null;

        if (payment.paymentType !== "FIX") {
          boxListForThisPayment = sharedBoxList
            ? sharedBoxList
            : await this.boxListsService.findBoxByDate(now, queryRunner.manager);

          if (!boxListForThisPayment) {
            boxListForThisPayment = await this.boxListsService.createBox({
              date: now,
              totalPrice: shouldAffectBox(payment.paymentType) ? total : 0,
            });
          } else {
            if (shouldAffectBox(payment.paymentType)) {
              boxListForThisPayment.totalPrice += total;
              await this.boxListsService.updateBox(
                boxListForThisPayment.id,
                { totalPrice: boxListForThisPayment.totalPrice },
                queryRunner.manager
              );
            }
          }

          if (!sharedBoxList) sharedBoxList = boxListForThisPayment;
        }

        const newPayment = this.receiptPaymentRepository.create({
          paymentType: payment.paymentType,
          price: total,
          paymentDate: now,
          receipt,
          boxList: boxListForThisPayment ? ({ id: boxListForThisPayment.id } as BoxList) : null,
          numberInBox: payment.paymentType === "FIX" ? null : total,
        });

        const saved = await this.receiptPaymentRepository.save(newPayment);

        if (payment.paymentType !== "FIX") {
          privatePaymentsCreatedForCompensation.push(saved);
        }

        receipt.price -= total;
        if (receipt.price <= 0) {
          receipt.status = "PAID";
          receipt.paymentDate = now;
        }

        logPrivate(customer, "Creó pago normal", {
          type: payment.paymentType,
          total,
          savedPaymentId: saved.id,
          receiptPriceAfter: receipt.price,
          receiptStatus: receipt.status,
        });
      }

      if (customer.customerType === "PRIVATE") {
        logPrivate(customer, "Previo a compensación PRIVATE->OWNER", {
          privatePaymentsCreatedCount: privatePaymentsCreatedForCompensation.length,
          ownerPendingsCount: ownerPendingReceiptsToAutoPay.length,
        });
      }

      if (customer.customerType === "PRIVATE" && ownerPendingReceiptsToAutoPay.length > 0) {
        const privatePaidInCash = updateReceiptDto.payments.some((p) => p.paymentType === "CASH");
        const paymentTypeForOwner = privatePaidInCash ? "MIX" : "TP";

        await applyPrivateOwnerCompensation({
          now,
          privateHasFIX,
          sharedBoxList,
          privatePaymentsCreated: privatePaymentsCreatedForCompensation,
          ownerPendingReceipts: ownerPendingReceiptsToAutoPay,
          paymentTypeForOwner,

          customer,
          ownerId: ownerToLink?.id ?? null,
        });
      }
    } else {
      // =========================================================
      // 🧾 PAGOS A CUENTA (sin cambios)
      // =========================================================
      logPrivate(customer, "Ruta: PAGOS A CUENTA", {
        payments: (updateReceiptDto.payments ?? []).map(p => ({
          type: p.paymentType,
          price: p.price ?? 0,
        })),
      });

      const totalOnAccount = updateReceiptDto.payments.reduce((sum, p) => sum + (p.price ?? 0), 0);

      if (totalOnAccount <= 0) {
        throw new BadRequestException("El monto a cuenta debe ser mayor a 0.");
      }

      if (totalOnAccount > receipt.price) {
        throw new BadRequestException("El monto a cuenta no puede superar el saldo del recibo.");
      }

      if (customer.customerType === "PRIVATE" && ownerToLink) {
        const ownerAllPendings = await queryRunner.manager.find(Receipt, {
          where: { customer: { id: ownerToLink.id }, status: "PENDING" },
          order: { startDate: "ASC" },
        });

        logPrivate(customer, "Owner pendings (a cuenta) encontrados", {
          count: ownerAllPendings.length,
          months: ownerAllPendings.map(r => String(r.startDate).slice(0, 7)),
          totalOnAccount,
        });

        let remaining = totalOnAccount;

        for (const r of ownerAllPendings) {
          if (remaining <= 0) break;

          const apply = Math.min(r.price, remaining);
          r.price -= apply;
          remaining -= apply;

          if (r.price <= 0) {
            r.price = 0;
            r.status = "PAID";
            r.paymentDate = now;
          }

          await queryRunner.manager.save(r);

          logPrivate(customer, "Aplicó a cuenta al OWNER", {
            ownerReceiptId: r.id,
            month: String(r.startDate).slice(0, 7),
            apply,
            remaining,
            newStatus: r.status,
            newPrice: r.price,
          });
        }
      }

      for (const payment of updateReceiptDto.payments) {
        const total = payment.price ?? 0;

        let boxList: BoxList | null = null;

        if (payment.paymentType !== "FIX") {
          boxList = await this.boxListsService.findBoxByDate(now, queryRunner.manager);

          if (!boxList) {
            boxList = await this.boxListsService.createBox({
              date: now,
              totalPrice: shouldAffectBox(payment.paymentType) ? total : 0,
            });
          } else {
            if (shouldAffectBox(payment.paymentType)) {
              boxList.totalPrice += total;
              await this.boxListsService.updateBox(
                boxList.id,
                { totalPrice: boxList.totalPrice },
                queryRunner.manager
              );
            }
          }
        }

        const paymentOnAccount = this.receiptPaymentRepository.create({
          paymentType: payment.paymentType,
          price: total,
          paymentDate: now,
          receipt,
          boxList: boxList ? ({ id: boxList.id } as BoxList) : null,
          numberInBox: payment.paymentType === "FIX" ? null : total,
        });

        await this.receiptPaymentRepository.save(paymentOnAccount);
      }

      if (totalOnAccount < receipt.price) {
        receipt.price -= totalOnAccount;
      }
    }

    // =========================================================
    // 🪙 2. Actualizar deuda mensual (sin cambios)
    // =========================================================
    if (customer.monthsDebt && Array.isArray(customer.monthsDebt)) {
      const receiptMonth = receipt.startDate.slice(0, 7);
      const newMonthsDebt = customer.monthsDebt.map((debt) => {
        const debtMonth = debt.month.slice(0, 7);
        if (debtMonth === receiptMonth && receipt.status === "PAID") {
          return { ...debt, status: "PAID" };
        }
        return debt;
      });

      const unpaidMonths = newMonthsDebt.filter((debt) => {
        const debtMonth = debt.month.slice(0, 7);
        const hasPaidReceipt =
          debt.status === "PAID" ||
          customer.receipts?.some(
            (r) => r.startDate.slice(0, 7) === debtMonth && r.status === "PAID"
          );
        return !hasPaidReceipt;
      });

      const hasDebt = unpaidMonths.length > 0;

      await queryRunner.manager.update(Customer, { id: customer.id }, {
        monthsDebt: newMonthsDebt as any,
        hasDebt,
      });
    }

    // =========================================================
    // 💾 3. Guardar recibo final
    // =========================================================
    await queryRunner.manager.update(
      Receipt,
      { id: receipt.id },
      {
        price: receipt.price,
        status: receipt.status,
        paymentDate: receipt.paymentDate,
      }
    );

    logPrivate(customer, "Final updateReceipt() OK", {
      finalReceiptPrice: receipt.price,
      finalReceiptStatus: receipt.status,
    });

    await queryRunner.commitTransaction();
    return receipt;
  } catch (error: any) {
    await queryRunner.rollbackTransaction();
    if (!(error instanceof NotFoundException)) {
      this.logger.error(error.message, error.stack);
    }
    throw error;
  } finally {
    await queryRunner.release();
  }
}



async cancelReceipt(receiptId: string, customerId: string) {
  const queryRunner = this.dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();

  try {
    const customerRepo = queryRunner.manager.getRepository(Customer);
    const receiptRepo = queryRunner.manager.getRepository(Receipt);
    const receiptPaymentRepo = queryRunner.manager.getRepository(ReceiptPayment);
    const paymentHistoryRepo = queryRunner.manager.getRepository(PaymentHistoryOnAccount);

    console.log("🚀 [cancelReceipt] Inicio", { receiptId, customerId });

    const customer = await customerRepo.findOne({
      where: { id: customerId },
      relations: [
        "receipts",
        "parkingRenters",
        "parkingRenters.parkingOwner",
        "parkingRenters.parkingOwner.customer",
        "parkingRenters.parkingOwner.customer.receipts",
        "parkingRenters.parkingOwner.customer.receipts.payments",
        "parkingOwners",
        "parkingOwners.parkingRenters",
      ],
    });

    if (!customer) throw new NotFoundException("Customer not found");


    const lastPaidReceipt = await queryRunner.manager.findOne(Receipt, {
      where: { id: receiptId },
      relations: ["payments", "paymentHistoryOnAccount"],
    });

    // ✅ Regla: OWNER no puede cancelar si tiene inquilino relacionado
    if (customer.customerType === "OWNER") {
      const hasRenterRelated = (customer.parkingOwners ?? []).some((v) => {
        return (v.parkingRenters ?? []).length > 0;
      });

      if (hasRenterRelated && lastPaidReceipt.paymentType === 'MIX') {
        throw new BadRequestException(
          "No se puede cancelar porque tiene un inquilino relacionado",
        );
      }
    }

    if (!lastPaidReceipt) throw new NotFoundException("Receipt not found");

    // ✅ guardamos la fecha antes de resetear (la usamos para buscar los pagos del owner)
    const receiptDate = lastPaidReceipt.paymentDate;
    if (!receiptDate) {
      throw new BadRequestException("El recibo no tiene paymentDate, no se puede cancelar.");
    }

    let boxList = await this.boxListsService.findBoxByDate(receiptDate, queryRunner.manager);
    if (!boxList) throw new NotFoundException("Box list not found");

    // =========================================================
    // 💳 1) Revertir pagos del recibo actual
    //    - CREDIT → vuelve a crédito del cliente
    //    - CASH  → resta en caja
    // =========================================================
    let creditToRefund = 0;

    for (const payment of lastPaidReceipt.payments ?? []) {
      if (payment.paymentType === "CREDIT") {
        creditToRefund += payment.price ?? 0;
      }

      // ✅ solo EF impacta en caja
      if (payment.paymentType === "CASH") {
        boxList.totalPrice -= payment.price ?? 0;
        await this.boxListsService.updateBox(
          boxList.id,
          { totalPrice: boxList.totalPrice },
          queryRunner.manager,
        );
      }
    }

    for (const historyPayment of lastPaidReceipt.paymentHistoryOnAccount ?? []) {
      if (historyPayment.paymentType === "CREDIT") {
        creditToRefund += historyPayment.price ?? 0;
      }

      // ✅ solo EF impacta en caja
      if (historyPayment.paymentType === "CASH") {
        boxList.totalPrice -= historyPayment.price ?? 0;
        await this.boxListsService.updateBox(
          boxList.id,
          { totalPrice: boxList.totalPrice },
          queryRunner.manager,
        );
      }
    }

    // =========================================================
    // 💰 2) Reintegrar crédito al cliente si aplica
    // =========================================================
    if (creditToRefund > 0) {
      const newCredit = (customer.credit ?? 0) + creditToRefund;
      await queryRunner.manager.update(Customer, { id: customer.id }, { credit: newCredit });
    }

    // =========================================================
    // 🧾 3) Resetear recibo actual (PRIVATE u OWNER)
    // =========================================================
    lastPaidReceipt.status = "PENDING";
    lastPaidReceipt.paymentDate = null;
    lastPaidReceipt.paymentType = null;
    lastPaidReceipt.price = lastPaidReceipt.startAmount;

    await receiptRepo.save(lastPaidReceipt);
    await receiptPaymentRepo.remove(lastPaidReceipt.payments ?? []);
    await paymentHistoryRepo.remove(lastPaidReceipt.paymentHistoryOnAccount ?? []);

    // =========================================================
    // 🧍‍♂️ 4) Si el CUSTOMER es PRIVATE → cancelar también los pagos AUTO del OWNER
    //    Regla nueva:
    //    - Cancelar el/los pagos del owner con paymentDate === receiptDate
    //    - Para evitar pagos manuales del owner, cancelamos solo MIX / TP (auto-pagos)
    //    - Si se pagaron 2 recibos del owner ese día, se cancelan los 2.
    // =========================================================
    if (customer.customerType === "PRIVATE") {
      const owner = customer.parkingRenters?.[0]?.parkingOwner?.customer;

      if (owner) {
        const ownerPaymentsSameDate = await receiptPaymentRepo.find({
          where: {
            receipt: { customer: { id: owner.id } },
            paymentDate: receiptDate,
          },
          relations: ["receipt"],
          order: { paymentDate: "DESC" as const },
        });

        // ✅ solo los auto-pagos que creaste desde PRIVATE
        const ownerAutoPaymentsToCancel = ownerPaymentsSameDate.filter(
          (p) => p.paymentType === "MIX" || p.paymentType === "TP",
        );

        for (const p of ownerAutoPaymentsToCancel) {
          const ownerReceipt = p.receipt;

          // (MIX/TP no impacta caja según tu lógica, así que no tocamos boxList)
          await receiptPaymentRepo.remove(p);

          // si no quedan pagos, dejar el recibo del owner en PENDING
          const remaining = await receiptPaymentRepo.count({
            where: { receipt: { id: ownerReceipt.id } },
          });

          if (remaining === 0) {
            ownerReceipt.status = "PENDING";
            ownerReceipt.paymentDate = null;
            ownerReceipt.paymentType = null;
            ownerReceipt.price = ownerReceipt.startAmount;

            await receiptRepo.save(ownerReceipt);
          }
        }
      }
    }

    // =========================================================
    // ✅ Commit final
    // =========================================================
    await queryRunner.commitTransaction();
    console.log("✅ [cancelReceipt] Completado correctamente");

    return customer;
  } catch (error: any) {
    console.error("❌ [cancelReceipt] Error:", error);
    await queryRunner.rollbackTransaction();
    throw error;
  } finally {
    await queryRunner.release();
  }
}


async createReceiptMan(dateNowFront: string, customerType: CustomerType): Promise<Receipt[]> {
  const target = dayjs(dateNowFront);
  const targetMonthString = target.format('YYYY-MM');

  const qr = this.dataSource.createQueryRunner();
  await qr.connect();
  await qr.startTransaction();

  const createdReceipts: Receipt[] = [];

  try {
    this.logger.log(`Generando recibos para ${target.format('MM/YYYY')}`);

    const customers = await qr.manager.find(Customer, {
      where: { customerType: customerType },
      relations: ['receipts', 'parkingOwners', 'parkingRenters'],
    });

    for (const customer of customers) {
      const exists = customer.receipts.some(r => {
        if (!r.dateNow) return false;
        return dayjs(r.dateNow).format('YYYY-MM') === targetMonthString;
      });

      if (exists) {
        this.logger.debug(`Cliente ${customer.id} ya tiene recibo en ${targetMonthString}, se salta.`);
        continue;
      }

      const totalVehicleAmount =
        customer.customerType === 'OWNER'
          ? customer.parkingOwners.reduce((acc, v) => acc + (v.amount || 0), 0)
          : customer.parkingRenters.reduce((acc, vr) => acc + (vr.amount || 0), 0);

      let shouldCreateReceipt = true;
      if (customer.customerType !== 'OWNER') {
        shouldCreateReceipt = customer.parkingRenters?.every(vr => vr.owner !== '');
      }

      if (shouldCreateReceipt) {
        const newReceipt = await this.createReceipt(customer.id, qr.manager, totalVehicleAmount, dateNowFront);
        createdReceipts.push(newReceipt);
      }
    }

    await qr.commitTransaction();
    this.logger.log('Recibos del mes finalizados correctamente');

    return createdReceipts;
  } catch (err: any) {
    await qr.rollbackTransaction();
    this.logger.error('Error en generación manual de recibos', err.stack);
    throw err;
  } finally {
    await qr.release();
  }
}


// @Cron('* * * * *', { timeZone: 'America/Argentina/Buenos_Aires' })
// async createReceiptAutm() {
//   const queryRunner = this.dataSource.createQueryRunner();
//   await queryRunner.connect();
//   await queryRunner.startTransaction();  // ← inicia la transacción aquí
//   try {
//     this.logger.log('Ejecutando cron updateInterests...');
//     const customers = await this.customerRepository.find({
//       relations: ['receipts','vehicles','vehicleRenters','vehicleRenters.vehicle'],
//     });

//     for (const customer of customers) {
//       // calcular monto...
//       const totalVehicleAmount =
//         customer.customerType === 'OWNER'
//           ? customer.vehicles.reduce((acc, v) => acc + (v.amount || 0), 0)
//           : customer.vehicleRenters.reduce((acc, vr) => acc + (vr.amount || 0), 0);

//       let shouldCreateReceipt = true;
//       if (customer.customerType !== 'OWNER') {
//         shouldCreateReceipt = customer.vehicleRenters?.every(vr => vr.owner !== '');
//       }

//       if (shouldCreateReceipt) {
//         await this.createReceipt(customer.id, queryRunner.manager, totalVehicleAmount);
//       }
//     }

//     // ⬇️ Un único commit al final, fuera del for
//     await queryRunner.commitTransaction();
//     this.logger.log('updateInterests: transacción confirmada');
//   } catch (error: any) {
//     // rollback en caso de cualquier fallo
//     await queryRunner.rollbackTransaction();
//     this.logger.error('Error al actualizar intereses', error.stack);
//   } finally {
//     await queryRunner.release();
//   }
// }



    async findAllPendingReceipts(customerType: CustomerType) {
      try {
        const customers = await this.customerRepository.find({
          where: { customerType: customerType },
          relations: ['receipts'],
          withDeleted: true
        });
    
        // Array para almacenar los recibos pendientes de todos los clientes
        const pendingReceipts = [];
    
        for (const customer of customers) {
          const receipts = customer.receipts.sort(
            (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
          );
    
          // Filtrar solo los recibos con estado 'PENDING'
          const customerPendingReceipts = receipts.filter(
            (receipt) => receipt.status === 'PENDING'
          );
    
          // Agregar los recibos pendientes al array general
          pendingReceipts.push(...customerPendingReceipts);
        }
    
        return pendingReceipts;
      } catch (error: any) {
        if (!(error instanceof NotFoundException)) {
          this.logger.error(error.message, error.stack);
        }
        throw error;
      }
    }

    async getBarcodeReceipt(barcode: string, manager: EntityManager):Promise<Receipt>{

      try{
        const receipt = await manager.findOne(Receipt, {
          where: { barcode },
          relations: ['customer', 'paymentHistoryOnAccount'],
        });

        if (!receipt) {
          this.logger.warn(`No se encontró el recibo con el código de barras: ${barcode}`);
          return null;
        }

        if (receipt.status === 'PAID') {
          throw new BadRequestException('El recibo ya fue pagado');
        }

        return receipt;
      } catch (error: any) {
        if (!(error instanceof NotFoundException)) {
          this.logger.error(error.message, error.stack);
        }
        throw error;
      }
    }

    async findReceipts(){
      try{
        const receipts = await this.receiptRepository.find({relations: ['payments', 'customer','customer.parkingRenters', 'customer.parkingRenters.parkingOwner', 'customer.parkingRenters.parkingOwner.customer']})

        return receipts;
      } catch (error: any) {
        if (!(error instanceof NotFoundException)) {
          this.logger.error(error.message, error.stack);
        }
        throw error;
      }
    }

    async getReceiptsSummary(from?: string, to?: string) {
      try {
        const argentinaNow = dayjs().tz('America/Argentina/Buenos_Aires');
        const rangeFrom = from ?? argentinaNow.startOf('month').format('YYYY-MM-DD');
        const rangeTo = to ?? argentinaNow.format('YYYY-MM-DD');

        const byStatusRows = await this.receiptRepository
          .createQueryBuilder('receipt')
          .select('receipt.status', 'status')
          .addSelect('COUNT(*)', 'count')
          .addSelect('SUM(receipt.price)', 'total')
          .where('receipt.dateNow BETWEEN :from AND :to', { from: rangeFrom, to: rangeTo })
          .groupBy('receipt.status')
          .getRawMany();

        // La forma de pago real vive en ReceiptPayment (un recibo puede tener varios
        // pagos parciales con distinto medio) — Receipt.paymentType casi nunca se completa.
        const byPaymentTypeRows = await this.receiptPaymentRepository
          .createQueryBuilder('rp')
          .select('rp.paymentType', 'paymentType')
          .addSelect('COUNT(*)', 'count')
          .addSelect('SUM(rp.price)', 'total')
          .where('rp.paymentDate BETWEEN :from AND :to', { from: rangeFrom, to: rangeTo })
          .andWhere('rp.paymentType IS NOT NULL')
          .groupBy('rp.paymentType')
          .getRawMany();

        // Los cobros de tickets (por código de barras o por patente, anticipo o saldo) no pasan
        // por Receipt/ReceiptPayment — quedan en Movimiento. Sin esto, "tipos de pago más
        // usados" solo reflejaba recibos y ocultaba todo el efectivo/transferencia de la caja
        // diaria de tickets. metodo usa los mismos valores CASH/TRANSFER que ReceiptPayment, así
        // que se puede sumar directo a los mismos buckets.
        const byMovimientoRows = await this.movimientoRepository
          .createQueryBuilder('m')
          .select('m.metodo', 'paymentType')
          .addSelect('COUNT(*)', 'count')
          .addSelect('SUM(m.monto)', 'total')
          .where(
            `(m."fechaHora" AT TIME ZONE 'America/Argentina/Buenos_Aires')::date BETWEEN :from AND :to`,
            { from: rangeFrom, to: rangeTo },
          )
          .groupBy('m.metodo')
          .getRawMany();

        const byPaymentTypeMap = new Map<string, { count: number; total: number }>();
        for (const r of byPaymentTypeRows) {
          byPaymentTypeMap.set(r.paymentType as string, { count: Number(r.count), total: Number(r.total) });
        }
        for (const r of byMovimientoRows) {
          const key = r.paymentType as string;
          const existing = byPaymentTypeMap.get(key) ?? { count: 0, total: 0 };
          byPaymentTypeMap.set(key, {
            count: existing.count + Number(r.count),
            total: existing.total + Number(r.total),
          });
        }

        return {
          from: rangeFrom,
          to: rangeTo,
          byStatus: byStatusRows.map((r) => ({ status: r.status as string, count: Number(r.count), total: Number(r.total) })),
          byPaymentType: Array.from(byPaymentTypeMap.entries()).map(([paymentType, v]) => ({
            paymentType,
            count: v.count,
            total: v.total,
          })),
        };
      } catch (error: any) {
        this.logger.error(error.message, error.stack);
        throw error;
      }
    }

    async deleteReceipt(receiptId: string) {
      try {
        const receipt = await this.receiptRepository.findOne({
          where: { id: receiptId },
          relations: ['customer'],
        });

        if (!receipt) {
          throw new NotFoundException(`Receipt with id ${receiptId} not found`);
        }

        if(receipt.status === 'PAID'){
          throw new BadRequestException({
            code: 'RECEIPT_ALREADY_PAID_FOR_DELETE',
            message: `El recibo ya esta pagado, por favor cancele el recibo antes de eliminarlo`,
          });
        }

        const customer = receipt.customer;

        if (customer.monthsDebt && Array.isArray(customer.monthsDebt)) {
          const receiptMonth = receipt.startDate.slice(0, 7);

          customer.monthsDebt = customer.monthsDebt.filter((debt) => {
            const debtMonth = debt.month.slice(0, 7); 
            return debtMonth !== receiptMonth;
          });

          if(customer.monthsDebt.length === 0){
            customer.hasDebt = false;
          }

          await this.customerRepository.save(customer);
        }

        await this.receiptRepository.remove(receipt); 

        return { message: 'Recibo eliminado correctamente' };
      } catch (error: any) {
        if (!(error instanceof NotFoundException)) {
          this.logger.error(error.message, error.stack);
        }
        throw error;
      }
    }

}