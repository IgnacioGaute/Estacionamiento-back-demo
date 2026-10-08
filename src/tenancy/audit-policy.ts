// Qué acciones del panel de administración quedan registradas en audit_log, por controlador y
// handler resuelto por Nest (igual que endpoint-policy.ts: la URL no se usa, porque Express
// acepta mayúsculas y barras de más).
//
// Criterio de qué entra: todo lo que hace la ADMINISTRACIÓN — precios, franjas, tipos de
// vehículo, horarios, comprobantes, usuarios, clientes, cocheras, cajas, la cuenta de MercadoPago
// (conexión, condiciones, alias, cajas QR, comisiones) y las correcciones a mano de las cuentas de
// inquilinos y los recibos. La operación del día (entradas, salidas, cobros, pagos, apertura y
// cierre de turno) NO entra: ya está en `movimientos`, `turnos`, `cuenta_movimientos` y las
// estadías, y acá solo haría ruido sobre lo que importa, que es quién cambió las reglas.
//
// Lo que no pasa por un handler propio se registra en su servicio: las tarifas (se aplican como un
// plan entero y solo el servicio sabe qué cambió) y la plataforma (TenancyController, suscripciones).
//
// `entidad` es el sustantivo que se muestra; `campos` son los datos del cuerpo que se guardan como
// detalle. Un campo que no esté acá no se guarda: así no entra una contraseña ni un token por
// descuido.
export type AuditRule = {
  accion: string;
  entidad: string;
  campos?: readonly string[];
  // Datos que se toman de la RESPUESTA del handler y no del cuerpo: lo que resolvió el servidor
  // (con qué cuenta de MercadoPago quedó conectada la empresa). El cuerpo de esa conexión es un
  // código de autorización y no se guarda.
  respuesta?: readonly string[];
  // De dónde leer el estado ANTERIOR para guardar solo lo que cambió. Sin esto, el panel envía
  // la sección entera y el historial diría «cambió la configuración» listando los veinte campos
  // en vez de «desactivó los turnos».
  //
  // `por`: 'id' usa el parámetro de la ruta; 'playa' la fila única de la playa del scope;
  // 'empresa' la fila única de la empresa del scope, por `columnaEmpresa` ("empresaId" si no se
  // dice). `dentroDe`: los campos viven en esa columna jsonb y no en columnas propias.
  // `columnas`: campo del cuerpo → columna de la tabla, cuando se llaman distinto.
  previo?: {
    tabla: string;
    por: 'id' | 'playa' | 'empresa';
    columnaEmpresa?: string;
    dentroDe?: string;
    columnas?: Record<string, string>;
  };
  // Campo del cuerpo con la playa afectada, cuando no es la del scope: las cajas QR se crean para
  // cualquier playa desde la configuración de la empresa.
  playa?: string;
  // Hay handlers que responden bien sin haber cambiado nada (la caja QR cuya localidad no se
  // reconoció): solo se registra si esto da true.
  registrarSi?: (respuesta: any) => boolean;
};

// Las seis comisiones estimadas de MercadoPago (`ComisionesCajaDto`).
const COMISIONES = [
  'qrSaldo',
  'qrDebito',
  'qrCredito',
  'aliasSaldo',
  'aliasDebito',
  'aliasCredito',
] as const;

