import { request } from './api-core';

export type Period = 'month' | 'quarter' | 'year';
export interface Sub {
  id: number;
  service: string;
  service_id: number;
  plan: string;
  seats: number;
  used: number;
  free: number;
  period: Period;
  price_minor: number;
  currency: string;
  renews_on: string;
  days_left: number;
  status: 'active' | 'cancelled';
  version: number;
}
export interface Assignment {
  id: number;
  subscription_id: number;
  employee_id: number;
  employee: string;
  department: string;
  assigned_at: string;
  assigned_by: string | null;
  released_at: string | null;
  released_by: string | null;
}
export interface SubEvent {
  at: string;
  kind: string;
  kind_text: string;
  details: string;
  actor: string | null;
  employee: string | null;
}
export interface Card extends Sub {
  assignments: Assignment[];
  history: Assignment[];
  events: SubEvent[];
}
export interface Employee {
  id: number;
  name: string;
  department: string;
  seats: number;
}
/** Строка платежа: due_on — дата этого платежа, projected — следующий период, посчитанный от сохранённой даты. */
export interface Payment extends Sub {
  due_on: string;
  projected: boolean;
}
export interface Renewals {
  today: string;
  within_days: number;
  upcoming: Payment[];
  overdue: Payment[];
  totals: { currency: string; amount_minor: number; count: number }[];
}
export interface Summary {
  seats: number;
  used: number;
  free: number;
  subscriptions: number;
  full: Sub[];
  with_free: Sub[];
  renewals: Renewals;
}
export interface SubForm {
  service: string;
  plan: string;
  seats: number;
  period: Period;
  price: string;
  currency: string;
  renews_on: string;
}

export const api = {
  subs: (q: string, status: 'active' | 'all') => request<{ subscriptions: Sub[]; today: string }>('GET', `/api/subscriptions?status=${status}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  card: (id: number) => request<{ subscription: Card }>('GET', `/api/subscriptions/${id}`),
  create: (f: SubForm) => request<{ subscription: Card }>('POST', '/api/subscriptions', f),
  edit: (id: number, body: Partial<SubForm> & { version: number; status?: 'active' | 'cancelled' }) => request<{ subscription: Card }>('PATCH', `/api/subscriptions/${id}`, body),
  renewed: (id: number, version: number) => request<{ subscription: Card }>('POST', `/api/subscriptions/${id}/renewed`, { version }),
  assign: (id: number, employee_id: number) => request<{ subscription: Card; changed: boolean }>('POST', `/api/subscriptions/${id}/assignments`, { employee_id }),
  release: (assignmentId: number) => request<{ subscription: Card; changed: boolean }>('POST', `/api/assignments/${assignmentId}/release`),
  renewals: (days: number) => request<Renewals>('GET', `/api/renewals?within_days=${days}`),
  summary: () => request<Summary>('GET', '/api/summary'),
  employees: () => request<{ employees: Employee[] }>('GET', '/api/employees'),
  employee: (id: number) => request<{ employee: { id: number; name: string; department: string; assignments: { id: number; subscription_id: number; service: string; plan: string; assigned_at: string }[] } }>('GET', `/api/employees/${id}`),
  addEmployee: (name: string, department: string) => request<{ employee: { id: number; name: string } }>('POST', '/api/employees', { name, department }),
  csvUrl: () => './api/subscriptions.csv',
};
