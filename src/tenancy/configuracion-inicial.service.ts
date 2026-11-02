import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { tenantContext } from './tenant-context';
import { aplicarAvance, type AvanceConfiguracion, type ConfiguracionInicial } from './configuracion-inicial';
import type { GuardarPlayaConfiguracionDto } from './dto/configuracion-inicial.dto';

type PlayaConfiguracion = { id: string; nombre: string; direccion: string | null; configuracionInicial: ConfiguracionInicial };

// El recorrido de una playa nueva, visto por su administrador (ver configuracion-inicial.ts).
@Injectable()
export class ConfiguracionInicialService {
  constructor(private readonly dataSource: DataSource) {}

  private scope() {
    const scope = tenantContext.getStore();
    if (!scope?.empresaId || !scope.playaId) throw new BadRequestException('Elegí una playa para continuar.');
    return scope;
  }

  async estado() {
    const { playaId } = this.scope();
    const [playa] = await this.dataSource.query(`SELECT id, nombre, direccion, "configuracionInicial" FROM playas WHERE id = $1`, [playaId]);
    if (!playa) throw new NotFoundException('Playa no encontrada.');
    return this.respuesta(playa);
  }

  guardarPlaya(dto: GuardarPlayaConfiguracionDto) {
    if (dto.nombre === undefined && dto.direccion === undefined) throw new BadRequestException('No hay datos para guardar.');
    return this.cambiar((playa) => {
      let configuracion = playa.configuracionInicial;
      if (dto.nombre !== undefined) configuracion = aplicarAvance(configuracion, { hecho: 'nombre' }, new Date());
      if (dto.direccion !== undefined) configuracion = aplicarAvance(configuracion, { hecho: 'ubicacion' }, new Date());
      return { nombre: dto.nombre ?? playa.nombre, direccion: dto.direccion ?? playa.direccion, configuracionInicial: configuracion };
    });
  }

  avanzar(cambio: AvanceConfiguracion) {
    return this.cambiar((playa) => ({ ...playa, configuracionInicial: aplicarAvance(playa.configuracionInicial, cambio, new Date()) }));
  }

  /**
   * La playa es de la plataforma: el rol de la empresa solo la puede leer (RLS y grants de solo
   * lectura). Como en MiPlanController, la escritura corre fuera del scope y siempre sobre la playa
   * y la empresa de la sesión, que es lo único que decide qué fila se toca.
   */
  private cambiar(calcular: (playa: PlayaConfiguracion) => Omit<PlayaConfiguracion, 'id'>) {
    const { playaId, empresaId } = this.scope();
    return tenantContext.exit(() =>
      this.dataSource.transaction(async (manager: EntityManager) => {
        const [playa] = await manager.query(
          `SELECT id, nombre, direccion, "configuracionInicial" FROM playas WHERE id = $1 AND "empresaId" = $2 FOR UPDATE`,
          [playaId, empresaId],
        );
        if (!playa) throw new NotFoundException('Playa no encontrada.');
        const nuevo = calcular(playa);
        const [[guardada]] = await manager.query(
          `UPDATE playas SET nombre = $3, direccion = $4, "configuracionInicial" = $5::jsonb, "updatedAt" = now()
           WHERE id = $1 AND "empresaId" = $2 RETURNING id, nombre, direccion, "configuracionInicial"`,
          [playaId, empresaId, nuevo.nombre, nuevo.direccion, JSON.stringify(nuevo.configuracionInicial ?? {})],
        );
        return this.respuesta(guardada);
      }),
    );
  }

  private respuesta(playa: PlayaConfiguracion) {
    return {
      playa: { id: playa.id, nombre: playa.nombre, direccion: playa.direccion },
      configuracion: playa.configuracionInicial ?? {},
    };
  }
}
