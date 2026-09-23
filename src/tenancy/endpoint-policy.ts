// Operator permissions are explicit. New handlers default to administrator-only.
// Use controller metadata, not the URL spelling (Express also accepts mixed case/trailing slashes).
export const OPERATOR_ENDPOINTS: Record<string, readonly string[]> = {
  AssistantController: ['chat'],
  TicketsController: ['issueParkingReceipt', 'getVehicleTypes', 'getSchedule', 'findAll', 'findAllRegistrationForDay', 'createRegistrationForDay', 'retireRegistrationsForDay', 'updateTicketStatus', 'addAdvancePayment', 'findAllTicketPrice', 'previewPrice', 'findAllPriceBrackets', 'findAllRegistrations', 'createRegistrationByPlate', 'searchActiveRegistrations', 'getCloseSummary', 'closeRegistrationByPlate', 'getFrequentCustomers', 'getPlateHistory', 'findOne'],
  ScannerController: ['startScanner'],
  PlateRecognitionController: ['scan'],
  CustomersController: ['findAll', 'getCustomerthird', 'findOne', 'findInterest'],
  ParkingOwnersController: ['getOwnersAvailableForRent', 'findAllOwnerParkingType'],
  ParkingRentersController: ['findAllRenterParkingType'],
  ReceiptsController: ['updateByOwner', 'findAllPendingReceipts', 'findReceipts'],
  BoxListsController: ['findOne', 'findBoxByDate', 'createOtherPayment', 'findAllOtherPayment', 'updateOtherPayment', 'removeOtherPayment'],
  NotesController: ['create', 'findAll', 'findOne', 'update', 'remove', 'getTodayNotes', 'unread', 'markRead'],
  TurnosController: ['open', 'close', 'getCashContext', 'getMyOpenTurno'],
  TenantContextController: ['context'],
};
