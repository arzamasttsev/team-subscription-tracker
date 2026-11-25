import { expect, test } from '@playwright/test';
import { loginAs, openSub, resetDemo } from './helpers';

test.beforeEach(async ({ page }) => resetDemo(page));

test('назначение места с клавиатуры', async ({ page }) => {
  await loginAs(page, 'ops');
  await openSub(page, 'Склад');
  await page.getByLabel('Назначить место сотруднику').focus();
  await page.keyboard.press('ArrowDown'); // первый вариант в списке
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Назначить место' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('notice')).toContainText('получает место в «Склад». Свободно: 0');
});

for (const width of [360, 320]) {
  test(`узкий экран ${width} px: без горизонтальной прокрутки`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await loginAs(page, 'ops');
    for (const hash of ['#subs', '#renewals', '#summary', '#people']) {
      await page.goto(`/${hash}`);
      await expect(page.locator('main')).toBeVisible();
      if (hash === '#subs') await page.getByRole('button', { name: 'Изменить' }).click();
      await page.waitForTimeout(100);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), hash).toBeLessThanOrEqual(0);
    }
  });
}

test('360 px: выбор подписки переводит к карточке, «К списку» возвращает', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await loginAs(page, 'ops');
  await page.locator('[data-testid="sub"][data-sub="Эфир"]').click();
  await expect(page.getByTestId('card').getByRole('heading', { level: 2 })).toBeFocused();
  const top = await page.getByTestId('card').getByRole('heading', { level: 2 }).evaluate((el) => el.getBoundingClientRect().top);
  expect(top).toBeGreaterThanOrEqual(0);
  expect(top).toBeLessThan(200);
  await page.getByRole('button', { name: '← К списку подписок' }).click();
  await expect(page.locator('[data-testid="sub"][data-sub="Эфир"]')).toBeFocused();
  // из «Сводки» на узком экране — тоже сразу к карточке
  await page.getByRole('link', { name: 'Сводка' }).click();
  await page.getByRole('button', { name: 'Склад · Про' }).click();
  await expect(page.getByTestId('card').getByRole('heading', { level: 2 })).toBeFocused();
});

test('поля подписаны, кнопки не меньше 40 px', async ({ page }) => {
  await loginAs(page, 'ops');
  await page.getByRole('button', { name: 'Новая подписка' }).click();
  for (const b of await page.locator('main button, main select, main summary, main .btn').all()) {
    if (!(await b.isVisible())) continue;
    expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(40);
  }
  for (const l of ['Поиск по сервису и тарифу', 'Сервис', 'Тариф', 'Мест', 'Сумма за период', 'Валюта', 'Период оплаты', 'Дата продления', 'Назначить место сотруднику']) await expect(page.getByLabel(l, { exact: true })).toBeVisible();
});
