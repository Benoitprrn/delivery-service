-- R70 : incidents, webhooks, réconciliation, relance manuelle d'un prélèvement restaurant.
-- (1) une pré-notification PAR TENTATIVE de débit (toute relance exige une nouvelle pré-notification, ≥ 2 jours calendaires) ;
-- (2) incidents post-encaissement (SEPA contesté/retourné) rattachés au RESTAURANT, jamais un reversal livreur (D-A/D-O) ;
-- (3) journal des webhooks plateforme (déclencheurs sans payload) ; (4) constats de réconciliation classés restaurant / technique Locadely.

-- (1) Pré-notification par tentative -------------------------------------------------------------------------------------------------
alter table public.settlement_pre_notifications
  add column attempt_no integer not null default 1 check (attempt_no > 0),
  add column requested_by uuid null,
  add column retry_reason text null,
  add constraint settlement_pre_notifications_retry_check check (attempt_no = 1 or (requested_by is not null and btrim(coalesce(retry_reason, '')) <> ''));
alter table public.settlement_pre_notifications drop constraint settlement_pre_notifications_merchant_settlement_id_key;
alter table public.settlement_pre_notifications add constraint settlement_pre_notifications_attempt_key unique (merchant_settlement_id, attempt_no);

-- Le miroir `pre_notified_at` reste celui de la PREMIÈRE tentative.
create or replace function public.mirror_settlement_pre_notification() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.attempt_no = 1 and new.status = 'sent' and (tg_op = 'INSERT' or old.status is distinct from 'sent') then
    update public.merchant_settlements
       set pre_notified_at = new.sent_at, status = case when status = 'pending_notification' then 'notified' else status end, updated_at = now()
     where id = new.merchant_settlement_id;
  end if;
  return null;
end;
$$;
create or replace function public.guard_merchant_settlement_pre_notified_at() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.pre_notified_at is not null then raise exception 'pre_notified_at exige une pré-notification envoyée'; end if;
    return new;
  end if;
  if new.pre_notified_at is distinct from old.pre_notified_at then
    if old.pre_notified_at is not null then raise exception 'pre_notified_at est immuable une fois posé'; end if;
    if new.pre_notified_at is null or not exists (
      select 1 from public.settlement_pre_notifications n
       where n.merchant_settlement_id = new.id and n.attempt_no = 1 and n.amount_cents = new.amount_cents and n.status = 'sent' and n.sent_at = new.pre_notified_at
    ) then raise exception 'pre_notified_at exige une pré-notification envoyée de même montant'; end if;
  end if;
  return new;
end;
$$;

-- Garde du débit : la pré-notification de LA tentative (`attempt_no`) doit être envoyée, ≥ 2 jours calendaires (Europe/Paris) avant, jamais avant la date annoncée,
-- et le mandat du débit est celui de cette pré-notification. Une relance sans nouvelle pré-notification est donc impossible.
create or replace function public.guard_debit_pre_notification() returns trigger language plpgsql set search_path = '' as $$
declare n record; debit_day date;
begin
  select * into n from public.settlement_pre_notifications
   where merchant_settlement_id = new.merchant_settlement_id and attempt_no = new.attempt_no and status = 'sent';
  if not found then
    raise exception 'le débit exige une pré-notification envoyée pour cette tentative (au moins deux jours calendaires avant)';
  end if;
  debit_day := (new.created_at at time zone 'Europe/Paris')::date;
  if (n.sent_at at time zone 'Europe/Paris')::date > debit_day - 2 then
    raise exception 'le débit exige une pré-notification datant d’au moins deux jours calendaires';
  end if;
  if debit_day < n.debit_date then
    raise exception 'le débit ne peut pas précéder la date de prélèvement annoncée dans la pré-notification';
  end if;
  if new.mandate_reference is null or new.mandate_reference is distinct from n.mandate_reference then
    raise exception 'le mandat du débit doit être celui de la pré-notification envoyée';
  end if;
  new.pre_notification_id := n.id;
  return new;
