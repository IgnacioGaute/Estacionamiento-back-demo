import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PricingBracket, PricingDayType, PricingResult, PricingSchedule } from './pricing.types';

export function resolveDayType(schedule: PricingSchedule, hour: number): PricingDayType {
  const { dayStartHour: start, dayEndHour: end } = schedule;
  return (start < end ? hour >= start && hour < end : hour >= start || hour < end) ? 'DAY' : 'NIGHT';
}

// Una tarifa específica reemplaza a la general sólo en el mismo límite de tiempo.
// Los duplicados antiguos se rechazan explícitamente: no se elige según el orden de la DB.
export function selectBrackets(all: PricingBracket[], vehicle: string, day: PricingDayType): PricingBracket[] {
  const selected = new Map<number | null, PricingBracket>();
  const seen = new Set<string>();
  for (const bracket of all.filter(b => b.vehicleType === vehicle && (b.ticketDayType === null || b.ticketDayType === day))) {
    const key = `${bracket.ticketDayType}:${bracket.uptoMinutes}`;
    if (seen.has(key)) throw new BadRequestException({ code: 'DUPLICATE_PRICE_BRACKET', message: 'Hay franjas con el mismo horario y duración. Corregí las tarifas antes de operar.' });
    seen.add(key);
    const previous = selected.get(bracket.uptoMinutes);
    if (!previous || bracket.ticketDayType === day) selected.set(bracket.uptoMinutes, bracket);
  }
  if (!selected.size) throw new NotFoundException({ code: 'TICKET_PRICE_BRACKET_NOT_FOUND', message: `No hay tarifas para ${vehicle} en horario ${day === 'DAY' ? 'día' : 'noche'}.` });
  return [...selected.values()].sort((a, b) => (a.uptoMinutes ?? Infinity) - (b.uptoMinutes ?? Infinity));
}

function tier(minutes: number): number {
  return minutes >= 1440 && minutes % 1440 === 0 ? 2 : minutes >= 60 && minutes % 60 === 0 ? 1 : 0;
}

function derivedUnitPrice(unit: number, finite: PricingBracket[]): number | null {
  const exact = finite.find(b => b.uptoMinutes === unit);
  if (exact) return exact.price;
  for (let scale = tier(unit) + 1; scale <= 2; scale++) {
    const anchor = finite.find(b => b.uptoMinutes! > 0 && tier(b.uptoMinutes!) === scale);
    // Se redondea el total al final, no cada minuto por separado.
    if (anchor) return anchor.price * unit / anchor.uptoMinutes!;
  }
  return null;
}

function cascade(covering: PricingBracket, previous: PricingBracket | null, elapsed: number, grace: number, finite: PricingBracket[]): { price: number; label: string; components: { label: string; amount: number }[] } {
  if (!previous || Math.abs(covering.uptoMinutes! - elapsed) <= grace) return { price: covering.price, label: covering.label, components: [{ label: covering.label, amount: covering.price }] };
  const smaller = finite.filter(b => tier(b.uptoMinutes!) < tier(previous.uptoMinutes!));
  let prior: PricingBracket | null = null;
  const remainder = elapsed - previous.uptoMinutes!;
  for (const bracket of smaller) {
    if (remainder <= bracket.uptoMinutes! + grace) {
      const sub = cascade(bracket, prior, remainder, grace, smaller);
      const price = previous.price + sub.price;
      // Una combinación parcial no debe costar más que la franja que la cubre.
      return price < covering.price ? { price, label: `${previous.label} + ${sub.label}`, components: [{ label: previous.label, amount: previous.price }, ...sub.components] } : { price: covering.price, label: covering.label, components: [{ label: covering.label, amount: covering.price }] };
    }
    prior = bracket;
  }
  return { price: covering.price, label: covering.label, components: [{ label: covering.label, amount: covering.price }] };
}

export function calculatePrice(all: PricingBracket[], vehicle: string, day: PricingDayType, elapsed: number, grace: number): PricingResult {
  if (!Number.isFinite(elapsed) || elapsed < 0) throw new BadRequestException('La duración de la estadía no es válida.');
  const selected = selectBrackets(all, vehicle, day);
  const finite = selected.filter(b => b.uptoMinutes !== null);
  const open = selected.find(b => b.uptoMinutes === null);
  const last = finite[finite.length - 1];
  let previous: PricingBracket | null = null;
  for (const bracket of finite) {
    const threshold = bracket.uptoMinutes! + (bracket === last && !open ? 0 : grace);
    if (elapsed <= threshold) return { ...cascade(bracket, previous, elapsed, grace, finite), usedFallback: false };
    previous = bracket;
  }
  if (!open) return { price: last.price, label: last.label, components: [{ label: last.label, amount: last.price }], usedFallback: true };
  if (!open.recurringUnitMinutes) return { price: open.price, label: open.label, components: [{ label: open.label, amount: open.price }], usedFallback: false };
  // DERIVED mantiene las tarifas preexistentes; las nuevas usan FIXED salvo elección explícita.
  const unitPrice = (open.recurringPriceMode ?? 'DERIVED') === 'FIXED'
    ? open.price : derivedUnitPrice(open.recurringUnitMinutes, finite) ?? open.price;
  const units = Math.max(1, Math.ceil(Math.max(0, elapsed - (last?.uptoMinutes ?? 0)) / open.recurringUnitMinutes));
  const base = last?.price ?? 0;
  return { components: [{ label: last?.label ?? 'Base', amount: base }, { label: `${units} unidades adicionales de ${open.recurringUnitMinutes} min a $${Number(unitPrice.toFixed(4))}`, amount: Math.round(base + units * unitPrice) - base }], price: Math.round(base + units * unitPrice), label: `${open.label} ($${base} + ${units} × $${Number(unitPrice.toFixed(4))})`, usedFallback: false };
}

export function validateBracket(candidate: PricingBracket, existing: PricingBracket[]): void {
  if (candidate.uptoMinutes !== null && candidate.recurringUnitMinutes != null) throw new BadRequestException('La recurrencia sólo se permite en una franja sin límite.');
  if (existing.some(b => b.id !== candidate.id && b.vehicleType === candidate.vehicleType && b.ticketDayType === candidate.ticketDayType && b.uptoMinutes === candidate.uptoMinutes)) {
    throw new BadRequestException({ code: 'DUPLICATE_PRICE_BRACKET', message: 'Ya existe una franja para ese vehículo, horario y duración.' });
  }
}
