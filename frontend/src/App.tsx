import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, authApi, type User } from './api-core';
import { api, type Card, type Employee, type Payment, type Period, type Renewals, type SubForm, type Summary } from './api';
import { CURRENCIES, dateTime, dayText, daysText, money, moneyInput, PER_TEXT, PERIOD_TEXT, seatsText, todayIso } from './format';
import { Login } from './ui/Login';

type View = 'subs' | 'renewals' | 'summary' | 'people';
const VIEWS: [View, string][] = [
  ['subs', 'Подписки'],
  ['renewals', 'Платежи'],
  ['summary', 'Сводка'],
  ['people', 'Сотрудники'],
];
const parse = (): View => {
  const h = location.hash.slice(1);
  return VIEWS.some((v) => v[0] === h) ? (h as View) : 'subs';
};
const roleLabel = (r: string) => (r === 'admin' ? 'администратор' : 'операционный менеджер');
const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Не удалось выполнить действие');
const errField = (e: unknown) => (e instanceof ApiError ? ((e.data as { field?: string } | undefined)?.field ?? null) : null);
type Done = (t: string) => void;

/** Значение с задержкой: поиск не отправляет запрос и не перерисовывает список на каждый символ. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

const PAGE = 100;
const PICK_LIMIT = 50;

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    fn()
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e: unknown) => alive && setError(errText(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, reload: useCallback(() => setN((x) => x + 1), []), setData };
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [loginNotice, setLoginNotice] = useState<string | null>(null);
  const [view, setView] = useState<View>(parse);
  const [notice, setNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [openSub, setOpenSub] = useState<number | null>(null);
  const [jumpReq, setJumpReq] = useState(false);
  useEffect(() => {
    authApi
      .me()
      .then((r) => setUser(r.user))
      .catch(() => undefined)
      .finally(() => setLoading(false));
    const lost = () => (setUser(null), setLoginNotice('Сессия закончилась, войдите снова'));
    const hash = () => setView(parse());
    window.addEventListener('auth-lost', lost);
    window.addEventListener('hashchange', hash);
    return () => (window.removeEventListener('auth-lost', lost), window.removeEventListener('hashchange', hash));
  }, []);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 7000);
    return () => window.clearTimeout(t);
  }, [notice]);
  if (loading) return <p className="muted">Загрузка…</p>;
  if (!user) return <Login onLogin={(u) => (setUser(u), setLoginNotice(null))} notice={loginNotice} roleLabel={roleLabel} />;
  const done: Done = (t) => (setNotice(t), setTick((x) => x + 1));
  const open = (id: number) => (setOpenSub(id), setJumpReq(true), (location.hash = '#subs'));
  return (
    <div className="app">
      <header className="topbar">
        <div>
          <p className="kicker">Учёт подписок команды</p>
          <h1>{VIEWS.find((v) => v[0] === view)?.[1]}</h1>
        </div>
        <div className="whoami">
          <span data-testid="whoami">
            {user.display_name} · {roleLabel(user.role)}
          </span>
          <button type="button" className="btn btn--ghost" onClick={() => void authApi.logout().finally(() => setUser(null))}>
            Выйти
          </button>
        </div>
      </header>
      <nav className="tabs" aria-label="Разделы">
        {VIEWS.map(([v, label]) => (
          <a key={v} href={`#${v}`} className={`tab ${view === v ? 'tab--on' : ''}`} aria-current={view === v ? 'page' : undefined}>
            {label}
          </a>
        ))}
      </nav>
      <p className="notice-line" role="status" aria-live="polite" data-testid="notice">
        {notice ?? ''}
      </p>
      {view === 'subs' ? (
        <SubsView tick={tick} done={done} openSub={openSub} setOpenSub={setOpenSub} jumpInit={jumpReq} clearJump={() => setJumpReq(false)} />
      ) : view === 'renewals' ? (
        <RenewalsView tick={tick} done={done} open={open} />
      ) : view === 'summary' ? (
        <SummaryView tick={tick} open={open} />
      ) : (
        <PeopleView tick={tick} done={done} open={open} />
      )}
    </div>
  );
}

function SeatBar({ used, seats }: { used: number; seats: number }) {
  const pct = Math.min(100, Math.round((used / seats) * 100));
  return (
    <span className="seatbar" aria-hidden="true">
      <span className={`seatbar__fill ${used >= seats ? 'seatbar__fill--full' : ''}`} style={{ width: `${pct}%` }} />
    </span>
  );
}

/* ---------------- Подписки ---------------- */

