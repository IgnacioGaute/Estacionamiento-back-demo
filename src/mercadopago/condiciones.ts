// Lo que la empresa acepta al conectar su cuenta de MercadoPago: qué puede hacer el sistema con
// esa cuenta. Es el consentimiento sobre el que se apoya consultar los pagos que entran.
//
// Cada versión queda escrita acá para siempre: en la cuenta se guarda qué versión aceptó, quién y
// cuándo, y el texto exacto se recupera por la versión. Cambiar lo que el sistema hace con la
// cuenta es una versión nueva (no se edita una existente), y las cuentas que aceptaron una
// anterior tienen que aceptar la nueva antes de usar lo que cambió.
//
// Lo que dicen estos puntos lo tiene que cumplir el código: si el texto dice que la plataforma no
// ve los pagos, ninguna ruta del super admin los consulta.

export interface Condiciones {
  version: string;
  titulo: string;
  puntos: string[];
}

const VERSIONES: Condiciones[] = [
  {
    version: '2026-10-05',
    titulo: 'Qué puede hacer el sistema con tu cuenta de MercadoPago',
    puntos: [
      'Crear cobros con QR por el importe de cada estadía, abono o pago de inquilino, y consultar si se pagaron.',
      'Consultar los pagos que entraron a tu cuenta en un período corto, cuando alguien de tu empresa lo pide desde el sistema, para comprobar si llegó una transferencia.',
      'De esos pagos se muestran solo los datos necesarios para reconocerlos: importe, fecha, número de operación, medio y, si MercadoPago lo informa, nombre y documento de quien pagó. Esos datos se usan solo para conciliar tus cobros y no se guardan.',
      'Lo que pagás con tu cuenta (compras, suscripciones, retiros) no se muestra, y el sistema no consulta tu saldo.',
      'Solo los administradores de tu empresa ven esta información. La administración de la plataforma no ve los pagos de tu cuenta.',
      'Podés desconectar la cuenta cuando quieras desde esta pantalla: el sistema deja de consultarla en el acto.',
    ],
  },
  {
    // Suma la verificación de transferencias al alias: el sistema guarda la evidencia mínima de
    // cada transferencia que asocia a un cobro, y la ve el operador que está cobrando.
    version: '2026-10-06',
    titulo: 'Qué puede hacer el sistema con tu cuenta de MercadoPago',
    puntos: [
      'Crear cobros con QR por el importe de cada estadía, abono o pago de inquilino, y consultar si se pagaron.',
      'Consultar los pagos que entran a tu cuenta cuando alguien de tu empresa lo pide desde el sistema: para encontrar la transferencia de un cobro que la está esperando (si activás la verificación de transferencias al alias) o en la prueba de transferencias.',
      'Con la verificación activa, asociar una transferencia a un cobro y registrar la salida cuando la coincidencia es única: el mismo importe, en los minutos de espera, y un solo cobro esperándolo en todas tus playas. Si hay dudas, la elige el operador. Es una coincidencia por importe y hora, no una identificación de quien pagó.',
      'Para conciliar, de cada transferencia que coincide con un cobro se guardan el número de operación, el importe, la moneda, el estado y las fechas. El nombre y el documento de quien pagó, cuando MercadoPago los informa, se muestran en el momento para reconocerla y no se guardan.',
      'Lo que pagás con tu cuenta (compras, suscripciones, retiros) no se muestra ni se guarda, y el sistema no consulta tu saldo.',
      'Solo los usuarios de tu empresa ven esta información, y el operador solo la del cobro que está haciendo. La administración de la plataforma no ve los pagos de tu cuenta.',
      'Podés desconectar la cuenta cuando quieras desde esta pantalla: el sistema deja de consultarla en el acto.',
    ],
  },
];

export const CONDICIONES_VIGENTES = VERSIONES[VERSIONES.length - 1];

export const condicionesDeVersion = (version: string | null) =>
  VERSIONES.find((c) => c.version === version) ?? null;
