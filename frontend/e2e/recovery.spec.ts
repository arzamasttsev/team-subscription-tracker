import { expect, test } from '@playwright/test';
import { loginAs, openSub, resetDemo } from './helpers';

test.beforeEach(async ({ page }) => resetDemo(page));

test('сессия закончилась: вход с пояснением', async ({ page, context }) => {
  await loginAs(page, 'ops');
  await expect(page.getByTestId('card').locator('#assign-who option')).not.toHaveCount(1); // загрузка карточки и сотрудников закончилась
  await context.clearCookies();
  await page.getByRole('link', { name: 'Сводка' }).click();
  await expect(page.getByText('Сессия закончилась, войдите снова')).toBeVisible();
});

test('сеть пропала при назначении: ошибка в карточке, занятость прежняя, повтор проходит', async ({ page }) => {
  await loginAs(page, 'ops');
  await openSub(page, 'Макетница');
  await page.route('**/api/subscriptions/*/assignments', (r) => r.abort());
  await page.getByLabel('Назначить место сотруднику').selectOption({ label: 'Дина Петрова · Разработка' });
  await page.getByRole('button', { name: 'Назначить место' }).click();
  await expect(page.getByTestId('card-error')).toHaveText('Сервер недоступен. Проверьте, что контейнер запущен, и повторите.');
  await expect(page.getByTestId('seats')).toHaveText('4 из 5 мест, свободно 1');
  await page.unroute('**/api/subscriptions/*/assignments');
  await page.getByRole('button', { name: 'Назначить место' }).click();
  await expect(page.getByTestId('seats')).toHaveText('5 из 5 мест, свободно 0');
});

test('ответ потерялся после назначения: повтор не занимает второе место', async ({ page }) => {
  await loginAs(page, 'ops');
  await openSub(page, 'Поток');
  let first = true;
  await page.route('**/api/subscriptions/*/assignments', async (r) => {
    if (!first) return r.continue();
    first = false;
    await r.fetch(); // сервер выполнил запрос, но ответ не дошёл
    await r.abort();
  });
  await page.getByLabel('Назначить место сотруднику').selectOption({ label: 'Жанна Ткач · Маркетинг' });
  await page.getByRole('button', { name: 'Назначить место' }).click();
  await expect(page.getByTestId('card-error')).toBeVisible();
  await page.getByLabel('Назначить место сотруднику').selectOption({ label: 'Жанна Ткач · Маркетинг' });
  await page.getByRole('button', { name: 'Назначить место' }).click();
  await expect(page.getByTestId('notice')).toHaveText('Жанна Ткач уже занимает место в «Поток»');
  await expect(page.getByTestId('seats')).toHaveText('7 из 10 мест, свободно 3');
});

test('ответ на «Оплачено» потерялся: дата проверена, второй сдвиг не нужен', async ({ page }) => {
  await loginAs(page, 'ops', '#renewals');
  const row = page.locator('[data-testid="renewal"][data-sub="Эфир"]').first();
  await page.route('**/api/subscriptions/*/renewed', async (r) => {
    await r.fetch();
    await r.abort();
  });
  await row.getByRole('button', { name: 'Продление оплачено: Эфир' }).click();
  await expect(page.getByTestId('notice')).toContainText('Продление «Эфир» отмечено (ответ сервера потерялся, дата проверена). Следующее —');
  await expect(page.getByTestId('pay-error')).toHaveCount(0);
  const subs = (await (await page.request.get('/api/subscriptions')).json()).subscriptions as { id: number; service: string }[];
  const efir = subs.find((x) => x.service === 'Эфир')!;
  const card = (await (await page.request.get(`/api/subscriptions/${efir.id}`)).json()).subscription;
  expect(card.events.filter((e: { kind: string }) => e.kind === 'renewed')).toHaveLength(1); // ровно один сдвиг на период
  await page.unroute('**/api/subscriptions/*/renewed');
  // сервер недоступен: ошибка в баннере с фокусом, а не в зелёной строке успеха
  await page.route('**/api/subscriptions/*/renewed', (r) => r.abort());
  await page.route('**/api/subscriptions/*', (r) => (r.request().method() === 'GET' ? r.abort() : r.continue()));
  await page.locator('[data-testid="renewal"][data-sub="Макетница"]').first().getByRole('button', { name: 'Продление оплачено: Макетница' }).click();
  await expect(page.getByTestId('pay-error')).toHaveText('«Макетница»: Сервер недоступен. Проверьте, что контейнер запущен, и повторите.');
  await expect(page.getByTestId('pay-error')).toBeFocused();
});

test('перезагрузка сохраняет раздел', async ({ page }) => {
  await loginAs(page, 'ops', '#renewals');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Платежи');
});
