import {
  VerificacionAliasService,
  olvidarLecturas,
} from './verificacion-alias.service';
import { tenantContext } from '../tenancy/tenant-context';

describe('Documento al elegir una transferencia', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    olvidarLecturas();
  });

  test.each([true, false])(
    'conserva el CUIT de la búsqueda aunque el detalle responda: %s',
    async (detalleOk) => {
      const ahora = new Date();
      const intento = {
        id: 'i1',
        registrationId: 'r1',
        estado: 'ESPERANDO',
        mpUserId: '111',
        importe: 10,
        moneda: 'ARS',
        buscarDesde: new Date(ahora.getTime() - 60000),
        cerradoEl: null,
      };
      const transferencias = ['1', '2'].map((operacionId) => ({
        operacionId,
        importe: 10,
        moneda: 'ARS',
        fechaOperacion: ahora,
        estado: 'DISPONIBLE',
      }));
      const s: any = new VerificacionAliasService(
        {} as any,
        { update: jest.fn() } as any,
        {
          find: jest.fn().mockResolvedValue(transferencias),
          update: jest.fn(),
        } as any,
        {} as any,
        { tokenDeEmpresa: jest.fn().mockResolvedValue('token') } as any,
        {} as any,
        {} as any,
        {} as any,
      );
      s.intentoPropio = jest.fn().mockResolvedValue(intento);
      s.cobradaPorOtroMedio = jest.fn().mockResolvedValue(false);
      s.habilitacion = jest
        .fn()
        .mockResolvedValue({
          ok: true,
          cuenta: { empresaId: 'e1', mpUserId: '111' },
        });
      s.intentosDeCuenta = jest.fn().mockResolvedValue([intento]);
      s.guardarCandidatas = jest.fn();
      s.vista = jest.fn((_, extra) => extra);
      s.leer = jest
        .fn()
        .mockResolvedValue({
          ok: true,
          consultadoEl: ahora,
          pagos: [
            {
              id: '1',
              payer: {
                identification: { type: 'CUIT', number: '20123456789' },
              },
            },
            { id: '2' },
          ],
        });
      jest
        .spyOn(global, 'fetch')
        .mockImplementation(
          async (url) =>
            new Response(
              JSON.stringify(
                String(url).endsWith('/2')
                  ? {
                      collector_id: 111,
                      payer: {
                        identification: { type: 'CUIT', number: '20987654321' },
                      },
                    }
                  : { collector_id: 111, payer: {} },
              ),
              { status: detalleOk ? 200 : 503 },
            ),
        );
      const r = await tenantContext.run(
        { empresaId: 'e1', playaId: 'p1', userId: 'u1', role: 'USER' },
        () => s.consultar('i1'),
      );
      expect(r.motivoRevision).toBe('VARIAS_TRANSFERENCIAS');
      expect(r.opciones[0]).toMatchObject({
        operacionId: '1',
        nombre: null,
        documento: 'CUIT 20123456789',
      });
      expect(r.opciones[1].documento).toBe(
        detalleOk ? 'CUIT 20987654321' : null,
      );
    },
  );
});
