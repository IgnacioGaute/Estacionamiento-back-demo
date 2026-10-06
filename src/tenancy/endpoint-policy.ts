// Operator permissions are explicit. New handlers default to administrator-only.
// Use controller metadata, not the URL spelling (Express also accepts mixed case/trailing slashes).
export const OPERATOR_ENDPOINTS: Record<string, readonly string[]> = {
  AssistantController: ['chat', 'stream'],
  TicketsController: [
    'receiptHistory',
    'prepareOffline',
    'syncOffline',
    'finishOffline',
    'issueParkingReceipt',
    'getVehicleTypes',
    'getSchedule',
    'findAll',
    'findAllRegistrationForDay',
    'createRegistrationForDay',
    'retireRegistrationsForDay',
    'updateTicketStatus',
    'addAdvancePayment',
    'findAllTicketPrice',
    'previewPrice',
    'findAllPriceBrackets',
    'findAllRegistrations',
    'createRegistrationByPlate',
    'searchActiveRegistrations',
    'getPlateStatus',
    'getCloseSummary',
    'closeRegistrationByPlate',
    'getFrequentCustomers',
    'getPlateHistory',
    'findOne',
  ],
  ScannerController: ['startScanner'],
  PlateRecognitionController: ['scan'],
  CustomersController: [
    'findAll',
    'getCustomerthird',
    'findOne',
    'findInterest',
  ],
  ParkingOwnersController: [
    'getOwnersAvailableForRent',
    'findAllOwnerParkingType',
  ],
  ParkingRentersController: ['findAllRenterParkingType'],
  ReceiptsController: [
    'updateByOwner',
    'findAllPendingReceipts',
    'findReceipts',
  ],
  BoxListsController: [
    'findOne',
    'findBoxByDate',
    'createOtherPayment',
    'findAllOtherPayment',
    'updateOtherPayment',
    'removeOtherPayment',
  ],
  NotesController: [
    'create',
    'findAll',
    'findOne',
    'update',
    'remove',
    'getTodayNotes',
    'unread',
    'markRead',
  ],
  TurnosController: ['open', 'close', 'getCashContext', 'getMyOpenTurno'],
  TenantContextController: ['context'],
  // El operador ve la lista (sin los totales de la playa), lo que debe y lo que pagó cada
  // inquilino, le cobra y le entrega el recibo. El estado de cuenta con sus movimientos, saldo
  // inicial, ajustes, devoluciones, anulaciones y cargar abonos quedan para administración.
  CuentasController: [
    'resumen',
    'mostrador',
    'registrarPago',
    'emitirComprobante',
  ],
  // El cajero genera y consulta el QR de cobro. Conectar o desconectar la cuenta NO está acá:
  // eso es del administrador (MercadoPagoController queda, por omisión, sólo para administradores).
  CobrosMercadoPagoController: [
    'crearCobro',
    'consultarCobro',
    'cancelarCobro',
  ],
  // El cobro por transferencia al alias. Activarlo y cargar el alias (MercadoPagoController) es
  // del administrador; que la empresa lo tenga habilitado lo verifica el servicio en cada pedido.
  VerificacionAliasController: [
    'disponibilidad',
    'iniciarCobro',
    'cobroDeEstadia',
    'consultarCobro',
    'asignarTransferencia',
    'ampliarBusqueda',
    'cancelarCobro',
  ],
};

// Lo único que puede hacer una empresa suspendida, cualquiera sea el rol: ver por qué está
// suspendida y cómo regularizar (MiPlanController), y terminar lo que quedó abierto —buscar y
// cobrar la salida de los autos que están adentro, entregar su comprobante, cerrar el turno—. Nada
// que abra una estadía nueva ni que cambie la configuración. Mismo criterio que OPERATOR_ENDPOINTS:
// clase y handler, nunca la URL. El escáner está porque el segundo escaneo prepara una salida; el
// primero (que abriría una estadía) lo rechaza el servicio con el scope `suspendida`.
export const SUSPENDED_ENDPOINTS: Record<string, readonly string[]> = {
  TenantContextController: ['context'],
  MiPlanController: [
    'estado',
    'pagarConMercadoPago',
    'verificarPagos',
    'desactivarDebito',
  ],
  UsersController: ['findOne', 'updatePassword'],
  TicketsController: [
    'getVehicleTypes',
    'getSchedule',
    'findAllRegistrations',
    'searchActiveRegistrations',
    'getPlateStatus',
    'getCloseSummary',
    'closeRegistrationByPlate',
    'issueParkingReceipt',
    'findOne',
  ],
  ScannerController: ['startScanner'],
  CobrosMercadoPagoController: [
    'crearCobro',
    'consultarCobro',
    'cancelarCobro',
  ],
  VerificacionAliasController: [
    'disponibilidad',
    'iniciarCobro',
    'cobroDeEstadia',
    'consultarCobro',
    'asignarTransferencia',
    'ampliarBusqueda',
    'cancelarCobro',
  ],
  TurnosController:['open', 'close', 'getCashContext', 'getMyOpenTurno'],
  BoxListsController: ['findOne', 'findBoxByDate'],
};
