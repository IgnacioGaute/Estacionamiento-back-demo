import { BadRequestException } from '@nestjs/common';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { calculatePrice, resolveDayType, selectBrackets } from './pricing';
import { defaultPricingOptions, PricingDayType, PricingLine, PricingOptions, PricingSnapshot } from './pricing.types';
dayjs.extend(utc); dayjs.extend(timezone);
const TZ = 'America/Argentina/Buenos_Aires';

export function validatePricingOptions(options: PricingOptions) {
  if (!options?.charging || !options?.stay || !options?.crossing) throw new BadRequestException('La configuración de tarifas está incompleta.');
  for (const list of [options.charging.rates, options.stay.caps]) {
    if (!Array.isArray(list)) throw new BadRequestException('La configuración de precios está incompleta.');
    if (new Set(list.map(r => r.vehicleType)).size !== list.length) throw new BadRequestException('Hay precios repetidos para el mismo vehículo.');
  }
  if (options.stay.enabled && options.stay.capEnabled && options.stay.minimumMinutes > options.stay.capMinutes) throw new BadRequestException('El mínimo facturable no puede superar el período del tope.');
}

export function assertPricingCoverage(snapshot: PricingSnapshot, vehicle: string, day: PricingDayType) {
  const options = snapshot.schedule.pricingOptions ?? defaultPricingOptions();
  if (options.charging.enabled) {
    if (!options.charging.rates.some(r => r.vehicleType === vehicle)) throw new BadRequestException(`Falta el precio por unidad para ${vehicle}.`);
  } else selectBrackets(snapshot.brackets, vehicle, day);
  if (options.stay.enabled && options.stay.capEnabled && !options.stay.caps.some(r => r.vehicleType === vehicle)) throw new BadRequestException(`Falta el tope de permanencia para ${vehicle}.`);
}

