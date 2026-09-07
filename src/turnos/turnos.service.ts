import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Turno } from './entities/turno.entity';
import { Movimiento } from 'src/movimientos/entities/movimiento.entity';
import { OpenTurnoDto } from './dto/open-turno.dto';
import { CloseTurnoDto } from './dto/close-turno.dto';

@Injectable()
export class TurnosService {
  private readonly logger = new Logger(TurnosService.name);

  constructor(
    @InjectRepository(Turno)
    private readonly turnoRepository: Repository<Turno>,
    @InjectRepository(Movimiento)
    private readonly movimientoRepository: Repository<Movimiento>,
  ) {}

  // El turno abierto de ESE usuario puntual — no hay una única caja global del sistema,
  // puede haber varios operadores con su propio turno abierto al mismo tiempo.
  async findOpenTurnoOrNull(usuarioId: string): Promise<Turno | null> {
    return this.turnoRepository.findOne({
      where: { usuarioApertura: { id: usuarioId }, estado: 'ABIERTO' },
    });
  }

  async getOpenTurno(usuarioId: string): Promise<Turno> {
    const turno = await this.findOpenTurnoOrNull(usuarioId);
    if (!turno) {
      throw new NotFoundException({
        code: 'NO_OPEN_TURNO',
        message: 'No tenés un turno de caja abierto. Abrí uno antes de registrar un cobro.',
      });
    }
    return turno;
  }

  async open(usuarioId: string, dto: OpenTurnoDto): Promise<Turno> {
    const existing = await this.findOpenTurnoOrNull(usuarioId);
    if (existing) {
      throw new BadRequestException('Ya tenés un turno abierto.');
    }
    const turno = this.turnoRepository.create({
      usuarioApertura: { id: usuarioId } as any,
      fondoInicial: dto.fondoInicial,
      estado: 'ABIERTO',
    });
    return this.turnoRepository.save(turno);
  }

  async close(id: string, usuarioId: string, dto: CloseTurnoDto): Promise<Turno> {
    const turno = await this.turnoRepository.findOne({ where: { id } });
    if (!turno) {
      throw new NotFoundException('Turno no encontrado');
    }
    if (turno.estado === 'CERRADO') {
      throw new BadRequestException('Este turno ya está cerrado.');
    }

    const { sum } = await this.movimientoRepository
      .createQueryBuilder('m')
      .select('COALESCE(SUM(m.monto), 0)', 'sum')
      .where('m.turnoId = :turnoId', { turnoId: id })
      .andWhere('m.metodo = :metodo', { metodo: 'CASH' })
      .getRawOne<{ sum: string }>();

    const efectivoTeorico = turno.fondoInicial + Number(sum ?? 0);
    const diferencia = efectivoTeorico - dto.efectivoContado;

    turno.usuarioCierre = { id: usuarioId } as any;
    turno.fechaCierre = new Date();
    turno.efectivoContado = dto.efectivoContado;
    turno.efectivoTeorico = efectivoTeorico;
    turno.diferencia = diferencia;
    turno.observaciones = dto.observaciones ?? null;
    turno.estado = 'CERRADO';

    return this.turnoRepository.save(turno);
  }

  async findAll(estado?: 'ABIERTO' | 'CERRADO'): Promise<Turno[]> {
    return this.turnoRepository.find({
      where: estado ? { estado } : {},
      relations: ['usuarioApertura', 'usuarioCierre'],
      order: { fechaApertura: 'DESC' },
    });
  }
}
