create table if not exists public.merchant_stripe_connect (
  merchant_id uuid primary key references public.merchants(id) on delete cascade,
  merchant_configured_at timestamptz null,
  card_payments_status text not null default 'not_requested',
  cartes_bancaires_status text not null default 'not_requested',
  requirements_count integer not null default 0,
  last_synced_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint merchant_stripe_connect_card_payments_status_check check (card_payments_status in ('active', 'pending', 'restricted', 'inactive', 'not_requested')),
  constraint merchant_stripe_connect_cartes_bancaires_status_check check (cartes_bancaires_status in ('active', 'pending', 'restricted', 'inactive', 'not_requested')),
  constraint merchant_stripe_connect_requirements_count_check check (requirements_count >= 0)
);

create table if not exists public.merchant_terminal_locations (
  merchant_id uuid primary key references public.merchants(id) on delete cascade,
  stripe_account_id text not null,
  terminal_location_id text not null,
  created_at timestamptz not null default now(),
  constraint merchant_terminal_locations_terminal_location_id_key unique (terminal_location_id)
);

create table if not exists public.order_delivery_completion_sessions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  driver_id uuid not null references public.drivers(id),
  expected_order_version integer not null,
  status text not null,
  code_verified_at timestamptz null,
  expires_at timestamptz not null,
  completed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint order_delivery_completion_sessions_expected_order_version_check check (expected_order_version >= 1),
  constraint order_delivery_completion_sessions_status_check check (status in ('open', 'code_verified', 'payment_pending', 'payment_succeeded', 'completed', 'abandoned', 'expired'))
);
create index if not exists order_delivery_completion_sessions_order_id_idx on public.order_delivery_completion_sessions(order_id);
create index if not exists order_delivery_completion_sessions_driver_id_idx on public.order_delivery_completion_sessions(driver_id);
create unique index if not exists order_delivery_completion_sessions_one_active_order_idx
  on public.order_delivery_completion_sessions(order_id)
  where status in ('open', 'code_verified', 'payment_pending', 'payment_succeeded');

create table if not exists public.order_cash_on_delivery_payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  session_id uuid not null references public.order_delivery_completion_sessions(id),
  merchant_id uuid not null references public.merchants(id),
  driver_id uuid not null references public.drivers(id),
  attempt_no smallint not null,
  stripe_account_id text not null,
  amount_cents integer not null,
  currency text not null,
  stripe_payment_intent_id text null,
  stripe_charge_id text null,
  status text not null,
  capture_idempotency_key text not null,
  create_idempotency_key text not null,
  reader_type text not null,
  reader_serial text null,
  terminal_location_id text not null,
  failure_code text null,
  decline_code text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  authorized_at timestamptz null,
  captured_at timestamptz null,
  failed_at timestamptz null,
  canceled_at timestamptz null,
  constraint order_cash_on_delivery_payments_order_attempt_key unique (order_id, attempt_no),
  constraint order_cash_on_delivery_payments_stripe_payment_intent_id_key unique (stripe_payment_intent_id),
  constraint order_cash_on_delivery_payments_stripe_charge_id_key unique (stripe_charge_id),
  constraint order_cash_on_delivery_payments_create_idempotency_key_key unique (create_idempotency_key),
  constraint order_cash_on_delivery_payments_attempt_no_check check (attempt_no >= 1),
  constraint order_cash_on_delivery_payments_amount_cents_check check (amount_cents between 100 and 50000),
  constraint order_cash_on_delivery_payments_currency_check check (currency = 'eur'),
  constraint order_cash_on_delivery_payments_status_check check (status in ('created', 'intent_created', 'processing', 'authorized', 'captured', 'failed', 'canceled', 'unknown')),
  constraint order_cash_on_delivery_payments_reader_type_check check (reader_type in ('simulated_bluetooth', 'bluetooth', 'usb', 'internet'))
);
create index if not exists order_cash_on_delivery_payments_order_id_idx on public.order_cash_on_delivery_payments(order_id);
create index if not exists order_cash_on_delivery_payments_session_id_idx on public.order_cash_on_delivery_payments(session_id);
create index if not exists order_cash_on_delivery_payments_merchant_id_idx on public.order_cash_on_delivery_payments(merchant_id);
create index if not exists order_cash_on_delivery_payments_driver_id_idx on public.order_cash_on_delivery_payments(driver_id);
create unique index if not exists order_cash_on_delivery_payments_one_active_order_idx
  on public.order_cash_on_delivery_payments(order_id)
  where status in ('created', 'intent_created', 'processing', 'authorized', 'unknown');
create unique index if not exists order_cash_on_delivery_payments_one_captured_order_idx
  on public.order_cash_on_delivery_payments(order_id) where status = 'captured';

create or replace function public.verify_cash_on_delivery_payment_snapshot()
returns trigger language plpgsql set search_path = '' as $$
declare
  snapshot_amount integer;
  snapshot_currency text;
  required boolean;
begin
  select cash_on_delivery_amount_cents, cash_on_delivery_currency, cash_on_delivery_required
    into snapshot_amount, snapshot_currency, required
    from public.orders where id = new.order_id;
  if not found or required is not true or new.amount_cents <> snapshot_amount or new.currency <> snapshot_currency then
    raise exception 'cash on delivery payment must match order snapshot';
  end if;
  return new;
end;
$$;
revoke execute on function public.verify_cash_on_delivery_payment_snapshot() from anon, authenticated, public;
drop trigger if exists order_cash_on_delivery_payments_snapshot on public.order_cash_on_delivery_payments;
create trigger order_cash_on_delivery_payments_snapshot
  before insert on public.order_cash_on_delivery_payments
  for each row execute function public.verify_cash_on_delivery_payment_snapshot();

alter table public.merchant_stripe_connect enable row level security;
alter table public.merchant_terminal_locations enable row level security;
alter table public.order_delivery_completion_sessions enable row level security;
alter table public.order_cash_on_delivery_payments enable row level security;
revoke all privileges on table public.merchant_stripe_connect, public.merchant_terminal_locations, public.order_delivery_completion_sessions, public.order_cash_on_delivery_payments from anon, authenticated;