function SubsView({ tick, done, openSub, setOpenSub, jumpInit, clearJump }: { tick: number; done: Done; openSub: number | null; setOpenSub: (id: number | null) => void; jumpInit: boolean; clearJump: () => void }) {
  const [qInput, setQInput] = useState('');
  const q = useDebounced(qInput, 200);
  const [all, setAll] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [creating, setCreating] = useState(false);
  const [jump, setJump] = useState(jumpInit);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => clearJump(), []);
  const list = useLoad(() => api.subs(q.trim(), all ? 'all' : 'active'), [q, all, tick]);
  const subs = useMemo(() => list.data?.subscriptions ?? [], [list.data]);
  const sel = openSub ?? subs[0]?.id ?? null;
  useEffect(() => setLimit(PAGE), [q, all]);
  const stopJump = useCallback(() => setJump(false), []);
  const items = useMemo(
    () =>
      subs.slice(0, limit).map((s) => (
        <li key={s.id}>
          <button type="button" className={`sub ${sel === s.id ? 'sub--on' : ''}`} onClick={() => (setOpenSub(s.id), setJump(true))} aria-current={sel === s.id ? 'true' : undefined} data-testid="sub" data-sub={s.service}>
            <span className="sub__name">
              {s.service} · {s.plan}
              {s.status === 'cancelled' ? <span className="pill pill--muted">отменена</span> : s.free === 0 ? <span className="pill pill--warn">мест нет</span> : null}
            </span>
            <span className="sub__line">
              <SeatBar used={s.used} seats={s.seats} /> {seatsText(s.used, s.seats)}, свободно {s.free}
            </span>
            <span className="sub__line muted">
              {money(s.price_minor, s.currency)} {PER_TEXT[s.period]} · продление {daysText(s.days_left)}
            </span>
          </button>
        </li>
      )),
    [subs, limit, sel, setOpenSub],
  );
  return (
    <main className="split">
      <section className="panel list-panel" aria-labelledby="list-h">
        <h2 id="list-h">Подписки{list.data ? `: ${subs.length}` : ''}</h2>
        <div className="field">
          <label htmlFor="q">Поиск по сервису и тарифу</label>
          <input id="q" type="search" value={qInput} onChange={(e) => setQInput(e.target.value)} />
        </div>
        <label className="check">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Показывать отменённые
        </label>
        {list.error ? <p className="banner">{list.error}</p> : null}
        <ul className="subs">{items}</ul>
        {subs.length > limit ? (
          <button type="button" className="btn btn--ghost" onClick={() => setLimit((x) => x + PAGE)}>
            Показать ещё {Math.min(PAGE, subs.length - limit)} (показано {limit} из {subs.length})
          </button>
        ) : null}
        {list.data && !subs.length ? <p className="empty">{q ? 'Ничего не нашлось.' : 'Подписок пока нет.'}</p> : null}
        <datalist id="dl-services">
          {[...new Set(subs.map((s) => s.service))].map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        {creating ? (
          <SubFormView
            title="Новая подписка"
            submitText="Добавить подписку"
            initial={{ service: '', plan: '', seats: 1, period: 'month', price: '', currency: 'RUB', renews_on: todayIso() }}
            onCancel={() => setCreating(false)}
            onSubmit={async (f) => {
              const r = await api.create(f);
              setCreating(false);
              setOpenSub(r.subscription.id);
              done(`Подписка «${r.subscription.service} · ${r.subscription.plan}» добавлена`);
            }}
          />
        ) : (
          <button type="button" className="btn" onClick={() => setCreating(true)}>
            Новая подписка
          </button>
        )}
      </section>
      {sel ? <CardView key={sel} id={sel} tick={tick} done={done} jump={jump} onJumped={stopJump} /> : <p className="empty">Выберите подписку.</p>}
    </main>
  );
}

