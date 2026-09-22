-- R61 : reversals de Transfers déjà effectués (catégories B « faute livreur » et C « erreur Locadely » UNIQUEMENT).
-- Jamais de reversal parce qu'un restaurant échoue, conteste ou ne paie pas : la base n'admet que des motifs énumérés propres à B/C.
-- Le domaine décide (montant réellement reversé + reliquat en `driver_receivable`) AVANT tout appel Stripe ; la décision est
-- persistée (plan, soldes Stripe lus, montant déjà reversé chez Stripe) puis figée ; un Stripe n'est jamais appelé à l'aveugle.

alter table public.driver_transfer_reversals
  add column driver_id uuid null references public.drivers(id),
  add column reason_code text null,
  add column order_id uuid null references public.orders(id),
  add column approved_at timestamptz null,
  add column rejection_reason text null,
  add column claim_token uuid null,
  add column lease_expires_at timestamptz null,
  add column attempt_count integer not null default 0 check (attempt_count >= 0),
  add column next_attempt_at timestamptz null,
  add column last_error_class text null,
  add column decided_at timestamptz null,
  add column planned_reverse_cents bigint null check (planned_reverse_cents >= 0),
  add column planned_receivable_cents bigint null check (planned_receivable_cents >= 0),
  add column funds_bucket text null check (funds_bucket in ('pending','available')),
  add column balance_available_before_cents bigint null,
  add column balance_pending_before_cents bigint null,
  add column stripe_amount_reversed_before_cents bigint null check (stripe_amount_reversed_before_cents >= 0),
  add column executed_at timestamptz null,
  add column reversed_cents bigint null check (reversed_cents >= 0),
  add column balance_available_after_cents bigint null,
  add column balance_pending_after_cents bigint null,
  add column failure_code text null;

