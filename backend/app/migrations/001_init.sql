-- 001: исходная схема Учёт подписок команды.
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ops', 'admin')),
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE services (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  search_key TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- Подписка: тариф сервиса с числом мест, суммой за период (в минимальных единицах валюты) и датой продления.
CREATE TABLE subscriptions (
  id INTEGER PRIMARY KEY,
  service_id INTEGER NOT NULL REFERENCES services(id),
  plan TEXT NOT NULL,
  seats INTEGER NOT NULL CHECK (seats > 0),
  period TEXT NOT NULL CHECK (period IN ('month', 'quarter', 'year')),
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  currency TEXT NOT NULL CHECK (currency IN ('RUB', 'USD', 'EUR', 'CNY', 'KZT')),
  renews_on TEXT NOT NULL,
  -- день месяца, к которому привязано продление: 31 января → 28 февраля → 31 марта, без дрейфа.
  anchor_day INTEGER NOT NULL CHECK (anchor_day BETWEEN 1 AND 31),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX subscriptions_renews ON subscriptions(status, renews_on);

CREATE TABLE employees (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  department TEXT NOT NULL DEFAULT '',
  search_key TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE assignments (
  id INTEGER PRIMARY KEY,
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  assigned_at TEXT NOT NULL,
  assigned_by INTEGER REFERENCES users(id),
  released_at TEXT,
  released_by INTEGER REFERENCES users(id)
);
-- Одно активное назначение сотрудника в подписке.
CREATE UNIQUE INDEX assignments_one_active ON assignments(subscription_id, employee_id) WHERE released_at IS NULL;
CREATE INDEX assignments_active ON assignments(subscription_id) WHERE released_at IS NULL;
CREATE INDEX assignments_employee ON assignments(employee_id);

-- Вторая линия защиты лимита: даже минуя сервис, база не примет назначение сверх числа мест.
CREATE TRIGGER assignments_seat_limit BEFORE INSERT ON assignments
WHEN NEW.released_at IS NULL AND (SELECT COUNT(*) FROM assignments WHERE subscription_id = NEW.subscription_id AND released_at IS NULL) >= (SELECT seats FROM subscriptions WHERE id = NEW.subscription_id)
BEGIN
  SELECT RAISE(ABORT, 'seats_exhausted');
END;

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor_id INTEGER REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('subscription_create', 'subscription_edit', 'assign', 'release', 'renewed', 'employee_create')),
  subscription_id INTEGER REFERENCES subscriptions(id),
  employee_id INTEGER REFERENCES employees(id),
  details TEXT NOT NULL DEFAULT ''
);
CREATE INDEX events_sub ON events(subscription_id, id);
