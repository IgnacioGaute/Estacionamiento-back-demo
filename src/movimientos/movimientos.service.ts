import { publishAutomaticNote } from 'src/notes/automatic-note';
import { operationContext, operationNow } from 'src/common/operation-context';
import { externalPayment, paymentShift } from 'src/turnos/turno-book';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Movimiento } from './entities/movimiento.entity';
import { CreateMovimientoDto } from './dto/create-movimiento.dto';
import { TurnosService } from 'src/turnos/turnos.service';
import { exigirCobro } from 'src/tenancy/modalidad';

@Injectable()
export class MovimientosService {
  private readonly logger = new Logger(MovimientosService.name);

  constructor(
    @InjectRepository(Movimiento)
    private readonly movimientoRepository: Repository<Movimiento>,
    private readonly turnosService: TurnosService,
  ) {}

  // Único punto de entrada para crear movimientos — todo lo demás (cierre de ticket, anticipo,
  // ajustes) pasa por acá, así el motivo obligatorio de AJUSTE/CORTESIA se valida en un solo
  // lugar en vez de repetirse en cada llamador.
  //
  // El requisito de turno abierto está desactivado por ahora (a pedido) — si el usuario tiene
  // uno abierto se lo asocia igual, si no, el movimiento se crea sin turno (turno: null) en
  // vez de bloquear el cobro. Para retomar la exigencia, volver a llamar
  // turnosService.getOpenTurno (que tira NO_OPEN_TURNO) en vez de findOpenTurnoOrNull.
  async create(dto: CreateMovimientoDto & { usuarioId: string }, manager?: EntityManager, turnoIdOverride?: string | null, occurredAt?: Date): Promise<Movimiento> {
    if (operationContext.getStore()) occurredAt ??= operationNow();
    if ((dto.tipo === 'AJUSTE' || dto.tipo === 'CORTESIA' || dto.tipo === 'DESCUENTO') && !dto.motivo?.trim()) {
      throw new BadRequestException('El motivo es obligatorio para un ajuste o un descuento.');
    }

    if (dto.motivo?.trim() && !manager) {
      return this.movimientoRepository.manager.transaction(m => this.create(dto, m, turnoIdOverride, occurredAt));
    }
    // Una playa gratuita no registra cobros, anticipos, cortesías, descuentos ni ajustes.
    if (manager) await exigirCobro(manager);
    const turno = turnoIdOverride === undefined ? (manager && externalPayment.getStore() ? await paymentShift(manager, dto.usuarioId) : await this.turnosService.findOpenTurnoOrNull(dto.usuarioId, manager)) : null;
    const repository = manager ? manager.getRepository(Movimiento) : this.movimientoRepository;

    const movimiento = repository.create({
      ticketRegistration: dto.ticketRegistrationId ? ({ id: dto.ticketRegistrationId } as any) : null,
      monto: dto.monto,
      ...(occurredAt ? { fechaHora: occurredAt } : {}),
      metodo: dto.metodo,
      tipo: dto.tipo,
      usuario: { id: dto.usuarioId } as any,
      turno: turnoIdOverride === undefined
        ? (turno ? ({ id: turno.id } as any) : null)
        : (turnoIdOverride ? ({ id: turnoIdOverride } as any) : null),
      referencia: dto.referencia ?? null,
      motivo: dto.motivo ?? null,
    });

    const saved = await repository.save(movimiento);
    if (dto.motivo?.trim()) {
      const registration = dto.ticketRegistrationId ? await manager!.query('SELECT "licensePlateOriginal", "codeBarTicket" FROM ticket_registrations WHERE id = $1', [dto.ticketRegistrationId]) : [];
      await publishAutomaticNote(manager!, { sourceKey: `movimiento:${saved.id}`, origin: dto.tipo === 'DESCUENTO' || dto.tipo === 'CORTESIA' ? 'Descuento de vehículo' : 'Corrección de cobro', sourceType: 'TICKET', sourceId: dto.ticketRegistrationId ?? saved.id, usuarioId: dto.usuarioId, description: dto.motivo, context: `${registration[0]?.licensePlateOriginal || registration[0]?.codeBarTicket || 'Vehículo'} · $ ${Math.abs(dto.monto).toLocaleString('es-AR')}` });
    }
    return saved;
  }

  async findByRegistration(ticketRegistrationId: string): Promise<Movimiento[]> {
    return this.movimientoRepository.find({
      where: { ticketRegistration: { id: ticketRegistrationId } },
      relations: ['usuario'],
      order: { sequence: 'ASC' },
    });
  }

  async sumByRegistration(ticketRegistrationId: string, manager?: EntityManager): Promise<number> {
    const repository = manager ? manager.getRepository(Movimiento) : this.movimientoRepository;
    const movimientos = await repository.find({ where: { ticketRegistration: { id: ticketRegistrationId } } });
    return movimientos.reduce((total, m) => total + ((m.tipo === 'CORTESIA' || m.tipo === 'DESCUENTO') ? 0 : m.monto), 0);
  }
}
