/** Деньги, даты продления и периоды для показа. */

export const CURRENCIES: Record<string, string> = { RUB: '₽', USD: '$', EUR: '€', CNY: '¥', KZT: '₸' };
export const PERIOD_TEXT: Record<string, string> = { month: 'месяц', quarter: 'квартал', year: 'год' };
export const PER_TEXT: Record<string, string> = { month: 'в месяц', quarter: 'в квартал', year: 'в год' };

const group = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** 120000, USD → «1 200,00 $». Целые минимальные единицы, без плавающей точки. */
export function money(minor: number, currency: string): string {
  const whole = Math.floor(minor / 100);
  const frac = String(minor % 100).padStart(2, '0');
  return `${group(whole)},${frac} ${CURRENCIES[currency] ?? currency}`;
}

/** Минимальные единицы → строка для поля ввода: «1200,00». */
export const moneyInput = (minor: number) => `${Math.floor(minor / 100)},${String(minor % 100).padStart(2, '0')}`;

/** «2026-11-29» → «29 ноября 2026». Календарная дата без часового пояса. */
export function dayText(iso: string, withYear = true): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', ...(withYear ? { year: 'numeric' } : {}) }).replace(' г.', '');
}

export function daysText(n: number): string {
  if (n === 0) return 'сегодня';
  if (n === 1) return 'завтра';
  if (n < 0) return `просрочено на ${-n} дн.`;
  return `через ${n} дн.`;
}

export function seatsText(used: number, seats: number): string {
  return `${used} из ${seats} мест`;
}

export const dateTime = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Сегодня по местному времени браузера: «2026-11-22». */
export function todayIso(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