end;
$$;

-- (2) Incidents post-encaissement ---------------------------------------------------------------------------------------------------
create table public.debit_incidents (
  id uuid primary key default gen_random_uuid(),
  debit_attempt_id uuid not null references public.debit_attempts(id),
  kind text not null check (kind in ('dispute','refund')),
  external_id text not null,
  stripe_charge_id text not null,
  amount_cents bigint not null check (amount_cents > 0),
  status text not null check (status in ('open','won','lost','closed')),
  reason text null,
  detected_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (debit_attempt_id, external_id),
  constraint debit_incidents_resolved_check check ((status in ('won','closed')) = (resolved_at is not null) or status in ('open','lost'))
);
create index debit_incidents_attempt_idx on public.debit_incidents(debit_attempt_id);

alter table public.merchant_receivables add column debit_incident_id uuid null unique references public.debit_incidents(id);
alter table public.merchant_receivables drop constraint merchant_receivables_kind_check;
alter table public.merchant_receivables add constraint merchant_receivables_kind_check check (kind in ('sepa_failure_fee','sepa_dispute','sepa_dispute_fee','sepa_refund','other'));

-- Un débit contesté ou remboursé (incident ouvert ou perdu) ne peut plus financer de Transfer.
create or replace function public.guard_driver_transfer() returns trigger language plpgsql set search_path = '' as $$
declare s record; d record; r record; statement_live_total bigint; debit_live_total bigint;
begin
  select st.*, sp.payrun_at into s from public.settlement_statements st join public.settlement_periods sp on sp.id=st.period_id where st.id=new.statement_id for update of st;
  if not found then raise exception 'statement introuvable'; end if;
  select * into d from public.debit_attempts where id=new.debit_attempt_id for update;
  if not found or d.status <> 'succeeded' then raise exception 'un transfert exige un débit réussi'; end if;
  if exists (select 1 from public.debit_incidents i where i.debit_attempt_id = d.id and i.status in ('open','lost')) then raise exception 'le débit est contesté ou remboursé : aucun transfert'; end if;
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

-- (3) Journal des webhooks plateforme (jamais le payload) ---------------------------------------------------------------------------
create table public.settlement_stripe_events (
  event_id text primary key,
  event_type text not null,
  object_id text null,
  payment_intent_id text null,
  charge_id text null,
  transfer_id text null,
  status text not null default 'pending' check (status in ('pending','processing','processed','dead_letter')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  claim_token uuid null,
  lease_expires_at timestamptz null,
  last_error_class text null,
  received_at timestamptz not null default now(),
  processed_at timestamptz null,
  constraint settlement_stripe_events_claim_check check ((status = 'processing') = (claim_token is not null and lease_expires_at is not null)),
  constraint settlement_stripe_events_processed_check check ((status = 'processed') = (processed_at is not null))
);
create index settlement_stripe_events_due_idx on public.settlement_stripe_events(next_attempt_at) where status in ('pending','processing');

-- (4) Constats de réconciliation : incident RESTAURANT ou incident TECHNIQUE Locadely, jamais mélangés ------------------------------
-- Les constats issus d'un audit webhook n'appartiennent à aucun passage quotidien : `run_id` devient facultatif.
alter table public.settlement_reconciliation_findings alter column run_id drop not null;
alter table public.settlement_reconciliation_findings
  add column scope text not null default 'locadely_technical' check (scope in ('restaurant','locadely_technical')),
  add column last_run_id uuid null references public.settlement_reconciliation_runs(id),
  add column last_seen_at timestamptz not null default now();
create unique index settlement_reconciliation_findings_open_idx on public.settlement_reconciliation_findings(kind, ref_type, ref_id) where resolved_at is null;

alter table public.debit_incidents enable row level security;
alter table public.settlement_stripe_events enable row level security;
revoke all privileges on table public.debit_incidents, public.settlement_stripe_events from anon, authenticated;
