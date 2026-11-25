import { expect, type Browser, type Page } from '@playwright/test';

export const PASS: Record<string, string> = { ops: 'ops-demo', admin: 'admin-demo' };

export async function resetDemo(page: Page): Promise<void> {
  expect((await page.request.post('/api/auth/login', { data: { username: 'admin', password: PASS.admin } })).ok()).toBeTruthy();
  expect((await page.request.post('/api/demo/reset')).ok()).toBeTruthy();
  await page.request.post('/api/auth/logout');
}

export async function loginAs(page: Page, username: string, hash = ''): Promise<void> {
  await page.goto(`/${hash}`);
  const out = page.getByRole('button', { name: 'Выйти' });
  await expect(out.or(page.getByLabel('Логин'))).toBeVisible();
  if (await out.isVisible()) await out.click();
  await page.getByLabel('Логин').fill(username);
  await page.getByLabel('Пароль').fill(PASS[username] ?? 'ops-demo');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByTestId('whoami')).toBeVisible();
}

export async function newUser(browser: Browser, username: string, hash = ''): Promise<Page> {
  const p = await (await browser.newContext({ locale: 'ru-RU', timezoneId: 'Europe/Moscow' })).newPage();
  await loginAs(p, username, hash);
  return p;
}

/** Открыть карточку подписки по названию сервиса. */
export async function openSub(page: Page, service: string): Promise<void> {
  await page.locator(`[data-testid="sub"][data-sub="${service}"]`).click();
  await expect(page.getByTestId('card').getByRole('heading', { level: 2 })).toContainText(service);
}
