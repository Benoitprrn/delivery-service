-- R60 : paiement des livreurs (pay-run groupé puis compte-gouttes, Transfers `source_transaction`).
-- Traçabilité de la destination, suivi des blocages par statement et garde de base : aucun Transfer vers un compte qui n'est pas
-- LE compte Stripe ACTIF du livreur du statement.

alter table public.settlement_statements
  add column payout_hold_reason text null,
  add column payout_next_attempt_at timestamptz null;

alter table public.driver_transfers
  add column destination_account_id text null,
  add column failed_at timestamptz null;

-- Au plus un pay-run ouvert (pending/running) par livreur et période : plusieurs workers ne créent jamais deux lots en parallèle.
create unique index driver_pay_runs_one_open_idx on public.driver_pay_runs(period_id, driver_id) where status in ('pending','running');

create or replace function public.guard_driver_transfer() returns trigger language plpgsql set search_path = '' as $$
declare s record; d record; r record; statement_live_total bigint; debit_live_total bigint;
begin
  select st.*, sp.payrun_at into s from public.settlement_statements st join public.settlement_periods sp on sp.id=st.period_id where st.id=new.statement_id for update of st;
  if not found then raise exception 'statement introuvable'; end if;
  select * into d from public.debit_attempts where id=new.debit_attempt_id for update;
  if not found or d.status <> 'succeeded' then raise exception 'un transfert exige un débit réussi'; end if;
  if new.livemode <> d.livemode then raise exception 'le mode Stripe du transfert doit correspondre au débit'; end if;
  if d.merchant_settlement_id <> s.merchant_settlement_id then raise exception 'le débit doit appartenir au même règlement restaurant'; end if;
  if d.stripe_charge_id is null or new.stripe_charge_id <> d.stripe_charge_id then raise exception 'la charge source doit correspondre à celle du débit'; end if;
  if s.payrun_at is null or now() < s.payrun_at then raise exception 'aucun transfert n’est autorisé avant payrun_at'; end if;
  if new.destination_account_id is not null and not exists (
    select 1 from public.driver_connect_accounts ca where ca.driver_id = s.driver_id and ca.stripe_account_id = new.destination_account_id and ca.transfers_status = 'active'
  ) then raise exception 'la destination doit être le compte Stripe ACTIF du livreur du statement'; end if;
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