export function calculateStayPrice(snapshot: PricingSnapshot, vehicle: string, entry: Date, exit: Date) {
  const schedule = snapshot.schedule;
  const options = schedule.pricingOptions ?? defaultPricingOptions();
  const start = dayjs(entry).tz(TZ), end = dayjs(exit).tz(TZ);
  if (!start.isValid() || !end.isValid() || end.isBefore(start)) throw new BadRequestException('La entrada y la salida no son válidas.');
  const elapsedMinutes = end.diff(start, 'minute');
  const basis = options.crossing.enabled ? options.crossing.mode : schedule.pricingDayTypeBasis;
  const fixedDay = resolveDayType(schedule, (basis === 'ENTRY' ? start : end).hour());
  const breakdown: PricingLine[] = [];
  const free = options.stay.enabled ? Math.min(elapsedMinutes, options.stay.freeMinutes) : 0;
  const remaining = elapsedMinutes - free;
  const minimum = options.stay.enabled && remaining > 0 ? Math.max(0, options.stay.minimumMinutes - remaining) : 0;
  const billableMinutes = remaining + minimum;
  if (free) breakdown.push({ label: 'Minutos iniciales gratuitos descontados', minutes: free, amount: 0 });
  if (minimum) breakdown.push({ label: 'Minutos agregados por mínimo facturable', minutes: minimum, amount: 0 });
  let usedFallback = false;

  const charge = (minutes: number, day: PricingDayType, from: dayjs.Dayjs, to: dayjs.Dayjs) => {
    assertPricingCoverage(snapshot, vehicle, day);
    if (options.charging.enabled) {
      const rate = options.charging.rates.find(r => r.vehicleType === vehicle)!;
      const price = day === 'DAY' ? rate.dayPrice : rate.nightPrice;
      const unit = options.charging.unitMinutes;
      const units = options.charging.mode === 'PROPORTIONAL' ? minutes / unit
        : options.charging.mode === 'COMPLETED' ? Math.floor(minutes / unit)
        : minutes > 0 ? Math.max(1, Math.ceil(Math.max(0, minutes - Math.min(schedule.graceMinutes, unit - 1)) / unit)) : 0;
      const amount = units * price;
      breakdown.push({ label: `${options.charging.mode === 'PROPORTIONAL' ? 'Proporcional' : options.charging.mode === 'COMPLETED' ? 'Bloques completos' : 'Bloques iniciados'} de ${unit} min`, minutes, dayType: day, units, unitPrice: price, amount, startAt: from.toISOString(), endAt: to.toISOString() });
      return amount;
    }
    const result = calculatePrice(snapshot.brackets, vehicle, day, minutes, schedule.graceMinutes);
    usedFallback ||= result.usedFallback;
    const parts = result.components ?? [{ label: result.label, amount: result.price }];
    parts.forEach(part => breakdown.push({ ...part, minutes, dayType: day, startAt: from.toISOString(), endAt: to.toISOString() }));
    return result.price;
  };

  // Una permanencia activada con todos sus valores neutros conserva el cálculo anterior.
  const stayHasEffect = options.stay.enabled && (options.stay.freeMinutes > 0 || options.stay.minimumMinutes > 0 || options.stay.capEnabled);
  if (!options.charging.enabled && !stayHasEffect && basis !== 'SPLIT') {
    const total = charge(elapsedMinutes, fixedDay, start, end);
    return { price: total, label: breakdown.map(r => r.label).join(' + '), usedFallback, breakdown, elapsedMinutes, billableMinutes: elapsedMinutes, pricingDayTypeBasis: basis, ticketDayType: fixedDay };
  }
  if (billableMinutes === 0) {
    return { price: 0, label: free ? 'Permanencia gratuita' : 'Sin tiempo facturable', usedFallback: false, breakdown, elapsedMinutes, billableMinutes, pricingDayTypeBasis: basis, ticketDayType: basis === 'SPLIT' ? 'MIXED' as const : fixedDay };
  }
  const capEnabled = options.stay.enabled && options.stay.capEnabled;
  const windowSize = capEnabled ? options.stay.capMinutes : Math.max(elapsedMinutes, 1);
  if (Math.ceil(elapsedMinutes / windowSize) > 10000) throw new BadRequestException('La estadía supera el límite de períodos del simulador.');
  let total = 0;
  // Los topes se aplican por períodos desde la entrada, incluyendo un último período parcial.
  for (let offset = 0; offset < elapsedMinutes; offset += windowSize) {
    const finish = Math.min(elapsedMinutes, offset + windowSize);
    const begin = Math.max(offset, free);
    if (finish <= begin) continue;
    const segments: { from: dayjs.Dayjs; to: dayjs.Dayjs; minutes: number; day: PricingDayType }[] = [];
    let cursor = start.add(begin, 'minute');
    const periodEnd = start.add(finish, 'minute');
    if (basis !== 'SPLIT') segments.push({ from: cursor, to: periodEnd, minutes: finish - begin, day: fixedDay });
    else while (cursor.isBefore(periodEnd)) {
      const boundaries = [schedule.dayStartHour, schedule.dayEndHour].map(hour => {
        const boundary = cursor.startOf('day').hour(hour);
        return boundary.isAfter(cursor) ? boundary : boundary.add(1, 'day');
      });
      const boundary = boundaries[0].isBefore(boundaries[1]) ? boundaries[0] : boundaries[1];
      const next = boundary.isBefore(periodEnd) ? boundary : periodEnd;
      const day = resolveDayType(schedule, cursor.hour());
      const minutes = next.diff(cursor, 'millisecond') / 60000;
      const last = segments[segments.length - 1];
      if (last?.day === day) { last.to = next; last.minutes += minutes; }
      else segments.push({ from: cursor, to: next, minutes, day });
      cursor = next;
    }
    // El mínimo se cobra una sola vez, al precio del último tramo real.
    if (finish === elapsedMinutes && minimum) segments[segments.length - 1].minutes += minimum;
    let periodTotal = segments.reduce((sum, segment) => sum + charge(segment.minutes, segment.day, segment.from, segment.to), 0);
    if (capEnabled) {
      const cap = options.stay.caps.find(r => r.vehicleType === vehicle);
      if (!cap) throw new BadRequestException(`Falta el tope de permanencia para ${vehicle}.`);
      const discount = Math.max(0, periodTotal - cap.amount);
      breakdown.push({ label: `Tope de $${cap.amount} por ${windowSize / 60} h · período ${Math.floor(offset / windowSize) + 1}`, amount: -discount, startAt: start.add(offset, 'minute').toISOString(), endAt: periodEnd.toISOString() });
      periodTotal -= discount;
    }
    total += periodTotal;
  }
  const price = Math.round(total);
  if (!Number.isSafeInteger(price) || price > 2147483647) throw new BadRequestException('El importe calculado supera el máximo permitido.');
  if (Math.abs(price - total) > 0.000001) breakdown.push({ label: 'Redondeo final a pesos', amount: price - total });
  return { price, label: 'Tarifa configurada', usedFallback, breakdown, elapsedMinutes, billableMinutes, pricingDayTypeBasis: basis, ticketDayType: basis === 'SPLIT' ? 'MIXED' as const : fixedDay };
}
