import { expect, test } from '@playwright/test';
import { loginAs } from './helpers';

// Замер раунда 4. Перед запуском: docker compose exec -T app python -m app.synthetic 1000 2000
test('1000 подписок и 2000 сотрудников: API и интерфейс', async ({ page }) => {
  test.setTimeout(180_000);
  await loginAs(page, 'ops');
  const n = ((await (await page.request.get('/api/subscriptions')).json()).subscriptions as unknown[]).length;
  test.skip(n < 500, 'нет синтетических данных: python -m app.synthetic 1000 2000');
  const time = async (url: string, runs = 7) => {
    const out: number[] = [];
    for (let i = 0; i < runs; i++) {
      const t0 = Date.now();
      expect((await page.request.get(url)).ok()).toBeTruthy();
      out.push(Date.now() - t0);
    }
    out.sort((a, b) => a - b);
    return { median: out[Math.floor(runs / 2)], p90: out[runs - 1] };
  };
  const list = await time('/api/subscriptions');
  const search = await time('/api/subscriptions?q=' + encodeURIComponent('Сервис 0999'));
  const card = await time('/api/subscriptions/500');
  const renewals = await time('/api/renewals?within_days=30');
  const summary = await time('/api/summary');
  const employees = await time('/api/employees');
  const csv = await time('/api/subscriptions.csv', 3);
  const t0 = Date.now();
  await page.goto('/#subs');
  await page.reload();
  await expect(page.locator('[data-testid="sub"]').first()).toBeVisible();
  const listUi = Date.now() - t0;
  const items = await page.locator('[data-testid="sub"]').count();
  const t1 = Date.now();
  await page.getByLabel('Поиск по сервису и тарифу').fill('Сервис 0999');
  await expect(page.locator('[data-testid="sub"]')).toHaveCount(1);
  const searchUi = Date.now() - t1;
  // задержка ввода в поиске: от нажатия до кадра с символом в поле
  await page.getByLabel('Поиск по сервису и тарифу').fill('');
  await expect(page.locator('[data-testid="sub"]')).toHaveCount(100);
  await page.getByLabel('Поиск по сервису и тарифу').focus();
  const typing: number[] = [];
  for (const ch of 'Сервис 09') {
    const t = Date.now();
    await page.keyboard.type(ch);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    typing.push(Date.now() - t);
  }
  typing.sort((a, b) => a - b);
  // выбор сотрудника из 2000: фильтр по имени в карточке подписки со свободными местами
  const all = (await (await page.request.get('/api/subscriptions')).json()).subscriptions as { service: string; plan: string; free: number }[];
  const target = all.find((x) => x.free > 0 && x.service.startsWith('Сервис'))!;
  await page.getByLabel('Поиск по сервису и тарифу').fill(target.service);
  await page.locator(`[data-testid="sub"][data-sub="${target.service}"]`).first().click();
  await expect(page.getByLabel('Найти сотрудника')).toBeVisible();
  const t2 = Date.now();
  await page.getByLabel('Найти сотрудника').fill('Сотрудник 01999');
  await expect(page.locator('#assign-who option')).toHaveCount(2);
  const pickUi = Date.now() - t2;
  const pickOptionsMax = 1 + 50;
  console.log('PERF226', JSON.stringify({ subscriptions: n, list, search, card, renewals, summary, employees, csv, listUi, items, searchUi, typingMedian: typing[4], typingMax: typing[8], pickUi, pickOptionsMax }));
});
