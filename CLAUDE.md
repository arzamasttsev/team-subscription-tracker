# Правила работы с проектом 226 Учёт подписок команды

Сервер FastAPI + SQLite (stdlib `sqlite3`, без ORM), интерфейс React + TypeScript + Vite. Один Docker-контейнер, порт `127.0.0.1:8226`.

## Где что находится

- Интерфейс и публичные маршруты — `frontend/src/App.tsx` (разделы `#subs`, `#renewals`, `#summary`, `#people`), `frontend/src/ui/Login.tsx`, `frontend/src/api.ts`, `frontend/src/format.ts`. API: `/api/subscriptions[/{id}[/renewed|/assignments]]`, `/api/assignments/{id}/release`, `/api/renewals?within_days`, `/api/summary`, `/api/employees[/{id}]`, `/api/subscriptions.csv`, `/api/auth/*`, `/api/me`, `/api/health`, `/api/demo/*` (только `DEMO_MODE=1`). OpenAPI — `/api/docs`.
- Предметная логика и хранение — `backend/app/service.py` (правила), `backend/app/main.py` (маршруты, роли), `backend/app/web.py` и `auth.py`, `backend/app/db.py`, `backend/app/migrations/*.sql`.
- Данные, ассеты и демоматериалы — `backend/app/seed.py` (2 пользователя, 8 сотрудников, 4 подписки в RUB, USD и EUR с датами от сегодняшнего дня), `backend/app/synthetic.py SUBSCRIPTIONS EMPLOYEES`, `frontend/public/favicon.svg` (собственная), том Docker `subscriptions-data`.
- Тесты и документация — `backend/tests/` (pytest), `frontend/src/*.test.ts` (Vitest), `frontend/e2e/` (Playwright), `scripts/container_check.py`, `docs/`.

## Команды и сценарий

- Установка — `docker compose up -d --build`. Для разработки: `backend/.venv` + `pip install -r requirements-dev.txt`, `frontend: npm ci`.
- Запуск и адрес — http://127.0.0.1:8226 (контейнер). В разработке: uvicorn на :8000 и `npm run dev` на :5226.
- Проверки и сборка — `cd backend && python -m pytest`, `cd frontend && npm test && npm run build && npm run e2e` (против контейнера), `python3 scripts/container_check.py --restart`.
- Данные и результат показательного сценария — `ops / ops-demo` открывает «Макетница · Команда» (5 мест, 4 назначения) и назначает пятое место: 201, «свободно 0». Шестое назначение — 409 `seats_exhausted` «Свободных мест нет: занято 5 из 5». «Платежи» за 7 дней показывают «Макетницу» через 7 дней, итоги по валютам раздельные.

## Инварианты проекта

- Свободно = `seats` − число назначений с `released_at IS NULL`. Хранится только лимит и назначения, «занято» и «свободно» всегда вычисляются.
- Назначение (`service.assign`) — одна транзакция `BEGIN IMMEDIATE`: подсчёт занятых и вставка. Второй рубеж в базе — триггер `assignments_seat_limit` (`RAISE(ABORT, 'seats_exhausted')`) и частичный уникальный индекс `assignments_one_active ON assignments(subscription_id, employee_id) WHERE released_at IS NULL`.
- Повтор назначения того же сотрудника — 200 и существующее назначение без нового события, даже если мест уже нет. Повторное освобождение — `changed=false`.
- Освобождение не удаляет запись: ставит `released_at` и `released_by`, запись уходит в «Историю мест».
- Деньги — целые минимальные единицы (`price_minor`), валюта — одна из RUB, USD, EUR, CNY, KZT. Ввод «1 290,50» разбирает `parse_money`, больше двух знаков после запятой — 400 у поля `price`. Итоги не складывают валюты.
- Даты продления — локальные даты (`YYYY-MM-DD`), «сегодня» — по `TZ_OFFSET_HOURS`. Сдвиг на период — `add_months` с якорным днём (`anchor_day`): 31 января → 28 февраля → 31 марта.
- Платежи окна (`service.renewals`) — каждая дата окна отдельной строкой: первая — сохранённая дата (её отмечают «Оплачено»), следующие — прогноз через период (`projected`). Просроченная сохранённая дата в итог не входит.
- Правка подписки — с версией (409 `version_conflict` с актуальной карточкой). Нельзя уменьшить места ниже занятых и отменить подписку с занятыми местами.
- Роли: `ops` и `admin` — все действия, `admin` дополнительно сбрасывает демо. Проверка роли на сервере (`require_role`).
- Миграции — только новыми файлами `NNN_*.sql`. Разбор SQL в `db.py` понимает тела триггеров (`sqlite3.complete_statement`). `/api/demo/reset` удаляет все данные: только для демо-базы.

Изменения проверяй через основной сценарий и применимые граничные случаи. Для ночного выпуска веди в `docs/ACCEPTANCE.md` пять секций: корректность, восстановление, удобство, узкие места и воспроизводимость. Записывай измерения и результаты повторных проверок. Фактическое устройство продукта описано в `docs/ARCHITECTURE.md`, рецепты проверок — в `docs/ACCEPTANCE.md`. Публикуй этот репозиторий и развёртывай его по `PUBLISH_TO_GITHUB.md` только по запросу владельца.
