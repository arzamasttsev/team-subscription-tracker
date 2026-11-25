import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { loginAs, newUser, openSub, resetDemo } from './helpers';

test.beforeEach(async ({ page }) => resetDemo(page));

test('приёмка ТЗ: пятое место занимается, шестого нет; продление через 7 дней в платежах', async ({ page }) => {
  await loginAs(page, 'ops');
  await openSub(page, 'Макетница');
  const card = page.getByTestId('card');
  await expect(card.getByTestId('seats')).toHaveText('4 из 5 мест, свободно 1');
  await card.getByLabel('Назначить место сотруднику').selectOption({ label: 'Дина Петрова · Разработка' });
  await card.getByRole('button', { name: 'Назначить место' }).click();
  await expect(page.getByTestId('notice')).toHaveText('Дина Петрова получает место в «Макетница». Свободно: 0');
  await expect(card.getByTestId('seats')).toHaveText('5 из 5 мест, свободно 0');
  await expect(card.getByTestId('no-seats')).toHaveText('Свободных мест нет: занято 5 из 5. Освободите место или увеличьте число мест в тарифе.');
  await expect(card.getByLabel('Назначить место сотруднику')).toHaveCount(0);
  await expect(page.locator('[data-testid="sub"][data-sub="Макетница"]')).toContainText('мест нет');

  await page.getByRole('link', { name: 'Платежи' }).click();
  await page.getByLabel('Платежи на ближайшие').selectOption('7');
  await expect(page.getByTestId('renewal')).toHaveCount(2);
  const mk = page.locator('[data-testid="renewal"][data-sub="Макетница"]');
  await expect(mk).toContainText('через 7 дн.');
  await expect(mk).toContainText('1 200,00 $');
});

test('устаревшая вкладка: шестое место — отказ с актуальной занятостью', async ({ page, browser }) => {
  await loginAs(page, 'ops');
  const p2 = await newUser(browser, 'ops');
  for (const p of [page, p2]) await openSub(p, 'Макетница');
  await page.getByLabel('Назначить место сотруднику').selectOption({ label: 'Дина Петрова · Разработка' });
  await page.getByRole('button', { name: 'Назначить место' }).click();
  await expect(page.getByTestId('notice')).toContainText('Свободно: 0');
  await p2.getByLabel('Назначить место сотруднику').selectOption({ label: 'Егор Савин · Продажи' });
  await p2.getByRole('button', { name: 'Назначить место' }).click();
  await expect(p2.getByTestId('card-error')).toHaveText('Свободных мест нет: занято 5 из 5');
  await expect(p2.getByTestId('card-error')).toBeFocused();
  await expect(p2.getByTestId('seats')).toHaveText('5 из 5 мест, свободно 0');
  await expect(p2.locator('[data-testid="assignment"][data-name="Дина Петрова"]')).toBeVisible();
  await expect(p2.getByTestId('no-seats')).toBeVisible();
});

test('освобождение места: место свободно, запись в истории и журнале', async ({ page }) => {
  await loginAs(page, 'ops');
  await openSub(page, 'Эфир');
  await expect(page.getByTestId('no-seats')).toBeVisible();
  await page.getByRole('button', { name: 'Освободить место: Егор Савин' }).click();
  await expect(page.getByTestId('notice')).toHaveText('Место Егор Савин в «Эфир» освобождено');
  await expect(page.getByTestId('seats')).toHaveText('2 из 3 мест, свободно 1');
  await page.getByText('История мест: 1').click();
  await expect(page.locator('.history li').first()).toContainText(/Егор Савин: .* — .*, освободил\(а\) Ольга Миронова/);
  await page.getByText('Журнал изменений').click();
  await expect(page.locator('.history').nth(1).locator('li').first()).toContainText('Ольга Миронова: место освобождено — Егор Савин');
  // повторное назначение того же сотрудника после освобождения
  await page.getByLabel('Назначить место сотруднику').selectOption({ label: 'Егор Савин · Продажи' });
  await page.getByRole('button', { name: 'Назначить место' }).click();
  await expect(page.getByTestId('seats')).toHaveText('3 из 3 мест, свободно 0');
});

test('сводка и платежи в двух валютах, окно 60 дней добавляет EUR', async ({ page }) => {
  await loginAs(page, 'ops', '#summary');
  await expect(page.getByTestId('tiles')).toHaveText(/4\s*активных подписок\s*14\s*из 20 мест занято\s*6\s*свободных лицензий/);
  const totals = page.getByTestId('totals');
  await expect(totals.locator('[data-currency="RUB"]')).toHaveText(/46\s490,00\s₽\s*RUB, платежей: 2/);
  await expect(totals.locator('[data-currency="USD"]')).toHaveText(/1\s200,00\s\$\s*USD, платежей: 1/);
  await expect(totals.locator('li')).toHaveCount(2);
  await page.getByRole('link', { name: 'Платежи' }).click();
  await page.getByLabel('Платежи на ближайшие').selectOption('60');
  await expect(page.getByTestId('totals').locator('[data-currency="EUR"]')).toHaveText(/9,99\s€/);
  // 90 дней: месячная «Макетница» платится трижды, отметить можно только ближайший платёж
  await page.getByLabel('Платежи на ближайшие').selectOption('90');
  await expect(page.getByTestId('totals').locator('[data-currency="USD"]')).toHaveText(/3\s600,00\s\$\s*USD, платежей: 3/);
  const mk = page.locator('[data-testid="renewal"][data-sub="Макетница"]');
  await expect(mk).toHaveCount(3);
  await expect(mk.nth(0).getByRole('button', { name: 'Продление оплачено: Макетница' })).toBeVisible();
  await expect(mk.nth(1)).toContainText('следующий период');
  await expect(mk.nth(1).getByRole('button')).toHaveText('Макетница · Команда');
});

