create table public.debit_attempts (
  id uuid primary key default gen_random_uuid(),
  merchant_settlement_id uuid not null,
  attempt_no integer not null check (attempt_no > 0),
  amount_cents bigint not null check (amount_cents > 0),
  currency text not null default 'eur' check (currency = 'eur'),
  stripe_account_id text not null,
  stripe_payment_intent_id text unique null,
  stripe_charge_id text unique null,
  idempotency_key text not null unique,
  status text not null default 'creating' check (status in ('creating','processing','succeeded','failed','canceled')),
  failure_code text null,
  submitted_at timestamptz null, succeeded_at timestamptz null, failed_at timestamptz null,
  available_on timestamptz null, livemode boolean not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (merchant_settlement_id, attempt_no),
  constraint debit_attempts_succeeded_snapshot_check check (status <> 'succeeded' or (stripe_payment_intent_id is not null and stripe_charge_id is not null and succeeded_at is not null)),
  constraint debit_attempts_amount_fk foreign key (merchant_settlement_id, amount_cents) references public.merchant_settlements(id, amount_cents)
);
create unique index debit_attempts_one_living_idx on public.debit_attempts(merchant_settlement_id) where status in ('creating','processing');
create unique index debit_attempts_one_succeeded_idx on public.debit_attempts(merchant_settlement_id) where status = 'succeeded';

create function public.guard_debit_pre_notification() returns trigger language plpgsql set search_path = '' as $$
declare notified_at timestamptz;
begin
  select pre_notified_at into notified_at from public.merchant_settlements where id = new.merchant_settlement_id;
  if notified_at is null or (notified_at at time zone 'UTC')::date > (new.created_at at time zone 'UTC')::date - 2 then
    raise exception 'le débit exige une pré-notification datant d’au moins deux jours calendaires';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_debit_pre_notification() from anon, authenticated, public;
create trigger debit_attempts_pre_notification before insert on public.debit_attempts for each row execute function public.guard_debit_pre_notification();

