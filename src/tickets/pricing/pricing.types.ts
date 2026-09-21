export type PricingDayType = 'DAY' | 'NIGHT';
export type PricingBasis = 'ENTRY' | 'EXIT';
export type RecurringPriceMode = 'FIXED' | 'DERIVED';

export interface PricingBracket {
  id: string;
  vehicleType: string;
  ticketDayType: PricingDayType | null;
  label: string;
  uptoMinutes: number | null;
  price: number;
  recurringUnitMinutes: number | null;
  recurringPriceMode?: RecurringPriceMode;
}

export interface PricingSchedule {
  dayStartHour: number;
  dayEndHour: number;
  graceMinutes: number;
  pricingDayTypeBasis: PricingBasis;
  pricingOptions?: PricingOptions | null;
}

export interface PricingSnapshot {
  version: 1;
  capturedAt: string;
  schedule: PricingSchedule;
  brackets: PricingBracket[];
}

export interface PricingResult {
  price: number;
  label: string;
  usedFallback: boolean;
  components?: { label: string; amount: number }[];
}

export interface PricingOptions {
  charging: { enabled: boolean; mode: 'STARTED' | 'COMPLETED' | 'PROPORTIONAL'; unitMinutes: number; rates: { vehicleType: string; dayPrice: number; nightPrice: number }[] };
  stay: { enabled: boolean; freeMinutes: number; minimumMinutes: number; capEnabled: boolean; capMinutes: number; caps: { vehicleType: string; amount: number }[] };
  crossing: { enabled: boolean; mode: 'ENTRY' | 'EXIT' | 'SPLIT' };
}
export interface PricingLine {
  label: string;
  amount: number;
  minutes?: number;
  dayType?: PricingDayType;
  units?: number;
  unitPrice?: number;
  startAt?: string;
  endAt?: string;
}
export const defaultPricingOptions = (): PricingOptions => ({
  charging: { enabled: false, mode: 'STARTED', unitMinutes: 60, rates: [] },
  stay: { enabled: false, freeMinutes: 0, minimumMinutes: 0, capEnabled: false, capMinutes: 1440, caps: [] },
  crossing: { enabled: false, mode: 'EXIT' },
});
