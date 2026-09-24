// Qué acciones del panel de administración quedan registradas en audit_log, por controlador y
// handler resuelto por Nest (igual que endpoint-policy.ts: la URL no se usa, porque Express
// acepta mayúsculas y barras de más).
//
// Criterio de qué entra: los cambios de CONFIGURACIÓN y de cuentas — precios, franjas, tipos de
// vehículo, horarios, comprobantes, usuarios, clientes, cocheras. La operación del día (entradas,
// salidas, cobros, apertura y cierre de turno) NO entra: ya está en `movimientos`, `turnos` y las
// estadías, y acá solo haría ruido sobre lo que importa, que es quién cambió las reglas.
//
// `entidad` es el sustantivo que se muestra; `campos` son los datos del cuerpo que se guardan como
// detalle. Un campo que no esté acá no se guarda: así no entra una contraseña por descuido.
export type AuditRule = {
  accion: string;
  entidad: string;
  campos?: readonly string[];
  // De dónde leer el estado ANTERIOR para guardar solo lo que cambió. Sin esto, el panel envía
  // la sección entera y el historial diría «cambió la configuración» listando los veinte campos
  // en vez de «desactivó los turnos».
  //
  // `por`: 'id' usa el parámetro de la ruta; 'playa' la fila única de la playa del scope.
  previo?: { tabla: string; por: 'id' | 'playa' };
};

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
};
