import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Movimiento } from './entities/movimiento.entity';
import { CreateMovimientoDto } from './dto/create-movimiento.dto';
import { TurnosService } from 'src/turnos/turnos.service';

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
  async create(dto: CreateMovimientoDto & { usuarioId: string }): Promise<Movimiento> {
    if ((dto.tipo === 'AJUSTE' || dto.tipo === 'CORTESIA') && !dto.motivo?.trim()) {
      throw new BadRequestException('El motivo es obligatorio para un ajuste o una cortesía.');
    }

    const turno = await this.turnosService.findOpenTurnoOrNull(dto.usuarioId);

    const movimiento = this.movimientoRepository.create({
      ticketRegistration: dto.ticketRegistrationId ? ({ id: dto.ticketRegistrationId } as any) : null,
      monto: dto.monto,
      metodo: dto.metodo,
      tipo: dto.tipo,
      usuario: { id: dto.usuarioId } as any,
      turno: turno ? ({ id: turno.id } as any) : null,
      referencia: dto.referencia ?? null,
      motivo: dto.motivo ?? null,
    });

    return this.movimientoRepository.save(movimiento);
  }

  async findByRegistration(ticketRegistrationId: string): Promise<Movimiento[]> {
    return this.movimientoRepository.find({
      where: { ticketRegistration: { id: ticketRegistrationId } },
      relations: ['usuario'],
      order: { sequence: 'ASC' },
    });
  }

  async sumByRegistration(ticketRegistrationId: string): Promise<number> {
    const movimientos = await this.findByRegistration(ticketRegistrationId);
    return movimientos.reduce((total, m) => total + m.monto, 0);
  }
}
