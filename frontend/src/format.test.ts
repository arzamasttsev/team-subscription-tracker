import { describe, expect, it } from 'vitest';
import { dayText, daysText, money, moneyInput, todayIso } from './format';

describe('format', () => {
  it('деньги из минимальных единиц', () => {
    expect(money(120000, 'USD')).toBe('1 200,00 $');
    expect(money(4649000, 'RUB')).toBe('46 490,00 ₽');
    expect(money(999, 'EUR')).toBe('9,99 €');
    expect(money(5, 'KZT')).toBe('0,05 ₸');
    expect(moneyInput(129050)).toBe('1290,50');
  });
  it('даты продления', () => {
    expect(dayText('2026-11-29')).toBe('29 ноября 2026');
    expect(dayText('2026-11-29', false)).toBe('29 ноября');
    expect([daysText(0), daysText(1), daysText(7), daysText(-3)]).toEqual(['сегодня', 'завтра', 'через 7 дн.', 'просрочено на 3 дн.']);
    expect(todayIso(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});