create table public.driver_pay_runs (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.settlement_periods(id),
  driver_id uuid not null references public.drivers(id),
  run_kind text not null check (run_kind in ('grouped','drip')),
  scheduled_for timestamptz not null,
  status text not null default 'pending' check (status in ('pending','running','completed','failed')),
  claimed_by text null, lease_expires_at timestamptz null, started_at timestamptz null, completed_at timestamptz null,
  statements_total integer not null default 0 check (statements_total >= 0),
  statements_paid integer not null default 0 check (statements_paid between 0 and statements_total),
  amount_cents bigint not null default 0 check (amount_cents >= 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index driver_pay_runs_one_grouped_idx on public.driver_pay_runs(period_id, driver_id) where run_kind = 'grouped';
create function public.guard_grouped_pay_run() returns trigger language plpgsql set search_path = '' as $$
declare period_payrun_at timestamptz;
begin
  if new.run_kind = 'grouped' then
    select payrun_at into period_payrun_at from public.settlement_periods where id = new.period_id;
    if period_payrun_at is null or new.scheduled_for <> period_payrun_at then raise exception 'un pay-run groupé doit être planifié exactement à payrun_at'; end if;
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_grouped_pay_run() from anon, authenticated, public;
create trigger driver_pay_runs_grouped_guard before insert or update of run_kind, period_id, scheduled_for on public.driver_pay_runs for each row execute function public.guard_grouped_pay_run();

create table public.driver_transfers (
  id uuid primary key default gen_random_uuid(),
  statement_id uuid not null references public.settlement_statements(id),
  pay_run_id uuid not null references public.driver_pay_runs(id),
  debit_attempt_id uuid not null references public.debit_attempts(id),
  stripe_charge_id text not null,
  amount_cents bigint not null check (amount_cents > 0),
  funding_mode text not null default 'source_transaction' check (funding_mode = 'source_transaction'),
  try_no integer not null check (try_no > 0),
  idempotency_key text not null unique,
  status text not null default 'creating' check (status in ('creating','succeeded','failed','unknown')),
  stripe_transfer_id text unique null, stripe_destination_payment_id text null, annotated_at timestamptz null,
  failure_code text null, submitted_at timestamptz null, succeeded_at timestamptz null, livemode boolean not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (statement_id, debit_attempt_id, try_no),
  constraint driver_transfers_succeeded_snapshot_check check (status <> 'succeeded' or (stripe_transfer_id is not null and succeeded_at is not null))
);
create unique index driver_transfers_one_living_idx on public.driver_transfers(statement_id, debit_attempt_id) where status in ('creating','succeeded','unknown');

create function public.guard_driver_transfer() returns trigger language plpgsql set search_path = '' as $$
declare s record; d record; p record; r record; statement_live_total bigint; debit_live_total bigint;
begin
  select st.*, sp.payrun_at into s from public.settlement_statements st join public.settlement_periods sp on sp.id=st.period_id where st.id=new.statement_id for update of st;
  if not found then raise exception 'statement introuvable'; end if;
  select * into d from public.debit_attempts where id=new.debit_attempt_id for update;
  if not found or d.status <> 'succeeded' then raise exception 'un transfert exige un débit réussi'; end if;
  if new.livemode <> d.livemode then raise exception 'le mode Stripe du transfert doit correspondre au débit'; end if;
  if d.merchant_settlement_id <> s.merchant_settlement_id then raise exception 'le débit doit appartenir au même règlement restaurant'; end if;
  if d.stripe_charge_id is null or new.stripe_charge_id <> d.stripe_charge_id then raise exception 'la charge source doit correspondre à celle du débit'; end if;
  if s.payrun_at is null or now() < s.payrun_at then raise exception 'aucun transfert n’est autorisé avant payrun_at'; end if;
  select * into r from public.driver_pay_runs where id=new.pay_run_id;
  if not found or r.period_id <> s.period_id or r.driver_id <> s.driver_id then raise exception 'le pay-run doit appartenir à la même période et au même livreur'; end if;
  select coalesce(sum(amount_cents),0) into statement_live_total from public.driver_transfers where statement_id=new.statement_id and status in ('creating','succeeded','unknown') and id is distinct from new.id;
  if new.status in ('creating','succeeded','unknown') then statement_live_total := statement_live_total + new.amount_cents; end if;
  if statement_live_total > s.due_cents then raise exception 'les transferts vivants dépassent le dû du statement'; end if;
  select coalesce(sum(amount_cents),0) into debit_live_total from public.driver_transfers where debit_attempt_id=new.debit_attempt_id and status in ('creating','succeeded','unknown') and id is distinct from new.id;
  if new.status in ('creating','succeeded','unknown') then debit_live_total := debit_live_total + new.amount_cents; end if;
  if debit_live_total > d.amount_cents then raise exception 'les transferts vivants dépassent le montant du débit'; end if;
  return new;
end;
$$;
revoke execute on function public.guard_driver_transfer() from anon, authenticated, public;
create trigger driver_transfers_guard before insert or update of amount_cents, status, debit_attempt_id, statement_id, pay_run_id, stripe_charge_id, livemode on public.driver_transfers for each row execute function public.guard_driver_transfer();

create function public.assert_statement_paid_cents() returns trigger language plpgsql set search_path = '' as $$
declare statement_to_check uuid; expected_paid_cents bigint; actual_paid_cents bigint;
begin
  if tg_table_name = 'driver_transfers' then
    statement_to_check := new.statement_id;
  else
    statement_to_check := new.id;
  end if;
  select coalesce(sum(amount_cents), 0) into expected_paid_cents from public.driver_transfers where statement_id = statement_to_check and status = 'succeeded';
  select paid_cents into actual_paid_cents from public.settlement_statements where id = statement_to_check;
  if actual_paid_cents <> expected_paid_cents then raise exception 'paid_cents doit correspondre à la somme des transferts réussis'; end if;
  return null;
end;
$$;
revoke execute on function public.assert_statement_paid_cents() from anon, authenticated, public;
create constraint trigger driver_transfers_paid_cents after insert or update on public.driver_transfers deferrable initially deferred for each row execute function public.assert_statement_paid_cents();
create constraint trigger settlement_statements_paid_cents after update of paid_cents on public.settlement_statements deferrable initially deferred for each row execute function public.assert_statement_paid_cents();

create index driver_pay_runs_driver_id_idx on public.driver_pay_runs(driver_id);
create index driver_transfers_pay_run_id_idx on public.driver_transfers(pay_run_id);
create index driver_transfers_debit_attempt_id_idx on public.driver_transfers(debit_attempt_id);

alter table public.debit_attempts enable row level security;
alter table public.driver_pay_runs enable row level security;
alter table public.driver_transfers enable row level security;
revoke all privileges on table public.debit_attempts, public.driver_pay_runs, public.driver_transfers from anon, authenticated;
