// Constantes sin dependencias de entidades: evita ciclos al inicializar TypeORM.
export const TICKET_TYPE = ['AUTO', 'CAMIONETA'] as const;
export type TicketType = string;
export const TICKET_DAY_TYPE = ['DAY', 'NIGHT'] as const;
export type TicketDayType = (typeof TICKET_DAY_TYPE)[number];
export const VEHICLE_TYPE = TICKET_TYPE;
export type VehicleType = TicketType;
export const TICKET_TIME_TYPE = ['DIA', 'SEMANA', 'SEMANA_Y_DIA', 'MES', 'MES_Y_DIA'] as const;
export type TicketTimeType = (typeof TICKET_TIME_TYPE)[number];
