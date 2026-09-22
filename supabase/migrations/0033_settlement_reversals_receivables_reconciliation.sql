create table public.driver_transfer_reversals (
  id uuid primary key default gen_random_uuid(),
  driver_transfer_id uuid not null references public.driver_transfers(id),
  category text not null check (category in ('driver_fault','locadely_error')),
  amount_cents bigint not null check (amount_cents > 0),
  reason text not null check (btrim(reason) <> ''),
  decision_reference text not null check (btrim(decision_reference) <> ''),
  requested_by uuid not null, approved_by uuid null,
  status text not null default 'pending_approval' check (status in ('pending_approval','approved','executing','succeeded','failed','rejected')),
  stripe_reversal_id text unique null, idempotency_key text not null unique, livemode boolean not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint driver_transfer_reversals_approval_check check ((status not in ('approved','executing','succeeded')) or (approved_by is not null and approved_by <> requested_by))
);
create function public.guard_driver_transfer_reversal() returns trigger language plpgsql set search_path = '' as $$
declare transfer_amount bigint; live_total bigint; transfer_status text; transfer_livemode boolean;
begin
  select amount_cents,status,livemode into transfer_amount,transfer_status,transfer_livemode from public.driver_transfers where id=new.driver_transfer_id for update;
  if not found or transfer_status <> 'succeeded' then raise exception 'une reversal exige un transfert réussi'; end if;
  if new.livemode <> transfer_livemode then raise exception 'le mode Stripe de la reversal doit correspondre au transfert'; end if;
  select coalesce(sum(amount_cents),0) into live_total from public.driver_transfer_reversals where driver_transfer_id=new.driver_transfer_id and status in ('pending_approval','approved','executing','succeeded') and id is distinct from new.id;
  if new.status in ('pending_approval','approved','executing','succeeded') then live_total := live_total + new.amount_cents; end if;
  if live_total > transfer_amount then raise exception 'les reversals vivantes dépassent le montant du transfert'; end if;
  return new;
end;
$$;
revoke execute on function public.guard_driver_transfer_reversal() from anon, authenticated, public;
create trigger driver_transfer_reversals_guard before insert or update of driver_transfer_id, amount_cents, status, livemode on public.driver_transfer_reversals for each row execute function public.guard_driver_transfer_reversal();
create index driver_transfer_reversals_transfer_id_idx on public.driver_transfer_reversals(driver_transfer_id);

create table public.merchant_receivables (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id),
  merchant_settlement_id uuid null references public.merchant_settlements(id),
  kind text not null check (kind in ('sepa_failure_fee','sepa_dispute','sepa_dispute_fee','other')),
  amount_cents bigint not null check (amount_cents > 0),
  status text not null default 'open' check (status in ('open','recovered','written_off')),
  stripe_charge_id text null, stripe_dispute_id text null unique,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table public.driver_receivables (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.drivers(id),
  driver_transfer_reversal_id uuid not null unique references public.driver_transfer_reversals(id),
  amount_cents bigint not null check (amount_cents > 0),
  status text not null default 'open' check (status in ('open','recovered','written_off')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index merchant_receivables_merchant_id_idx on public.merchant_receivables(merchant_id);
create index driver_receivables_driver_id_idx on public.driver_receivables(driver_id);

create table public.settlement_reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(), finished_at timestamptz null,
  status text not null default 'running' check (status in ('running','completed','failed')),
  checked_count integer not null default 0 check (checked_count >= 0),
  discrepancy_count integer not null default 0 check (discrepancy_count >= 0),
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.settlement_reconciliation_findings (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.settlement_reconciliation_runs(id),
  kind text not null, ref_type text not null, ref_id text not null,
  expected_cents bigint null, actual_cents bigint null,
  details jsonb not null default '{}'::jsonb, resolved_at timestamptz null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index settlement_reconciliation_findings_run_idx on public.settlement_reconciliation_findings(run_id, resolved_at);

alter table public.driver_transfer_reversals enable row level security;
alter table public.merchant_receivables enable row level security;
alter table public.driver_receivables enable row level security;
alter table public.settlement_reconciliation_runs enable row level security;
alter table public.settlement_reconciliation_findings enable row level security;
revoke all privileges on table public.driver_transfer_reversals, public.merchant_receivables, public.driver_receivables, public.settlement_reconciliation_runs, public.settlement_reconciliation_findings from anon, authenticated;