-- Aucune ligne existante (R10 n'a jamais rien écrit) : le motif devient obligatoire.
alter table public.driver_transfer_reversals
  alter column reason_code set not null,
  alter column driver_id set not null,
  add constraint driver_transfer_reversals_reason_code_check check (
    (category = 'driver_fault' and reason_code in ('order_stolen','order_lost','order_damaged','fraud','other_validated_decision'))
    or (category = 'locadely_error' and reason_code in ('duplicate_transfer','wrong_recipient','wrong_amount','other_locadely_error'))
  ),
  add constraint driver_transfer_reversals_order_check check (reason_code not in ('order_stolen','order_lost','order_damaged') or order_id is not null),
  add constraint driver_transfer_reversals_claim_check check ((claim_token is null) = (lease_expires_at is null)),
  add constraint driver_transfer_reversals_plan_check check (
    (planned_reverse_cents is null) = (planned_receivable_cents is null)
    and (planned_reverse_cents is null or (planned_reverse_cents + planned_receivable_cents = amount_cents and decided_at is not null and funds_bucket is not null and stripe_amount_reversed_before_cents is not null))
  ),
  add constraint driver_transfer_reversals_executing_plan_check check (status <> 'succeeded' or (planned_reverse_cents is not null and reversed_cents = planned_reverse_cents and executed_at is not null and ((reversed_cents > 0) = (stripe_reversal_id is not null)))),
  add constraint driver_transfer_reversals_failed_check check (status <> 'failed' or failure_code is not null),
  add constraint driver_transfer_reversals_approved_at_check check (status not in ('approved','executing','succeeded') or approved_at is not null);

-- Le livreur est dérivé du statement du Transfer (jamais saisi) ; UNE seule reversal en exécution par livreur : deux reversals ne décident
-- jamais sur le même solde Stripe en même temps (pas de double comptage du recouvrable).
create function public.fill_driver_transfer_reversal_driver() returns trigger language plpgsql set search_path = '' as $$
begin
  select st.driver_id into new.driver_id from public.driver_transfers t join public.settlement_statements st on st.id = t.statement_id where t.id = new.driver_transfer_id;
  return new;
end;
$$;
revoke execute on function public.fill_driver_transfer_reversal_driver() from anon, authenticated, public;
create trigger driver_transfer_reversals_fill_driver before insert on public.driver_transfer_reversals for each row execute function public.fill_driver_transfer_reversal_driver();
create unique index driver_transfer_reversals_one_executing_per_driver_idx on public.driver_transfer_reversals(driver_id) where status = 'executing';

-- Une même décision ne produit qu'une seule reversal par Transfer : la demande est idempotente (jamais de doublon).
create unique index driver_transfer_reversals_decision_idx on public.driver_transfer_reversals(driver_transfer_id, decision_reference);
create index driver_transfer_reversals_due_idx on public.driver_transfer_reversals(next_attempt_at) where status in ('approved','executing');

-- Décision, motif et montant figés dès la demande ; le plan (décision d'exécution) est figé une fois posé ; les états finaux sont terminaux.
create function public.guard_driver_transfer_reversal_immutable() returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.driver_transfer_id, new.driver_id, new.category, new.reason_code, new.order_id, new.amount_cents, new.reason, new.decision_reference, new.requested_by, new.idempotency_key, new.livemode)
     is distinct from (old.driver_transfer_id, old.driver_id, old.category, old.reason_code, old.order_id, old.amount_cents, old.reason, old.decision_reference, old.requested_by, old.idempotency_key, old.livemode) then
    raise exception 'la décision d’une reversal (transfert, motif, montant, référence, demandeur) est immuable';
  end if;
  if old.approved_by is not null and new.approved_by is distinct from old.approved_by then raise exception 'l’approbateur d’une reversal est immuable'; end if;
  if old.status in ('succeeded','failed','rejected') and new.status is distinct from old.status then raise exception 'un état final de reversal est terminal'; end if;
  if old.planned_reverse_cents is not null and (new.planned_reverse_cents, new.planned_receivable_cents, new.funds_bucket, new.stripe_amount_reversed_before_cents, new.decided_at)
     is distinct from (old.planned_reverse_cents, old.planned_receivable_cents, old.funds_bucket, old.stripe_amount_reversed_before_cents, old.decided_at) then
    raise exception 'le plan d’exécution d’une reversal est figé une fois décidé';
  end if;
  if old.status in ('succeeded','failed','rejected') and old.status = new.status and (new.reversed_cents, new.stripe_reversal_id) is distinct from (old.reversed_cents, old.stripe_reversal_id) then
    raise exception 'le résultat d’une reversal terminée est immuable';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_driver_transfer_reversal_immutable() from anon, authenticated, public;
create trigger driver_transfer_reversals_immutable before update on public.driver_transfer_reversals for each row execute function public.guard_driver_transfer_reversal_immutable();

-- L'ordre visé doit faire partie du statement du Transfer (une reversal « commande volée » ne peut pas viser une autre commande).
create function public.guard_driver_transfer_reversal_order() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.order_id is not null and not exists (
    select 1 from public.driver_transfers t join public.settlement_lines l on l.statement_id = t.statement_id where t.id = new.driver_transfer_id and l.order_id = new.order_id
  ) then raise exception 'la commande visée doit appartenir au statement du transfert'; end if;
  return new;
end;
$$;
revoke execute on function public.guard_driver_transfer_reversal_order() from anon, authenticated, public;
create trigger driver_transfer_reversals_order_guard before insert on public.driver_transfer_reversals for each row execute function public.guard_driver_transfer_reversal_order();

-- Créance livreur : seulement pour une reversal RÉUSSIE, pour exactement le reliquat décidé, rattachée au livreur du statement ;
-- et toute reversal réussie avec un reliquat a sa créance (contrainte différée, même transaction).
create function public.guard_driver_receivable() returns trigger language plpgsql set search_path = '' as $$
declare r record; statement_driver uuid;
begin
  select rv.*, st.driver_id as statement_driver into r from public.driver_transfer_reversals rv join public.driver_transfers t on t.id = rv.driver_transfer_id join public.settlement_statements st on st.id = t.statement_id where rv.id = new.driver_transfer_reversal_id;
  if not found or r.status <> 'succeeded' then raise exception 'une créance livreur exige une reversal réussie'; end if;
  if r.planned_receivable_cents is distinct from new.amount_cents then raise exception 'la créance doit égaler le reliquat décidé de la reversal'; end if;
  if r.statement_driver <> new.driver_id then raise exception 'la créance doit être rattachée au livreur du statement'; end if;
  return new;
end;
$$;
revoke execute on function public.guard_driver_receivable() from anon, authenticated, public;
create trigger driver_receivables_guard before insert on public.driver_receivables for each row execute function public.guard_driver_receivable();

create function public.assert_reversal_receivable() returns trigger language plpgsql set search_path = '' as $$
declare receivable_total bigint;
begin
  if new.status = 'succeeded' then
    select coalesce(sum(amount_cents), 0) into receivable_total from public.driver_receivables where driver_transfer_reversal_id = new.id;
    if receivable_total <> new.planned_receivable_cents then raise exception 'la créance livreur doit égaler le reliquat non reversé décidé'; end if;
  end if;
  return null;
end;
$$;
revoke execute on function public.assert_reversal_receivable() from anon, authenticated, public;
create constraint trigger driver_transfer_reversals_receivable after insert or update on public.driver_transfer_reversals deferrable initially deferred for each row execute function public.assert_reversal_receivable();
