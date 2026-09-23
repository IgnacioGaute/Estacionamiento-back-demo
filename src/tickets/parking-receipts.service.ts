import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { tenantContext } from '../tenancy/tenant-context';
import { Playa } from '../tenancy/entities/playa.entity';
import { ParkingReceipt } from './entities/parking-receipt.entity';
import { TicketRegistration } from './entities/ticket-registration.entity';
import { TicketRegistrationForDay } from './entities/ticket-registration-for-day.entity';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { TicketsService } from './tickets.service';
dayjs.extend(utc);
dayjs.extend(timezone);

@Injectable()
export class ParkingReceiptsService {
  constructor(
    private readonly ds: DataSource,
    private readonly tickets: TicketsService,
  ) {}

  async issue(registrationId: string, kind: 'ENTRY' | 'EXIT') {
    const scope = tenantContext.getStore();
    if (!scope) throw new UnauthorizedException();
    const { receiptDelivery } = await this.tickets.getSchedule();
    if (
      !receiptDelivery.whatsapp &&
      !receiptDelivery.qr &&
      !receiptDelivery.print
    ) {
      throw new BadRequestException(
        'Los medios de entrega están desactivados.',
      );
    }
    return this.ds.transaction(async (manager) => {
      const registration = await manager
        .getRepository(TicketRegistration)
        .findOne({
          where: { id: registrationId, playaId: scope.playaId },
        });
      const dayRegistration = registration
        ? null
        : await manager
            .getRepository(TicketRegistrationForDay)
            .findOneBy({ id: registrationId, playaId: scope.playaId });
      if (!registration && !dayRegistration)
        throw new NotFoundException('Registro no encontrado.');
      if (
        kind === 'EXIT' &&
        !(registration?.departureDay || dayRegistration?.retired)
      )
        throw new BadRequestException('Todavía no se registró la salida.');
      const playa = await manager
        .getRepository(Playa)
        .findOneByOrFail({ id: scope.playaId });
      const repository = manager.getRepository(ParkingReceipt);
      const where = { playaId: scope.playaId, registrationId, kind };
      // Serializa solicitudes repetidas sin generar enlaces distintos para el mismo evento.
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        registrationId + kind,
      ]);
      let receipt = await repository.findOneBy(where);
      const entry = dayRegistration
        ? dayjs(dayRegistration.createdAt).tz('America/Argentina/Buenos_Aires')
        : null;
      const departure = dayRegistration?.retiredAt
        ? dayjs(dayRegistration.retiredAt).tz('America/Argentina/Buenos_Aires')
        : null;
      if (!receipt)
        receipt = await repository.save(
          repository.create({
            ...where,
            token: randomBytes(32).toString('hex'),
            snapshot: {
              kind,
              parkingName: playa.nombre,
              address: playa.direccion,
              plate:
                registration?.licensePlateOriginal ||
                registration?.vehiclePlateCustomer ||
                registration?.codeBarTicket ||
                dayRegistration?.vehiclePlateCustomer ||
                'Sin patente',
              vehicleType:
                registration?.vehicleType || dayRegistration?.vehicleType || '',
              entryDay:
                registration?.entryDay ??
                dayRegistration?.dateNow ??
                entry?.format('YYYY-MM-DD') ??
                null,
              entryTime:
                registration?.entryTime ?? entry?.format('HH:mm:ss') ?? null,
              departureDay:
                kind === 'EXIT'
                  ? (registration?.departureDay ??
                    departure?.format('YYYY-MM-DD') ??
                    null)
                  : null,
              departureTime:
                kind === 'EXIT'
                  ? (registration?.departureTime ??
                    departure?.format('HH:mm:ss') ??
                    null)
                  : null,
              total:
                kind === 'EXIT'
                  ? (registration?.price ?? dayRegistration?.price ?? 0)
                  : null,
              collected:
                kind === 'EXIT'
                  ? registration
                    ? await this.tickets.collectedAmount(registration, manager)
                    : dayRegistration?.paid
                      ? dayRegistration.price
                      : 0
                  : null,
            },
          }),
        );
      return {
        token: receipt.token,
        snapshot: receipt.snapshot,
        settings: receiptDelivery,
        phoneCustomer: registration?.phoneCustomer ?? null,
      };
    });
  }

  async readPublic(token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new NotFoundException();
    // Única lectura pública: búsqueda exacta por secreto aleatorio, sin IDs ni listados.
    const receipt = await this.ds
      .getRepository(ParkingReceipt)
      .findOne({ where: { token }, select: { snapshot: true } });
    if (!receipt) throw new NotFoundException('Comprobante no encontrado.');
    return receipt.snapshot;
  }
}
