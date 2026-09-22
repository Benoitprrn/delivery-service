-- R50 : exécution du prélèvement SEPA du restaurant (PaymentIntent plateforme).
-- Chaque `debit_attempt` porte la traçabilité exigée par R60 (PaymentIntent, charge, règlement) et l'instantané du moyen de paiement
-- utilisé ; la base refuse un débit dont le mandat n'est pas EXACTEMENT celui de la pré-notification envoyée (R41).

alter table public.debit_attempts
  add column pre_notification_id uuid null references public.settlement_pre_notifications(id),
  add column stripe_payment_method_id text null,
  add column stripe_mandate_id text null,
  add column mandate_reference text null,
  add column claim_token uuid null,
  add column lease_expires_at timestamptz null,
  add column next_sync_at timestamptz null,
  add column last_synced_at timestamptz null,
  add column sync_error_class text null,
  add constraint debit_attempts_claim_check check ((claim_token is null) = (lease_expires_at is null)),
  add constraint debit_attempts_pi_snapshot_check check (status not in ('processing','succeeded') or stripe_payment_intent_id is not null);
create index debit_attempts_due_idx on public.debit_attempts(next_sync_at) where status in ('creating','processing');

-- Distinction NETTE : `failed` = rejet réel du prélèvement par la banque/Stripe (le restaurant reste débiteur) ; `technical_error` = mauvaise
-- requête, configuration Stripe, incohérence ou erreur interne Locadely (intervention requise, le restaurant n'est JAMAIS qualifié d'impayé).
alter table public.debit_attempts drop constraint debit_attempts_status_check;
alter table public.debit_attempts
  add column technical_error_at timestamptz null,
  add constraint debit_attempts_status_check check (status in ('creating','processing','succeeded','failed','canceled','technical_error')),
  add constraint debit_attempts_technical_check check ((status = 'technical_error') = (technical_error_at is not null) and (status <> 'technical_error' or failure_code is not null)),
  add constraint debit_attempts_failed_check check (status <> 'failed' or (failed_at is not null and failure_code is not null));
alter table public.merchant_settlements drop constraint merchant_settlements_status_check;
alter table public.merchant_settlements
  add constraint merchant_settlements_status_check check (status in ('pending_notification','notified','debit_scheduled','debit_processing','succeeded','failed','technical_hold'));

alter table public.merchant_settlements
  add column debit_blocked_reason text null,
  add column debit_blocked_at timestamptz null,
  add constraint merchant_settlements_debit_blocked_check check ((debit_blocked_reason is null) = (debit_blocked_at is null));

create or replace function public.guard_debit_pre_notification() returns trigger language plpgsql set search_path = '' as $$
declare n record; debit_day date;
begin
  select * into n from public.settlement_pre_notifications
   where merchant_settlement_id = new.merchant_settlement_id and status = 'sent';
  if not found then
    raise exception 'le débit exige une pré-notification envoyée (au moins deux jours calendaires avant)';
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
