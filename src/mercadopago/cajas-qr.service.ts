import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  CajaMercadoPago,
  DireccionCaja,
} from './entities/caja-mercadopago.entity';
import { CuentaMercadoPago } from './entities/cuenta-mercadopago.entity';
import { Playa } from 'src/tenancy/entities/playa.entity';
import { MercadoPagoService } from './mercadopago.service';
import { tenantContext } from 'src/tenancy/tenant-context';
import {
  DireccionMapa,
  calleYNumero,
  elegirCiudad,
  localidadesDelMapa,
  provinciasPosibles,
} from './ubicacion';

const API = 'https://api.mercadopago.com';
const TIEMPO_LIMITE_MS = 12_000;

// Identificadores propios para la sucursal y la caja de cada playa. MercadoPago los quiere
// alfanuméricos y únicos en la cuenta: el id de la playa sin guiones lo cumple y permite
// encontrarlas de nuevo si la creación se cortó a la mitad.
const idSucursal = (playaId: string) =>
  'PLAYA' + playaId.replace(/-/g, '').toUpperCase();
const idCaja = (playaId: string) =>
  'CAJA' + playaId.replace(/-/g, '').toUpperCase();

// MercadoPago valida la provincia y la ciudad de la sucursal contra el listado de ubicaciones de
// MercadoLibre (público, sin token): «Lujan de Cuyo» sin tilde lo rechaza, «Luján de Cuyo» no. Por
// eso se eligen de ese listado. Se guarda un día en memoria: cambia muy de vez en cuando.
const UBICACIONES = 'https://api.mercadolibre.com/classified_locations';
const UN_DIA_MS = 24 * 60 * 60 * 1000;
// El listado de Argentina incluye zonas de otros países para avisos clasificados: no son provincias.
const NO_SON_PROVINCIAS = new Set([
  'Brasil',
  'Chile',
  'República Dominicana',
  'USA',
  'Uruguay',
]);
const ubicaciones = new Map<
  string,
  { hasta: number; lista: { id: string; nombre: string }[] }
>();
const alfabetico = (a: { nombre: string }, b: { nombre: string }) =>
  a.nombre.localeCompare(b.nombre, 'es');

/** Para las pruebas: descarta el listado de ubicaciones guardado. */
export const olvidarUbicaciones = () => ubicaciones.clear();

/**
 * QR que se paga desde cualquier banco o billetera. MercadoPago lo da con su API de QR: cada
 * playa necesita una sucursal y una caja en la cuenta de la empresa, y cada cobro es una orden de
 * esa caja que devuelve el código estándar (`qr_data`). El link de pago de siempre, en cambio,
 * solo lo paga la app de MercadoPago o el navegador.
 *
 * Docs: https://www.mercadopago.com.ar/developers/en/docs/qr-code/create-store-and-pos y
 * https://www.mercadopago.com.ar/developers/es/docs/qr-code/payment-processing
 */
@Injectable()
export class CajasQrService {
  private readonly logger = new Logger(CajasQrService.name);

  constructor(
    @InjectRepository(CajaMercadoPago)
    private readonly cajas: Repository<CajaMercadoPago>,
    @InjectRepository(CuentaMercadoPago)
    private readonly cuentas: Repository<CuentaMercadoPago>,
    private readonly mercadoPago: MercadoPagoService,
    private readonly dataSource: DataSource,
  ) {}

  private empresaActual() {
    const empresaId = tenantContext.getStore()?.empresaId;
    if (!empresaId)
      throw new BadRequestException(
        'Esta acción es de una empresa: entrá como administrador de la empresa.',
      );
    return empresaId;
  }