test('правка подписки: ошибки у полей, конфликт вкладок, продление сдвигает дату', async ({ page, browser }) => {
  await loginAs(page, 'ops');
  await openSub(page, 'Поток');
  await page.getByRole('button', { name: 'Изменить' }).click();
  await page.getByLabel('Мест', { exact: true }).fill('3');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Занято мест: 6. Сначала освободите лишние места')).toBeVisible();
  await expect(page.getByLabel('Мест', { exact: true })).toBeFocused();
  await page.getByLabel('Мест', { exact: true }).fill('12');
  await page.getByLabel('Сумма за период').fill('1,234');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByLabel('Сумма за период')).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Сумма за период').fill('52 000');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('notice')).toHaveText('Подписка «Поток» сохранена');
  await expect(page.getByTestId('seats')).toHaveText('6 из 12 мест, свободно 6');
  await expect(page.getByTestId('card')).toContainText('52 000,00 ₽ в год');

  const p2 = await newUser(browser, 'ops');
  await openSub(p2, 'Поток');
  await openSub(page, 'Эфир');
  await page.getByRole('button', { name: 'Продление оплачено' }).click();
  await expect(page.getByTestId('notice')).toContainText('Продление «Эфир» отмечено. Следующее —');
  await openSub(page, 'Поток');
  await page.getByRole('button', { name: 'Изменить' }).click();
  await page.getByLabel('Тариф', { exact: true }).fill('Бизнес+');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await p2.getByRole('button', { name: 'Изменить' }).click();
  await p2.getByLabel('Мест', { exact: true }).fill('15');
  await p2.getByRole('button', { name: 'Сохранить' }).click();
  await expect(p2.getByTestId('card-error')).toHaveText('Подписку уже изменили в другой вкладке. Показаны текущие данные, внесите правку заново.');
  await expect(p2.getByTestId('card').getByRole('heading', { level: 2 })).toContainText('Поток · Бизнес+');
  await expect(p2.getByTestId('seats')).toHaveText('6 из 12 мест, свободно 6');
});

test('новая подписка и новый сотрудник, назначение, CSV', async ({ page }) => {
  await loginAs(page, 'ops');
  await page.getByRole('button', { name: 'Новая подписка' }).click();
  const f = page.getByRole('form', { name: 'Новая подписка' });
  await expect(f.getByLabel('Сервис', { exact: true })).toBeFocused();
  await f.getByLabel('Сервис', { exact: true }).fill('Чертёжник');
  await f.getByLabel('Тариф', { exact: true }).fill('Старт');
  await f.getByLabel('Мест', { exact: true }).fill('2');
  await f.getByLabel('Сумма за период').fill('990');
  await f.getByLabel('Дата продления').fill('2027-01-31');
  await f.getByRole('button', { name: 'Добавить подписку' }).click();
  await expect(page.getByTestId('notice')).toHaveText('Подписка «Чертёжник · Старт» добавлена');
  await expect(page.getByTestId('renews')).toContainText('31 января 2027');

  await page.getByRole('link', { name: 'Сотрудники' }).click();
  await page.getByLabel('Новый сотрудник').fill('Ирина Шульц');
  await page.getByLabel('Отдел').fill('Финансы');
  await page.getByRole('button', { name: 'Добавить' }).click();
  await expect(page.getByTestId('notice')).toHaveText('Сотрудник «Ирина Шульц» добавлен');
  await page.getByLabel('Новый сотрудник').fill('ирина шульц');
  await page.getByRole('button', { name: 'Добавить' }).click();
  await expect(page.getByText('Сотрудник «ирина шульц» уже есть')).toBeVisible();

  await page.getByRole('link', { name: 'Подписки' }).click();
  await openSub(page, 'Чертёжник');
  await page.getByLabel('Назначить место сотруднику').selectOption({ label: 'Ирина Шульц · Финансы' });
  await page.getByRole('button', { name: 'Назначить место' }).click();
  await expect(page.getByTestId('seats')).toHaveText('1 из 2 мест, свободно 1');

  await page.getByRole('link', { name: 'Сводка' }).click();
  const dl = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Скачать CSV подписок' }).click();
  const d = await dl;
  expect(d.suggestedFilename()).toMatch(/^podpiski-\d{8}\.csv$/);
  const text = readFileSync((await d.path())!, 'utf8');
  expect(text).toContain('Чертёжник;Старт;активна;2;1;1;990,00;RUB;месяц;2027-01-31;Ирина Шульц');
});