export const AUDIT_RULES: Record<string, Record<string, AuditRule>> = {
  TicketsController: {
    createTicketPrice: {
      accion: 'TARIFA_DIA_CREADA',
      entidad: 'tarifa por día/semana',
      campos: ['vehicleType', 'ticketTimeType', 'price'],
    },
    updateTicketPrice: {
      accion: 'TARIFA_DIA_EDITADA',
      entidad: 'tarifa por día/semana',
      previo: { tabla: 'tickets-price', por: 'id' },
      campos: ['vehicleType', 'ticketTimeType', 'price'],
    },
    removeTicketPrice: {
      accion: 'TARIFA_DIA_ELIMINADA',
      entidad: 'tarifa por día/semana',
    },
    createPriceBracket: {
      accion: 'FRANJA_CREADA',
      entidad: 'franja de precio',
      campos: [
        'vehicleType',
        'ticketDayType',
        'label',
        'uptoMinutes',
        'price',
        'recurringUnitMinutes',
        'recurringPriceMode',
      ],
    },
    updatePriceBracket: {
      accion: 'FRANJA_EDITADA',
      entidad: 'franja de precio',
      previo: { tabla: 'ticket_price_brackets', por: 'id' },
      campos: [
        'vehicleType',
        'ticketDayType',
        'label',
        'uptoMinutes',
        'price',
        'recurringUnitMinutes',
        'recurringPriceMode',
      ],
    },
    removePriceBracket: {
      accion: 'FRANJA_ELIMINADA',
      entidad: 'franja de precio',
    },
    updateSchedule: {
      accion: 'CONFIGURACION_CAMBIADA',
      entidad: 'configuración de tickets',
      previo: { tabla: 'ticket_schedule_settings', por: 'playa' },
      // Acá viven los interruptores que más se preguntan después: turnos, código de barras,
      // comprobantes y con qué día se cobra una estadía que cruza la medianoche.
      campos: [
        'shiftsEnabled',
        'barcodeTicketsEnabled',
        'pricingDayTypeBasis',
        'dayStart',
        'dayEnd',
        'nightStart',
        'nightEnd',
        'toleranceMinutes',
        'receiptDelivery',
        'pricingOptions',
      ],
    },
    createVehicleType: {
      accion: 'VEHICULO_CREADO',
      entidad: 'tipo de vehículo',
      campos: ['code', 'name', 'enabled'],
    },
    updateVehicleType: {
      accion: 'VEHICULO_EDITADO',
      entidad: 'tipo de vehículo',
      campos: ['name', 'enabled'],
    },
    create: {
      accion: 'TICKET_CREADO',
      entidad: 'tarjeta de código de barras',
      campos: ['codeBar'],
    },
    update: { accion: 'TICKET_EDITADO', entidad: 'tarjeta de código de barras' },
    remove: {
      accion: 'TICKET_ELIMINADO',
      entidad: 'tarjeta de código de barras',
    },
  },
  UsersController: {
    create: {
      accion: 'USUARIO_CREADO',
      entidad: 'usuario',
      campos: ['email', 'username', 'role'],
    },
    update: {
      accion: 'USUARIO_EDITADO',
      entidad: 'usuario',
      previo: { tabla: 'users', por: 'id' },
      campos: ['email', 'username', 'role'],
    },
    remove: { accion: 'USUARIO_BAJA', entidad: 'usuario' },
    updatePassword: { accion: 'USUARIO_CONTRASENA', entidad: 'usuario' },
  },
  CustomersController: {
    create: {
      accion: 'CLIENTE_CREADO',
      entidad: 'cliente',
      campos: ['firstName', 'lastName', 'customerType'],
    },
    update: { accion: 'CLIENTE_EDITADO', entidad: 'cliente' },
    remove: { accion: 'CLIENTE_ELIMINADO', entidad: 'cliente' },
    softDelete: { accion: 'CLIENTE_DESACTIVADO', entidad: 'cliente' },
    restoredCustomer: { accion: 'CLIENTE_REACTIVADO', entidad: 'cliente' },
    createInterest: {
      accion: 'INTERES_CAMBIADO',
      entidad: 'interés por mora',
      campos: ['interest'],
    },
  },
  ParkingOwnersController: {
    createOwnerParkingType: {
      accion: 'COCHERA_TIPO_CREADO',
      entidad: 'tipo de cochera',
      campos: ['parkingType', 'price'],
    },
    updateOwnerParkingType: {
      accion: 'COCHERA_TIPO_EDITADO',
      entidad: 'tipo de cochera',
      campos: ['parkingType', 'price'],
    },
    removeOwnerParkingType: {
      accion: 'COCHERA_TIPO_ELIMINADO',
      entidad: 'tipo de cochera',
    },
  },
  ParkingRentersController: {
    updateAmount: {
      accion: 'MONTOS_ACTUALIZADOS',
      entidad: 'actualización masiva de montos',
      campos: ['percentage', 'amount', 'customerType'],
    },
    createRenterParkingType: {
      accion: 'INQUILINO_TIPO_CREADO',
      entidad: 'tipo de alquiler',
      campos: ['parkingType', 'price'],
    },
    updateRenterParkingType: {
      accion: 'INQUILINO_TIPO_EDITADO',
      entidad: 'tipo de alquiler',
      campos: ['parkingType', 'price'],
    },
    removeRenterParkingType: {
      accion: 'INQUILINO_TIPO_ELIMINADO',
      entidad: 'tipo de alquiler',
    },
  },
  MercadoPagoController: {
    // La conexión se completa en el canje del código (`callback`); `conectar` solo arma la URL de
    // autorización y todavía no cambió nada.
    callback: {
      accion: 'MERCADOPAGO_CONECTADO',
      entidad: 'cuenta de MercadoPago',
      respuesta: ['nickname'],
    },
    aceptarCondiciones: {
      accion: 'MERCADOPAGO_CONDICIONES',
      entidad: 'condiciones de MercadoPago',
      campos: ['condiciones'],
    },
    desconectar: {
      accion: 'MERCADOPAGO_DESCONECTADO',
      entidad: 'cuenta de MercadoPago',
    },
    configurarVerificacionAlias: {
      accion: 'ALIAS_CONFIGURADO',
      entidad: 'verificación de transferencias al alias',
      previo: {
        tabla: 'mercadopago_cuentas',
        por: 'empresa',
        columnas: { activa: 'verificacionAlias' },
      },
      campos: ['activa', 'alias'],
    },
    crearCajaQr: {
      accion: 'QR_CAJA_CREADA',
      entidad: 'caja QR de MercadoPago',
      playa: 'playaId',
      campos: ['calle', 'numero', 'ciudad', 'provincia'],
    },
    crearCajaQrConUbicacion: {
      accion: 'QR_CAJA_CREADA',
      entidad: 'caja QR de MercadoPago',
      playa: 'playaId',
      registrarSi: (respuesta) => respuesta?.creada !== false,
    },
  },
  PruebaTransferenciasController: {
    // Crea la configuración del reporte de liquidaciones en la cuenta de MercadoPago de la empresa.
    configurarReporte: {
      accion: 'MERCADOPAGO_REPORTE',
      entidad: 'reporte de MercadoPago',
      registrarSi: (respuesta) => respuesta?.creada !== false,
    },
  },
  BoxListsController: {
    configurarComisiones: {
      accion: 'COMISIONES_CAMBIADAS',
      entidad: 'comisiones de MercadoPago',
      previo: {
        tabla: 'empresas',
        por: 'empresa',
        columnaEmpresa: 'id',
        dentroDe: 'comisionesMp',
      },
      campos: COMISIONES,
    },
  },
  TurnosController: {
    createCaja: {
      accion: 'CAJA_CREADA',
      entidad: 'caja',
      campos: ['nombre', 'activa'],
    },
    updateCaja: {
      accion: 'CAJA_EDITADA',
      entidad: 'caja',
      previo: { tabla: 'cash_registers', por: 'id' },
      campos: ['nombre', 'activa'],
    },
  },
  // Cuenta corriente de inquilinos: las correcciones que hace el administrador. Los pagos y las
  // devoluciones son cobros del mostrador y quedan solo en el libro de la cuenta.
  CuentasController: {
    registrarSaldoInicial: {
      accion: 'CUENTA_SALDO_INICIAL',
      entidad: 'cuenta de inquilino',
      campos: ['tipo', 'importe', 'fecha'],
    },
    registrarAjuste: {
      accion: 'CUENTA_AJUSTE',
      entidad: 'cuenta de inquilino',
      campos: ['tipo', 'importe', 'motivo'],
    },
    anular: {
      accion: 'CUENTA_ANULACION',
      entidad: 'cuenta de inquilino',
      campos: ['motivo', 'confirmacion'],
    },
    cargarAbonos: {
      accion: 'ABONOS_CARGADOS',
      entidad: 'abonos del mes',
      campos: ['mes', 'vencimientoDia'],
    },
  },
  // Recibos de abonados particulares. Cobrar uno (`updateByOwner`) es operación y no entra.
  ReceiptsController: {
    generateReceiptsManual: {
      accion: 'RECIBOS_GENERADOS',
      entidad: 'recibos del mes',
      campos: ['dateNow'],
    },
    cancelReceiptByOwner: {
      accion: 'RECIBO_ANULADO',
      entidad: 'recibo',
    },
    deleteReceipt: {
      accion: 'RECIBO_ELIMINADO',
      entidad: 'recibo',
    },
  },
};