  /** Las playas de la empresa y si ya tienen caja en la cuenta conectada (administrador). */
  async listar() {
    const empresaId = this.empresaActual();
    const cuenta = await this.cuentas.findOneBy({ empresaId });
    const playas = await this.dataSource
      .getRepository(Playa)
      .find({ where: { empresaId }, order: { nombre: 'ASC' } });
    const cajas =
      cuenta && cuenta.estado !== 'DESCONECTADA'
        ? await this.cajas.findBy({ empresaId, mpUserId: cuenta.mpUserId })
        : [];
    return {
      cuentaConectada: !!cuenta && cuenta.estado === 'ACTIVA',
      playas: playas.map((p) => {
        const caja = cajas.find((c) => c.playaId === p.id);
        return {
          playaId: p.id,
          nombre: p.nombre,
          direccion: p.direccion,
          caja: caja
            ? { creadaEl: caja.createdAt, direccion: caja.direccion }
            : null,
        };
      }),
    };
  }

  /**
   * Crea la sucursal y la caja de una playa en la cuenta conectada. Si alguna ya existía (un
   * intento anterior que se cortó), se reusa en vez de duplicarla.
   */
  async crear(playaId: string, direccion: DireccionCaja, usuarioId: string) {
    const empresaId = this.empresaActual();
    const cuenta = await this.cuentas.findOneBy({ empresaId });
    if (!cuenta || cuenta.estado !== 'ACTIVA')
      throw new BadRequestException(
        'Primero conectá la cuenta de MercadoPago.',
      );
    // Con el alcance de la empresa, una playa ajena no aparece.
    const playa = await this.dataSource
      .getRepository(Playa)
      .findOneBy({ id: playaId, empresaId });
    if (!playa) throw new NotFoundException('Playa no encontrada.');
    const existente = await this.cajas.findOneBy({
      playaId,
      mpUserId: cuenta.mpUserId,
    });
    if (existente) return this.listar();
    await this.validarUbicacion(direccion);

    const token = await this.mercadoPago.tokenDeEmpresa(empresaId);
    const externalStoreId = idSucursal(playaId);
    const externalPosId = idCaja(playaId);

    // Solo cuenta la sucursal con NUESTRO identificador: si la búsqueda trajera otras (una que el
    // cliente ya tenía), la caja quedaría colgada de la equivocada.
    const sucursales = await this.buscar(
      token,
      `${API}/users/${cuenta.mpUserId}/stores/search?external_id=${externalStoreId}`,
    );
    const yaCreada = ((sucursales?.results ?? []) as any[]).find(
      (s) => s?.external_id === externalStoreId,
    );
    let storeId: string | undefined = yaCreada?.id
      ? String(yaCreada.id)
      : undefined;
    // El identificador con que MercadoPago guardó la sucursal: es el que la caja tiene que nombrar.
    let externalStoreIdMp: string = yaCreada?.external_id ?? externalStoreId;
    if (!storeId) {
      const sucursal = await this.llamar(
        token,
        `${API}/users/${cuenta.mpUserId}/stores`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: playa.nombre.slice(0, 60),
            external_id: externalStoreId,
            location: {
              street_number: direccion.numero,
              street_name: direccion.calle,
              city_name: direccion.ciudad,
              state_name: direccion.provincia,
              latitude: direccion.latitud,
              longitude: direccion.longitud,
              reference: direccion.referencia || playa.nombre,
            },
          }),
        },
      );
      storeId = sucursal?.id ? String(sucursal.id) : undefined;
      externalStoreIdMp = sucursal?.external_id ?? externalStoreId;
    }
    if (!storeId)
      throw new ServiceUnavailableException(
        'MercadoPago no devolvió la sucursal creada. Probá de nuevo.',
      );

    const cajasMp = await this.buscar(
      token,
      `${API}/v2/pos?external_id=${externalPosId}`,
    );
    const cajaYaCreada = ((cajasMp?.data ?? []) as any[]).find(
      (c) => c?.external_id === externalPosId,
    );
    if (cajaYaCreada && String(cajaYaCreada.store_id) !== storeId)
      throw new BadRequestException(
        'La caja de MercadoPago pertenece a otra sucursal. Revisá su vinculación antes de activar el QR.',
      );
    let posId: string | undefined = cajaYaCreada?.id
      ? String(cajaYaCreada.id)
      : undefined;
    // Vincular por el ID devuelto por MP evita depender de la resolución del external_store_id.
    // Si aún no encuentra la sucursal, se reintenta con la misma clave para no duplicar la caja.
    for (let intento = 0; !posId; intento++) {
      try {
        const caja = await this.llamar(
          token,
          `${API}/v2/pos`,
          {
            method: 'POST',
            body: JSON.stringify({
              name: `Caja ${playa.nombre}`
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/[^A-Za-z0-9 _-]/g, '')
                .slice(0, 45)
                .trim(),
              store_id: storeId,
              external_id: externalPosId,
              config: { qr: { operating_mode: 'pdv' } },
            }),
          },
          `crear-caja-${cuenta.mpUserId}-${storeId}-${externalPosId}`,
        );
        posId = caja?.id ? String(caja.id) : undefined;
        if (!posId) break;
      } catch (error) {
        const sucursalTodaviaNoEsta =
          error instanceof BadRequestException &&
          /store_not_found|non_existent_external_store_id|does not refer any store/i.test(
            error.message,
          );
        if (!sucursalTodaviaNoEsta || intento >= 4) throw error;
        await this.esperar(1500 * (intento + 1));
      }
    }
    if (!posId)
      throw new ServiceUnavailableException(
        'MercadoPago no devolvió la caja creada. Probá de nuevo.',
      );

    await this.cajas.save(
      this.cajas.create({
        empresaId,
        playaId,
        mpUserId: cuenta.mpUserId,
        storeId,
        externalStoreId: externalStoreIdMp,
        posId,
        externalPosId,
        direccion,
        creadaPor: usuarioId,
      }),
    );
    this.logger.log(
      `Empresa ${empresaId}: caja de MercadoPago ${externalPosId} creada para la playa ${playaId}.`,
    );
    return this.listar();
  }

  /**
   * Crear la caja de una playa con la ubicación del dispositivo, sin formulario: el mapa da
   * provincia y localidad, que se ajustan al listado de MercadoPago; calle y número salen de la
   * dirección que la playa tiene en el sistema (o del mapa). Si la localidad no se reconoce, no se
   * crea nada y vuelve lo detectado para completar a mano.
   */
  async crearConUbicacion(
    playaId: string,
    latitud: number,
    longitud: number,
    usuarioId: string,
  ) {
    const empresaId = this.empresaActual();
    const playa = await this.dataSource
      .getRepository(Playa)
      .findOneBy({ id: playaId, empresaId });
    if (!playa) throw new NotFoundException('Playa no encontrada.');

    const mapa = await this.direccionDelMapa(latitud, longitud);
    if (mapa.country_code && mapa.country_code !== 'ar')
      throw new BadRequestException(
        'La ubicación no es de Argentina. Activalo desde la playa.',
      );
    const { calle, numero } = calleYNumero(mapa, playa.direccion);
    const posibles = provinciasPosibles(mapa.state, await this.provincias());
    for (const provincia of posibles) {
      const ciudad = elegirCiudad(
        localidadesDelMapa(mapa),
        await this.ciudades(provincia.id),
      );
      if (ciudad) {
        const direccion: DireccionCaja = {
          calle,
          numero,
          ciudad: ciudad.nombre,
          provincia: provincia.nombre,
          latitud,
          longitud,
          referencia: mapa.suburb || mapa.neighbourhood || null,
        };
        return {
          creada: true as const,
          ...(await this.crear(playaId, direccion, usuarioId)),
        };
      }
    }
    // Sin localidad reconocida no se adivina: se completa a mano con lo que se detectó.
    return {
      creada: false as const,
      motivo:
        'No pudimos reconocer la localidad con la ubicación. Elegila de la lista y creá la caja.',
      sugerencia: {
        calle,
        numero,
        provincia: posibles[0]?.nombre ?? null,
        latitud,
        longitud,
      },
    };
  }

  // OpenStreetMap (Nominatim), con un nombre que identifica al sistema como pide su política de
  // uso. Se llama una vez por caja creada.
  private async direccionDelMapa(
    latitud: number,
    longitud: number,
  ): Promise<DireccionMapa> {
    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.search = new URLSearchParams({
      format: 'jsonv2',
      lat: String(latitud),
      lon: String(longitud),
      zoom: '18',
      addressdetails: '1',
      'accept-language': 'es',
    }).toString();
    try {
      const respuesta = await fetch(url, {
        headers: {
          'user-agent': 'estacionamiento-sistema/1.0 (cajas de MercadoPago)',
        },
        signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
      });
      if (!respuesta.ok) throw new Error(String(respuesta.status));
      const datos = (await respuesta.json()) as { address?: DireccionMapa };
      return datos.address ?? {};
    } catch {
      throw new ServiceUnavailableException(
        'No se pudo reconocer la dirección de la ubicación. Probá de nuevo o completala a mano.',
      );
    }
  }

  /** Las provincias que acepta MercadoPago para una sucursal. */
  provincias() {
    return this.ubicacion('AR', `${UBICACIONES}/countries/AR`, (datos) =>
      ((datos?.states ?? []) as any[])
        .filter((s) => !NO_SON_PROVINCIAS.has(s?.name))
        .map((s) => ({ id: String(s.id), nombre: String(s.name) })),
    );
  }

  /** Las ciudades de una provincia, tal como las escribe MercadoPago (con tildes). */
  ciudades(provinciaId: string) {
    if (!/^[A-Za-z0-9=_-]{2,80}$/.test(provinciaId))
      throw new BadRequestException('Provincia inválida.');
    return this.ubicacion(
      provinciaId,
      `${UBICACIONES}/states/${provinciaId}`,
      (datos) =>
        ((datos?.cities ?? []) as any[]).map((c) => ({
          id: String(c.id),
          nombre: String(c.name),
        })),
    );
  }

  private async ubicacion(
    clave: string,
    url: string,
    leer: (datos: any) => { id: string; nombre: string }[],
  ) {
    const guardada = ubicaciones.get(clave);
    if (guardada && guardada.hasta > Date.now()) return guardada.lista;
    let datos: any;
    try {
      const respuesta = await fetch(url, {
        signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
      });
      if (!respuesta.ok) throw new Error(String(respuesta.status));
      datos = await respuesta.json();
    } catch {
      throw new ServiceUnavailableException(
        'No se pudo cargar el listado de localidades de MercadoPago. Probá de nuevo en un momento.',
      );
    }
    const lista = leer(datos).sort(alfabetico);
    ubicaciones.set(clave, { hasta: Date.now() + UN_DIA_MS, lista });
    return lista;
  }

  /**
   * Antes de pedirle nada a MercadoPago: la provincia y la ciudad tienen que estar escritas como
   * en su listado, si no rechaza la sucursal («city_name was invalid»).
   */
  private async validarUbicacion(direccion: DireccionCaja) {
    const provincia = (await this.provincias()).find(
      (p) => p.nombre === direccion.provincia,
    );
    if (!provincia)
      throw new BadRequestException(
        'Elegí la provincia de la lista: MercadoPago solo acepta las de su listado.',
      );
    const ciudad = (await this.ciudades(provincia.id)).find(
      (c) => c.nombre === direccion.ciudad,
    );
    if (!ciudad)
      throw new BadRequestException(
        'Elegí la ciudad de la lista: MercadoPago solo acepta las de su listado, escritas como ahí (con tildes).',
      );
  }

  /** La caja de una playa en la cuenta conectada hoy, o null (el cobro usa el link de siempre). */
  async cajaDePlaya(empresaId: string, playaId: string) {
    const cuenta = await this.cuentas.findOneBy({ empresaId });
    if (!cuenta || cuenta.estado !== 'ACTIVA') return null;
    return this.cajas.findOneBy({ playaId, mpUserId: cuenta.mpUserId });
  }

  /**
   * Una orden de cobro para la caja de la playa: devuelve el código QR estándar. La referencia es
   * el id de nuestro cobro, y también la clave de idempotencia: reintentar no crea dos órdenes.
   */
  async crearOrden(
    empresaId: string,
    caja: CajaMercadoPago,
    datos: {
      monto: number;
      referencia: string;
      descripcion: string;
      minutos: number;
    },
  ) {
    const token = await this.mercadoPago.tokenDeEmpresa(empresaId);
    const orden = await this.llamar(
      token,
      `${API}/v1/orders`,
      {
        method: 'POST',
        body: JSON.stringify({
          type: 'qr',
          total_amount: datos.monto.toFixed(2),
          description: datos.descripcion,
          external_reference: datos.referencia,
          expiration_time: `PT${datos.minutos}M`,
          config: {
            qr: { external_pos_id: caja.externalPosId, mode: 'dynamic' },
          },
          transactions: { payments: [{ amount: datos.monto.toFixed(2) }] },
        }),
      },
      datos.referencia,
    );
    const qrData = orden?.type_response?.qr_data;
    if (!orden?.id || !qrData)
      throw new ServiceUnavailableException(
        'MercadoPago no devolvió el código QR de la orden.',
      );
    return { ordenId: String(orden.id), qrData: String(qrData) };
  }

  /** Si la orden se pagó: el id del pago y lo que entró. */
  async consultarOrden(empresaId: string, ordenId: string) {
    const token = await this.mercadoPago.tokenDeEmpresa(empresaId);
    const orden = await this.llamar(token, `${API}/v1/orders/${ordenId}`);
    const pago = orden?.transactions?.payments?.[0];
    const pagada =
      orden?.status === 'processed' ||
      ['processed', 'accredited', 'approved'].includes(pago?.status);
    return {
      estado: String(orden?.status ?? ''),
      pagada,
      pagoId: pagada ? String(pago?.id ?? ordenId) : null,
      monto: Number(
        pago?.paid_amount ??
          pago?.amount ??
          orden?.total_paid_amount ??
          orden?.total_amount ??
          0,
      ),
    };
  }

  /** Cancelar la orden en MercadoPago para que el QR no se pueda pagar. Si falla, no importa: vence sola. */
  async cancelarOrden(empresaId: string, ordenId: string) {
    try {
      const token = await this.mercadoPago.tokenDeEmpresa(empresaId);
      await this.llamar(token, `${API}/v1/orders/${ordenId}`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'canceled' }),
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo cancelar la orden ${ordenId}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  // Separado para que las pruebas no esperen de verdad.
  protected esperar(ms: number) {
    return new Promise((resolver) => setTimeout(resolver, ms));
  }

  // Una búsqueda fallida no prueba que la sucursal o caja no exista.
  private async buscar(token: string, url: string) {
    return this.llamar(token, url);
  }

  // De un error de MercadoPago se devuelve solo su mensaje, recortado: sirve para corregir la
  // dirección y no trae credenciales. El cuerpo no se loguea.
  private async llamar(
    token: string,
    url: string,
    init: RequestInit = {},
    idempotencia?: string,
  ) {
    let respuesta: Response;
    try {
      respuesta = await fetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(idempotencia ? { 'X-Idempotency-Key': idempotencia } : {}),
        },
        signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
      });
    } catch {
      throw new ServiceUnavailableException(
        'No se pudo contactar a MercadoPago. Probá de nuevo en un momento.',
      );
    }
    const texto = await respuesta.text().catch(() => '');
    let datos: any = null;
    try {
      datos = texto ? JSON.parse(texto) : null;
    } catch {
      datos = null;
    }
    if (respuesta.ok) return datos;
    this.logger.warn(
      `MercadoPago respondió ${respuesta.status} a ${url.split('?')[0]}`,
    );
    const detalle = [
      datos?.message,
      datos?.error,
      ...(Array.isArray(datos?.cause)
        ? datos.cause.map((c: any) => c?.description ?? c?.code)
        : []),
      ...(Array.isArray(datos?.errors)
        ? datos.errors.map((e: any) => e?.message ?? e?.code)
        : []),
    ]
      .filter(Boolean)
      .join(' · ')
      .slice(0, 300);
    if (respuesta.status >= 400 && respuesta.status < 500)
      throw new BadRequestException(
        `MercadoPago rechazó el pedido${detalle ? `: ${detalle}` : '.'}`,
      );
    throw new ServiceUnavailableException(
      'MercadoPago no está respondiendo. Probá de nuevo en un momento.',
    );
  }
}
