import type { CompletedOrderEarning } from './wallet-types';

export type WeeklyEarnings = {
  start: Date;
  end: Date;
  totalCents: number;
  completedOrderCount: number;
  orders: CompletedOrderEarning[];
};

function parisCalendarDate(isoDate: string): Date | null {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

export function getIsoWeekStart(date: Date): Date {
  const start = new Date(date);
  const day = start.getUTCDay();
  start.setUTCDate(start.getUTCDate() - (day === 0 ? 6 : day - 1));
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

export function getWeeklyEarnings(orders: CompletedOrderEarning[], referenceDate = new Date()): WeeklyEarnings[] {
  const currentWeekStart = getIsoWeekStart(parisCalendarDate(referenceDate.toISOString()) ?? referenceDate);
  const weeks = new Map<number, WeeklyEarnings>();

  for (const order of orders) {
    const completedDate = parisCalendarDate(order.completedAt);
    if (completedDate === null) continue;
    const start = getIsoWeekStart(completedDate);
    const key = start.getTime();
    const current = weeks.get(key) ?? {
      start,
      end: new Date(start.getTime() + 6 * 24 * 60 * 60 * 1_000),
      totalCents: 0,
      completedOrderCount: 0,
      orders: []
    };
    current.totalCents += order.earningCents;
    current.completedOrderCount += 1;
    current.orders.push(order);
    weeks.set(key, current);
  }

  const currentWeek = weeks.get(currentWeekStart.getTime()) ?? {
    start: currentWeekStart,
    end: new Date(currentWeekStart.getTime() + 6 * 24 * 60 * 60 * 1_000),
    totalCents: 0,
    completedOrderCount: 0,
    orders: []
  };
  weeks.set(currentWeekStart.getTime(), currentWeek);

  return [...weeks.values()].sort((first, second) => second.start.getTime() - first.start.getTime());
}

export function formatWeekRange(start: Date, end: Date): string {
  const format = (date: Date) => date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
  return `${format(start)} au ${format(end)}`;
}