function SubFormView({ title, submitText, initial, onSubmit, onCancel, withService = true }: { title: string; submitText: string; initial: SubForm; onSubmit: (f: SubForm) => Promise<void>; onCancel: () => void; withService?: boolean }) {
  const [f, setF] = useState<SubForm>(initial);
  const [err, setErr] = useState<{ field: string | null; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const set = (patch: Partial<SubForm>) => (setF({ ...f, ...patch }), setErr(null));
  const fieldErr = (k: string) => (err?.field === k ? err.text : null);
  const input = (k: keyof SubForm, label: string, props: Record<string, unknown> = {}) => (
    <div className={`field ${fieldErr(k) ? 'field--error' : ''}`}>
      <label htmlFor={`f-${k}`}>{label}</label>
      <input
        id={`f-${k}`}
        ref={k === (withService ? 'service' : 'plan') ? first : undefined}
        value={String(f[k])}
        aria-invalid={fieldErr(k) ? true : undefined}
        aria-describedby={fieldErr(k) ? `f-${k}-err` : undefined}
        onChange={(e) => set({ [k]: k === 'seats' ? Number(e.target.value.replace(/\D/g, '') || 0) : e.target.value } as Partial<SubForm>)}
        {...props}
      />
      {fieldErr(k) ? (
        <span className="field__error" id={`f-${k}-err`}>
          {fieldErr(k)}
        </span>
      ) : null}
    </div>
  );
  return (
    <form
      className="subform"
      aria-label={title}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onSubmit(f);
        } catch (x) {
          const field = errField(x);
          setErr({ field: field === 'price' || field === 'seats' || field === 'plan' || field === 'service' || field === 'renews_on' || field === 'currency' ? field : null, text: errText(x) });
          if (field) document.getElementById(`f-${field}`)?.focus();
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>{title}</h3>
      {err && !err.field ? (
        <p className="banner" role="alert">
          {err.text}
        </p>
      ) : null}
      <div className="row">
        {withService ? input('service', 'Сервис', { list: 'dl-services', maxLength: 120 }) : null}
        {input('plan', 'Тариф', { maxLength: 120 })}
        {input('seats', 'Мест', { inputMode: 'numeric' })}
      </div>
      <div className="row">
        {input('price', 'Сумма за период', { inputMode: 'decimal', placeholder: '1 290,50' })}
        <div className={`field ${fieldErr('currency') ? 'field--error' : ''}`}>
          <label htmlFor="f-currency">Валюта</label>
          <select id="f-currency" value={f.currency} onChange={(e) => set({ currency: e.target.value })}>
            {Object.entries(CURRENCIES).map(([c, sym]) => (
              <option key={c} value={c}>
                {c} ({sym})
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-period">Период оплаты</label>
          <select id="f-period" value={f.period} onChange={(e) => set({ period: e.target.value as Period })}>
            {Object.entries(PERIOD_TEXT).map(([p, t]) => (
              <option key={p} value={p}>
                {t}
              </option>
            ))}
          </select>
        </div>
        {input('renews_on', 'Дата продления', { type: 'date' })}
      </div>
      <div className="row">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {submitText}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </form>
  );
}

const narrow = () => window.matchMedia('(max-width: 860px)').matches;

const CardView = memo(function CardView({ id, tick, done, jump, onJumped }: { id: number; tick: number; done: Done; jump: boolean; onJumped: () => void }) {
  const { data, error, setData } = useLoad(() => api.card(id), [id, tick]);
  const headRef = useRef<HTMLHeadingElement>(null);
  const loaded = data !== null;
  // На узком экране карточка стоит под всем списком: после выбора переводим к ней фокус и прокрутку.
  useEffect(() => {
    if (!jump || !loaded) return;
    if (narrow()) {
      headRef.current?.focus({ preventScroll: true });
      headRef.current?.scrollIntoView({ block: 'start' });
    }
    onJumped();
  }, [jump, loaded, onJumped]);
  const emps = useLoad(() => api.employees(), [tick]);
  const [editing, setEditing] = useState(false);
  const [who, setWho] = useState('');
  const [find, setFind] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (err) errRef.current?.focus();
  }, [err]);
  if (error) return <p className="banner">{error}</p>;
  if (!data) return <p className="muted">Загрузка…</p>;
  const s: Card = data.subscription;
  const taken = new Set(s.assignments.map((a) => a.employee_id));
  const candidates = (emps.data?.employees ?? []).filter((e: Employee) => !taken.has(e.id));
  const fk = find.trim().toLocaleLowerCase('ru').replaceAll('ё', 'е');
  const matching = fk ? candidates.filter((e) => `${e.name} ${e.department}`.toLocaleLowerCase('ru').replaceAll('ё', 'е').includes(fk)) : candidates;
  const picked = candidates.find((c) => String(c.id) === who);
  const options = matching.slice(0, PICK_LIMIT);
  if (picked && !options.includes(picked)) options.unshift(picked);
  const fail = (e: unknown) => {
    setErr(errText(e));
    const fresh = e instanceof ApiError ? (e.data as { subscription?: Card } | undefined)?.subscription : undefined;
    if (fresh) setData({ subscription: fresh });
  };
  const assign = async () => {
    if (!who) return setErr('Выберите сотрудника');
    setBusy(true);
    setErr(null);
    try {
      const r = await api.assign(s.id, Number(who));
      setData({ subscription: r.subscription });
      const name = candidates.find((c) => c.id === Number(who))?.name ?? '';
      setWho('');
      setFind('');
      done(r.changed ? `${name} получает место в «${s.service}». Свободно: ${r.subscription.free}` : `${name} уже занимает место в «${s.service}»`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel card" aria-labelledby="card-h" data-testid="card">
      <button
        type="button"
        className="btn btn--ghost back"
        onClick={() => {
          const el = document.querySelector<HTMLButtonElement>('.sub--on');
          el?.focus({ preventScroll: true });
          el?.scrollIntoView({ block: 'center' });
        }}
      >
        ← К списку подписок
      </button>
      <h2 id="card-h" tabIndex={-1} ref={headRef}>
        {s.service} · {s.plan} {s.status === 'cancelled' ? <span className="pill pill--muted">отменена</span> : null}
      </h2>
      <dl className="facts">
        <div>
          <dt>Места</dt>
          <dd data-testid="seats">
            <SeatBar used={s.used} seats={s.seats} /> {seatsText(s.used, s.seats)}, свободно {s.free}
          </dd>
        </div>
        <div>
          <dt>Сумма</dt>
          <dd>
            {money(s.price_minor, s.currency)} {PER_TEXT[s.period]}
          </dd>
        </div>
        <div>
          <dt>Продление</dt>
          <dd data-testid="renews">
            {dayText(s.renews_on)}, {daysText(s.days_left)}
          </dd>
        </div>
      </dl>
      {err ? (
        <p className="banner" role="alert" tabIndex={-1} ref={errRef} data-testid="card-error">
          {err}
        </p>
      ) : null}
      {editing ? (
        <SubFormView
          title="Изменить подписку"
          submitText="Сохранить"
          withService={false}
          initial={{ service: s.service, plan: s.plan, seats: s.seats, period: s.period, price: moneyInput(s.price_minor), currency: s.currency, renews_on: s.renews_on }}
          onCancel={() => setEditing(false)}
          onSubmit={async (f) => {
            try {
              const r = await api.edit(s.id, { version: s.version, plan: f.plan, seats: f.seats, period: f.period, price: f.price, currency: f.currency, renews_on: f.renews_on });
              setData({ subscription: r.subscription });
              setEditing(false);
              done(`Подписка «${s.service}» сохранена`);
            } catch (e) {
              const fresh = e instanceof ApiError ? (e.data as { subscription?: Card } | undefined)?.subscription : undefined;
              if (e instanceof ApiError && e.code === 'version_conflict' && fresh) {
                setData({ subscription: fresh });
                setEditing(false);
                setErr('Подписку уже изменили в другой вкладке. Показаны текущие данные, внесите правку заново.');
                return;
              }
              throw e;
            }
          }}
        />
      ) : s.status === 'active' ? (
        <div className="row">
          <button type="button" className="btn" onClick={() => (setEditing(true), setErr(null))}>
            Изменить
          </button>
          <button
            type="button"
            className="btn"
            onClick={async () => {
              setErr(null);
              try {
                const r = await api.renewed(s.id, s.version);
                setData({ subscription: r.subscription });
                done(`Продление «${s.service}» отмечено. Следующее — ${dayText(r.subscription.renews_on)}`);
              } catch (e) {
                fail(e);
              }
            }}
          >
            Продление оплачено
          </button>
          {s.used === 0 ? (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={async () => {
                try {
                  const r = await api.edit(s.id, { version: s.version, status: 'cancelled' });
                  setData({ subscription: r.subscription });
                  done(`Подписка «${s.service}» отменена`);
                } catch (e) {
                  fail(e);
                }
              }}
            >
              Отменить подписку
            </button>
          ) : null}
        </div>
      ) : null}

      <h3>Занятые места: {s.used}</h3>
      {s.assignments.length ? (
        <ul className="people">
          {s.assignments.map((a) => (
            <li key={a.id} data-testid="assignment" data-name={a.employee}>
              <span>
                <strong>{a.employee}</strong> <span className="muted small">{a.department} · с {dateTime(a.assigned_at)}</span>
              </span>
              <button
                type="button"
                className="btn btn--ghost"
                aria-label={`Освободить место: ${a.employee}`}
                onClick={async () => {
                  setErr(null);
                  try {
                    const r = await api.release(a.id);
                    setData({ subscription: r.subscription });
                    done(r.changed ? `Место ${a.employee} в «${s.service}» освобождено` : 'Место уже было освобождено');
                  } catch (e) {
                    fail(e);
                  }
                }}
              >
                Освободить
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Мест не назначено.</p>
      )}
      {s.status === 'active' ? (
        s.free > 0 ? (
          <form
            className="row assign"
            onSubmit={(e) => {
              e.preventDefault();
              void assign();
            }}
          >
            {candidates.length > PICK_LIMIT ? (
              <div className="field">
                <label htmlFor="assign-find">Найти сотрудника</label>
                <input id="assign-find" type="search" value={find} onChange={(e) => setFind(e.target.value)} aria-describedby="assign-found" />
                <span className="hint" id="assign-found">
                  {matching.length > PICK_LIMIT ? `Найдено ${matching.length}, в списке первые ${PICK_LIMIT}: уточните поиск` : `Найдено: ${matching.length}`}
                </span>
              </div>
            ) : null}
            <div className="field field--grow">
              <label htmlFor="assign-who">Назначить место сотруднику</label>
              <select id="assign-who" value={who} onChange={(e) => (setWho(e.target.value), setErr(null))}>
                <option value="">— выберите —</option>
                {options.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                    {e.department ? ` · ${e.department}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn btn--primary" disabled={busy}>
              Назначить место
            </button>
          </form>
        ) : (
          <p className="warn" data-testid="no-seats">
            Свободных мест нет: занято {s.used} из {s.seats}. Освободите место или увеличьте число мест в тарифе.
          </p>
        )
      ) : null}

      <details className="history">
        <summary>История мест: {s.history.length}</summary>
        {s.history.length ? (
          <ul>
            {s.history.map((a) => (
              <li key={a.id}>
                {a.employee}: {dateTime(a.assigned_at)} — {dateTime(a.released_at!)}
                {a.released_by ? `, освободил(а) ${a.released_by}` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Освобождённых мест не было.</p>
        )}
      </details>
      <details className="history">
        <summary>Журнал изменений</summary>
        <ul>
          {s.events.map((e, i) => (
            <li key={i}>
              {dateTime(e.at)} · {e.actor ?? 'система'}: {e.kind_text}
              {e.employee ? ` — ${e.employee}` : ''}
              {e.details ? ` (${e.details})` : ''}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
});

/* ---------------- Платежи ---------------- */

function Totals({ r }: { r: Renewals }) {
  if (!r.totals.length) return <p className="muted">Платежей в этом окне нет.</p>;
  return (
    <ul className="totals" data-testid="totals">
      {r.totals.map((t) => (
        <li key={t.currency} className="total" data-currency={t.currency}>
          <span className="total__sum">{money(t.amount_minor, t.currency)}</span>
          <span className="muted small">
            {t.currency}, платежей: {t.count}
          </span>
        </li>
      ))}
    </ul>
  );
}

function RenewalsView({ tick, done, open }: { tick: number; done: Done; open: (id: number) => void }) {
  const [days, setDays] = useState(30);
  const { data, error, reload } = useLoad(() => api.renewals(days), [days, tick]);
  const [err, setErr] = useState<string | null>(null);
  const errRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (err) errRef.current?.focus();
  }, [err]);
  /** Отметить оплату. Если ответ не дошёл, проверяем по карточке, сдвинулась ли дата: повторный щелчок сдвинул бы её ещё на период. */
  const paid = async (s: Payment) => {
    setErr(null);
    try {
      const r = await api.renewed(s.id, s.version);
      done(`Продление «${s.service}» отмечено. Следующее — ${dayText(r.subscription.renews_on)}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'network') {
        const fresh = await api.card(s.id).catch(() => null);
        if (fresh && fresh.subscription.renews_on !== s.renews_on) {
          done(`Продление «${s.service}» отмечено (ответ сервера потерялся, дата проверена). Следующее — ${dayText(fresh.subscription.renews_on)}`);
          return;
        }
      }
      setErr(`«${s.service}»: ${errText(e)}`);
      reload();
    }
  };
  if (error) return <p className="banner">{error}</p>;
  return (
    <main className="stack">
      <div className="filters">
        <div className="field">
          <label htmlFor="within">Платежи на ближайшие</label>
          <select id="within" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 14, 30, 60, 90].map((d) => (
              <option key={d} value={d}>
                {d} дней
              </option>
            ))}
          </select>
        </div>
      </div>
      {err ? (
        <p className="banner" role="alert" tabIndex={-1} ref={errRef} data-testid="pay-error">
          {err}
        </p>
      ) : null}
      {!data ? (
        <p className="muted">Загрузка…</p>
      ) : (
        <>
          <section className="panel" aria-labelledby="tot-h">
            <h2 id="tot-h">Итого по валютам за {days} дней</h2>
            <p className="hint">Суммы в разных валютах не складываются. Каждый платёж окна считается отдельно: месячная подписка за 90 дней — три платежа.</p>
            <Totals r={data} />
          </section>
          {data.overdue.length ? (
            <section className="panel panel--warn" aria-labelledby="od-h">
              <h2 id="od-h">Дата продления прошла: {data.overdue.length}</h2>
              <p className="hint">Эти даты не входят в итог. Если платёж прошёл, отметьте его: дата сдвинется на период.</p>
              <RenewalTable rows={data.overdue} open={open} paid={paid} />
            </section>
          ) : null}
          <section className="panel" aria-labelledby="up-h">
            <h2 id="up-h">Платежи в окне: {data.upcoming.length}</h2>
            {data.upcoming.length ? <RenewalTable rows={data.upcoming} open={open} paid={paid} /> : <p className="empty">В этом окне продлений нет.</p>}
          </section>
        </>
      )}
    </main>
  );
}

function RenewalTable({ rows, open, paid }: { rows: Payment[]; open: (id: number) => void; paid: (s: Payment) => Promise<void> }) {
  return (
    <table className="data cards-sm">
      <thead>
        <tr>
          <th scope="col">Дата</th>
          <th scope="col">Подписка</th>
          <th scope="col">Сумма</th>
          <th scope="col">Действия</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => (
          <tr key={`${s.id}-${s.due_on}`} data-testid="renewal" data-sub={s.service} data-projected={s.projected ? '1' : '0'}>
            <td>
              <strong>{dayText(s.due_on, false)}</strong> <span className="muted small">{daysText(s.days_left)}</span>
            </td>
            <td>
              <button type="button" className="link" onClick={() => open(s.id)}>
                {s.service} · {s.plan}
              </button>
            </td>
            <td>
              {money(s.price_minor, s.currency)} <span className="muted small">за {PERIOD_TEXT[s.period]}</span>
            </td>
            <td>
              {s.projected ? (
                <span className="muted small">следующий период</span>
              ) : (
                <button type="button" className="btn btn--ghost" aria-label={`Продление оплачено: ${s.service}`} onClick={() => void paid(s)}>
                  Оплачено
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ---------------- Сводка ---------------- */

function SummaryView({ tick, open }: { tick: number; open: (id: number) => void }) {
  const { data, error } = useLoad(() => api.summary(), [tick]);
  if (error) return <p className="banner">{error}</p>;
  if (!data) return <p className="muted">Загрузка…</p>;
  const s: Summary = data;
  return (
    <main className="stack">
      <ul className="tiles" data-testid="tiles">
        <li className="tile">
          <span className="tile__n">{s.subscriptions}</span> активных подписок
        </li>
        <li className="tile">
          <span className="tile__n">{s.used}</span> из {s.seats} мест занято
        </li>
        <li className="tile">
          <span className="tile__n">{s.free}</span> свободных лицензий
        </li>
      </ul>
      <section className="panel" aria-labelledby="sum-pay">
        <h2 id="sum-pay">Платежи за 30 дней</h2>
        <Totals r={s.renewals} />
      </section>
      <div className="two">
        <section className="panel" aria-labelledby="sum-free">
          <h2 id="sum-free">Свободные лицензии</h2>
          {s.with_free.length ? (
            <ul className="plain">
              {s.with_free.map((x) => (
                <li key={x.id}>
                  <button type="button" className="link" onClick={() => open(x.id)}>
                    {x.service} · {x.plan}
                  </button>{' '}
                  — свободно {x.free} из {x.seats}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Свободных мест нет.</p>
          )}
        </section>
        <section className="panel" aria-labelledby="sum-full">
          <h2 id="sum-full">Мест нет</h2>
          {s.full.length ? (
            <ul className="plain">
              {s.full.map((x) => (
                <li key={x.id}>
                  <button type="button" className="link" onClick={() => open(x.id)}>
                    {x.service} · {x.plan}
                  </button>{' '}
                  — занято {x.used} из {x.seats}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">У всех подписок есть свободные места.</p>
          )}
        </section>
      </div>
      <p>
        <a className="btn" href={api.csvUrl()} download>
          Скачать CSV подписок
        </a>
      </p>
    </main>
  );
}

/* ---------------- Сотрудники ---------------- */

function PeopleView({ tick, done, open }: { tick: number; done: Done; open: (id: number) => void }) {
  const { data, error } = useLoad(() => api.employees(), [tick]);
  const [sel, setSel] = useState<number | null>(null);
  const person = useLoad(() => (sel ? api.employee(sel) : Promise.resolve(null)), [sel, tick]);
  const [name, setName] = useState('');
  const [dept, setDept] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (error) return <p className="banner">{error}</p>;
  if (!data) return <p className="muted">Загрузка…</p>;
  return (
    <main className="split">
      <section className="panel" aria-labelledby="ppl-h">
        <h2 id="ppl-h">Сотрудники: {data.employees.length}</h2>
        <ul className="plain">
          {data.employees.map((e) => (
            <li key={e.id}>
              <button type="button" className={`link ${sel === e.id ? 'link--on' : ''}`} onClick={() => setSel(e.id)}>
                {e.name}
              </button>{' '}
              <span className="muted small">
                {e.department ? `${e.department} · ` : ''}мест: {e.seats}
              </span>
            </li>
          ))}
        </ul>
        <form
          className="row"
          onSubmit={async (ev) => {
            ev.preventDefault();
            try {
              const r = await api.addEmployee(name, dept);
              setName('');
              setDept('');
              setErr(null);
              setSel(r.employee.id);
              done(`Сотрудник «${r.employee.name}» добавлен`);
            } catch (x) {
              setErr(errText(x));
              document.getElementById('emp-name')?.focus();
            }
          }}
        >
          <div className={`field ${err ? 'field--error' : ''}`}>
            <label htmlFor="emp-name">Новый сотрудник</label>
            <input id="emp-name" value={name} maxLength={120} onChange={(e) => (setName(e.target.value), setErr(null))} aria-invalid={err ? true : undefined} aria-describedby={err ? 'emp-err' : undefined} />
            {err ? (
              <span className="field__error" id="emp-err">
                {err}
              </span>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor="emp-dept">Отдел</label>
            <input id="emp-dept" value={dept} maxLength={120} onChange={(e) => setDept(e.target.value)} />
          </div>
          <button type="submit" className="btn">
            Добавить
          </button>
        </form>
      </section>
      {person.data ? (
        <section className="panel" aria-labelledby="person-h">
          <h2 id="person-h">{person.data.employee.name}</h2>
          {person.data.employee.assignments.length ? (
            <ul className="plain">
              {person.data.employee.assignments.map((a) => (
                <li key={a.id}>
                  <button type="button" className="link" onClick={() => open(a.subscription_id)}>
                    {a.service} · {a.plan}
                  </button>{' '}
                  <span className="muted small">с {dateTime(a.assigned_at)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Мест в подписках нет.</p>
          )}
        </section>
      ) : (
        <p className="empty">Выберите сотрудника, чтобы увидеть его подписки.</p>
      )}
    </main>
  );
}
